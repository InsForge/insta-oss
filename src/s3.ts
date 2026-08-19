// Minimal S3 client — pure node:crypto SigV4, no SDK. Only what the object routes need:
// ListObjectsV2, DeleteObject, DeleteObjects, presigned GET, and a POST-policy upload form.
// Path-style addressing (endpoint/bucket/key) — that is what Garage serves and what rclone uses.
import { createHash, createHmac } from 'node:crypto'

export type S3Creds = { accessKeyId: string; secretAccessKey: string; region: string; endpoint: string }

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
const hmac = (key: Buffer | string, s: string): Buffer => createHmac('sha256', key).update(s).digest()

// AWS URI-encodes every path segment/query value with an unreserved set of A-Za-z0-9-._~
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const encPath = (path: string): string => path.split('/').map(enc).join('/')

const amzDate = (d: Date): { long: string; short: string } => {
  const long = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { long, short: long.slice(0, 8) }
}

function signingKey(secret: string, dateShort: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateShort), region), 's3'), 'aws4_request')
}

type SignedRequest = { url: string; headers: Record<string, string> }

/** Sign a header-authenticated request (the daemon performs these itself). */
export function signRequest(creds: S3Creds, method: string, path: string, query: Record<string, string>, body: Buffer | null, extraHeaders: Record<string, string> = {}): SignedRequest {
  const { long, short } = amzDate(new Date())
  const host = new URL(creds.endpoint).host
  const payloadHash = sha256(body ?? '')
  const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': long, ...extraHeaders }
  const signedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort()
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('')
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&')
  const canonical = [method, encPath(path), canonicalQuery, canonicalHeaders, signedHeaderNames.join(';'), payloadHash].join('\n')
  const scope = `${short}/${creds.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', long, scope, sha256(canonical)].join('\n')
  const signature = hmac(signingKey(creds.secretAccessKey, short, creds.region), toSign).toString('hex')
  const sendHeaders = { ...headers }
  delete sendHeaders.host // fetch sets Host from the URL; sending it explicitly is refused
  return {
    url: `${creds.endpoint}${encPath(path)}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: {
      ...sendHeaders,
      authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`,
    },
  }
}

/** Presign a GET (query-string SigV4) — the URL is handed to a host-side client (CLI/browser). */
export function presignGet(creds: S3Creds, path: string, ttlSeconds: number, extraQuery: Record<string, string> = {}): { url: string; expiresAt: string } {
  const now = new Date()
  const { long, short } = amzDate(now)
  const host = new URL(creds.endpoint).host
  const scope = `${short}/${creds.region}/s3/aws4_request`
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': long,
    'X-Amz-Expires': String(ttlSeconds),
    'X-Amz-SignedHeaders': 'host',
    ...extraQuery,
  }
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&')
  const canonical = ['GET', encPath(path), canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', long, scope, sha256(canonical)].join('\n')
  const signature = hmac(signingKey(creds.secretAccessKey, short, creds.region), toSign).toString('hex')
  return {
    url: `${creds.endpoint}${encPath(path)}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  }
}

/** POST-policy upload form (the provider itself refuses an over-size or wrong-type body). */
export function presignPost(creds: S3Creds, bucket: string, key: string, contentType: string, size: number, ttlSeconds: number): { url: string; fields: Record<string, string>; expiresAt: string } {
  const now = new Date()
  const { long, short } = amzDate(now)
  const scope = `${short}/${creds.region}/s3/aws4_request`
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)
  const fields: Record<string, string> = {
    key,
    'Content-Type': contentType,
    'x-amz-algorithm': 'AWS4-HMAC-SHA256',
    'x-amz-credential': `${creds.accessKeyId}/${scope}`,
    'x-amz-date': long,
  }
  const policy = Buffer.from(JSON.stringify({
    expiration: expiresAt.toISOString(),
    conditions: [
      { bucket },
      { key },
      { 'Content-Type': contentType },
      ['content-length-range', size, size],
      { 'x-amz-algorithm': 'AWS4-HMAC-SHA256' },
      { 'x-amz-credential': fields['x-amz-credential'] },
      { 'x-amz-date': long },
    ],
  })).toString('base64')
  const signature = hmac(signingKey(creds.secretAccessKey, short, creds.region), policy).toString('hex')
  return {
    url: `${creds.endpoint}/${enc(bucket)}`,
    fields: { ...fields, policy, 'x-amz-signature': signature },
    expiresAt: expiresAt.toISOString(),
  }
}

// ---- response parsing (S3 XML is machine-generated; a scoped regex parse is enough) ----

const tag = (xml: string, name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]
const unescapeXml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

export type ObjectEntry = { key: string; size: number; lastModified: string; etag: string }

export function parseListObjects(xml: string): { objects: ObjectEntry[]; nextCursor?: string } {
  const objects: ObjectEntry[] = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const c = m[1]
    objects.push({
      key: unescapeXml(tag(c, 'Key') ?? ''),
      size: Number(tag(c, 'Size') ?? 0),
      lastModified: tag(c, 'LastModified') ?? '',
      etag: unescapeXml(tag(c, 'ETag') ?? ''),
    })
  }
  const next = tag(xml, 'NextContinuationToken')
  return { objects, ...(next ? { nextCursor: unescapeXml(next) } : {}) }
}

export function parseDeleteResult(xml: string): { deleted: number; failed: Array<{ key: string; message: string }> } {
  const deleted = [...xml.matchAll(/<Deleted>[\s\S]*?<\/Deleted>/g)].length
  const failed = [...xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g)].map((m) => ({
    key: unescapeXml(tag(m[1], 'Key') ?? ''),
    message: unescapeXml(tag(m[1], 'Message') ?? tag(m[1], 'Code') ?? 'delete failed'),
  }))
  return { deleted, failed }
}

export const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
