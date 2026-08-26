// The credential contract, replayed over the real registry.
//
// Two things had no coverage and both had already broken once. The resolution order drifted, so
// `npm run deploy` stopped working for every template declaring a `default:` while the platform
// deployed them fine -- no manifest declares one today, but the executor and the platform still
// have to agree about it. And a rename that touches the manifest but not the entrypoint (or two of
// three sibling templates) produces a container that starts and can never be signed into, with no
// error anywhere: ttyd answers 401, and the health check reads 401 as alive.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { valueSource, shellVarsRead } from './variables-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NON_TEMPLATE = new Set(['scripts', 'node_modules']);
const templates = readdirSync(root)
  .filter((d) => !NON_TEMPLATE.has(d) && statSync(join(root, d)).isDirectory())
  .map((dir) => ({ dir, manifest: yaml.load(readFileSync(join(root, dir, 'insta.template.yaml'), 'utf8')) }));

// Set by the Dockerfile, not by the manifest, so an entrypoint may read them freely.
const IMAGE_PROVIDED = new Set(['HOME', 'PATH', 'PWD', 'SHELL', 'TERM', 'USER', 'LANG']);

describe('valueSource: the platform resolution order', () => {
  it('prefers a supplied value over both generator and default', () => {
    expect(valueSource({ generate: 'secret:16', default: 'd' }, 'mine')).toBe('provided');
  });

  it('treats an empty string as absent', () => {
    // A blank form field must fall through rather than write "" into the environment.
    expect(valueSource({ default: 'd' }, '')).toBe('default');
  });

  it('prefers a generator over a default', () => {
    // The reason a spec should never carry both: the default is then dead text no one can reach.
    expect(valueSource({ generate: 'secret:16', default: 'd' }, undefined)).toBe('generate');
  });

  it('falls back to the default', () => {
    expect(valueSource({ default: 'admin' }, undefined)).toBe('default');
  });

  it('reports nothing when a variable declares neither', () => {
    expect(valueSource({ description: 'an API key' }, undefined)).toBeNull();
  });
});

/** Required variables a bare `npm run deploy -- <code>` would still have to be given. */
function demands(manifest) {
  const out = [];
  for (const svc of Object.values(manifest.services ?? {})) {
    for (const [k, spec] of Object.entries(svc.env?.required ?? {})) {
      if (valueSource(spec, undefined) === null) out.push(k);
    }
  }
  return out.sort();
}

describe('the terminal templates ship no credential of their own', () => {
  // What this locks down is a security property, not a convenience one. Each of these publishes a
  // root shell (or an agent that runs one) over HTTP basic auth, so a `default:` here would be one
  // password shared by every deployment in the world, and a `generate:` would be a password the
  // operator never sees. The manifests declare both variables required with neither, which is what
  // makes the console render two empty fields it will not let you submit blank.
  it.each(['claude-code', 'codex', 'dsh', 'pi'])('%s makes the operator supply both', (dir) => {
    const svc = Object.values(templates.find((t) => t.dir === dir).manifest.services)[0];
    for (const k of ['ADMIN_USERNAME', 'ADMIN_PASSWORD']) {
      // null = nothing to fall back on. The platform answers MissingTemplateVariables; the console
      // blocks submit. Re-adding a default or a generator flips this and fails here.
      expect(valueSource(svc.env.required[k], undefined), `${k} must have no fallback`).toBeNull();
      expect(valueSource(svc.env.required[k], 'typed'), `${k} must accept a value`).toBe('provided');
    }
  });

  it.each(['claude-code', 'codex', 'dsh', 'pi'])('%s demands those two and nothing else', (dir) => {
    // Scoped both ways on purpose: a fourth required variable would be a new thing to type on the
    // deploy form, and dropping one would mean a credential came back from somewhere.
    expect(demands(templates.find((t) => t.dir === dir).manifest))
      .toEqual(['ADMIN_PASSWORD', 'ADMIN_USERNAME']);
  });

  it('still resolves a template whose secret is generated', () => {
    // hermes keeps `generate: secret:16` on ACCESS_PASSWORD, which is fine there and is what keeps
    // the generate branch of valueSource exercised against a real manifest rather than a literal.
    const svc = Object.values(templates.find((t) => t.dir === 'hermes').manifest.services)[0];
    expect(valueSource(svc.env.required.ACCESS_PASSWORD, undefined)).toBe('generate');
  });
});

describe('every variable an entrypoint reads is declared by its manifest', () => {
  const withEntrypoint = templates.filter((t) => existsSync(join(root, t.dir, 'entrypoint.sh')));

  it('covers the templates that ship one', () => {
    // Guards the guard: if entrypoints move or get renamed, the cases below would silently
    // become an empty suite that passes forever. hermes ships one too, still on the pre-0.6.0
    // ACCESS_PASSWORD, which is exactly the divergence this check should keep honest.
    expect(withEntrypoint.map((t) => t.dir).sort()).toEqual(['9router', 'claude-code', 'codex', 'dsh', 'hermes', 'openclaw', 'pi']);
  });

  it.each(withEntrypoint)('$dir', ({ dir, manifest }) => {
    const declared = new Set();
    for (const svc of Object.values(manifest.services ?? {})) {
      for (const group of ['fixed', 'generated', 'platform', 'required', 'optional']) {
        for (const k of Object.keys(svc.env?.[group] ?? {})) declared.add(k);
      }
    }
    const read = shellVarsRead(readFileSync(join(root, dir, 'entrypoint.sh'), 'utf8'));
    const undeclared = read.filter((n) => !declared.has(n) && !IMAGE_PROVIDED.has(n));
    expect(undeclared).toEqual([]);
  });

  it('actually sees the credential variables, not an empty read set', () => {
    // Without this the case above passes just as happily on a script that reads nothing at all.
    const read = shellVarsRead(readFileSync(join(root, 'pi/entrypoint.sh'), 'utf8'));
    expect(read).toEqual(expect.arrayContaining(['ADMIN_USERNAME', 'ADMIN_PASSWORD']));
  });
});

describe('shellVarsRead', () => {
  it('ignores names the script assigns itself', () => {
    expect(shellVarsRead('CRED="${ADMIN_USERNAME:-admin}"\necho "$CRED"')).toEqual(['ADMIN_USERNAME']);
  });

  it('reads every parameter-expansion form', () => {
    const found = shellVarsRead('echo "${A} ${B:-x} ${C:?y} $D"');
    expect(found).toEqual(['A', 'B', 'C', 'D']);
  });
});
