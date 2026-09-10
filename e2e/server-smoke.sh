#!/bin/sh
# End-to-end smoke test for server mode: install.sh on a throwaway VM, then the whole
# public surface over https with a real admin and a real insta_ token.
#
#   sudo -E sh e2e/server-smoke.sh
#
# It installs a stack on THIS machine and leaves it running. Never point it at a box you
# care about.
#
# Inputs:
#   E2E_RUN_ID          suffix that keeps runs apart (server)
#   INSTA_OSS_IMAGE     daemon image to install (built from the checkout in CI)
#   INSTA_OSS_DOMAIN    default 127-0-0-1.sslip.io
#   INSTA_OSS_TLS       internal (the default here; acme needs a public name)
#   E2E_UNINSTALL       1 to compose down and unmount at the end
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
. "$HERE/lib.sh"

RUN=${E2E_RUN_ID:-server}
DOMAIN=${INSTA_OSS_DOMAIN:-127-0-0-1.sslip.io}
TLS=${INSTA_OSS_TLS:-internal}
IMAGE=${E2E_IMAGE:-traefik/whoami:v1.10}
PROJECT=e2e-server-$RUN
API=https://api.$DOMAIN
CA=/var/lib/instacloud/edge/ca.pem
# Outside the checkout, like the CLI scratch directory below: a smoke run has to leave the
# repository clean, and this file is written before /var/lib/instacloud exists.
INSTALL_LOG=${E2E_INSTALL_LOG:-${RUNNER_TEMP:-/tmp}/insta-oss-server-$RUN.log}
export INSTA_OSS_DOMAIN="$DOMAIN"
export INSTA_OSS_TLS="$TLS"
export API

INSTA_OSS_IDLE_COMPUTE_SEC=${INSTA_OSS_IDLE_COMPUTE_SEC:-15}
INSTA_OSS_IDLE_DB_SEC=${INSTA_OSS_IDLE_DB_SEC:-20}
INSTA_OSS_SWEEP_SEC=${INSTA_OSS_SWEEP_SEC:-2}
INSTA_OSS_CREATE_GRACE_SEC=${INSTA_OSS_CREATE_GRACE_SEC:-0}
INSTA_OSS_RAM_FLOOR_PCT=${INSTA_OSS_RAM_FLOOR_PCT:-0}
export INSTA_OSS_IDLE_COMPUTE_SEC INSTA_OSS_IDLE_DB_SEC INSTA_OSS_SWEEP_SEC
export INSTA_OSS_CREATE_GRACE_SEC INSTA_OSS_RAM_FLOOR_PCT

cleanup() {
  if command -v insta >/dev/null 2>&1; then
    allow_delete >/dev/null 2>&1 || true
  fi
  cd /
  [ -z "${WORK:-}" ] || rm -rf "$WORK"
  if [ "${E2E_UNINSTALL:-0}" = "1" ]; then
    ( cd /etc/instacloud && docker compose --env-file instad.env down -v ) || true
    umount /var/lib/instacloud 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

STEP "0. preflight"
[ "$(id -u)" = "0" ] || FAIL "run this as root (sudo -E sh e2e/server-smoke.sh)"
docker info >/dev/null 2>&1 || FAIL "docker is not running"
command -v psql >/dev/null 2>&1 || FAIL "psql is required (postgresql-client)"
command -v xfs_info >/dev/null 2>&1 || FAIL "xfsprogs is required"
for port in 80 443 5432; do
  if ss -ltn "sport = :$port" | grep -q LISTEN; then
    FAIL "port $port is already bound"
  fi
done
for host in api console s3; do
  ensure_host "$host.$DOMAIN"
done
OK "preflight"

STEP "1. install"
( cd "$ROOT" && sh install.sh -y ) 2>&1 | tee "$INSTALL_LOG"
grep -q "https://console.$DOMAIN/setup" "$INSTALL_LOG" || FAIL "no setup url in the install log"
grep -q 'Re-run this script to upgrade' "$INSTALL_LOG" || FAIL "no upgrade line in the install log"
for c in io-instad io-edge io-garage; do
  [ "$(cstate $c)" = "running" ] || FAIL "$c is not running, state $(cstate $c)"
done
OK "the three stack containers are up"
# Every CLI call from here on runs from a scratch directory, never from the checkout: `insta
# project create` links the directory it runs in, writing .insta/ and appending to .gitignore, and
# a smoke run has to leave the repository clean. Step 9's template path is absolute for the same
# reason. install.sh itself keeps running in a subshell that cds to the checkout.
TPL=$ROOT/e2e/fixtures/tpl-hello
WORK=${RUNNER_TEMP:-/tmp}/insta-oss-server-$RUN-work
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"
FSTYPE=$(findmnt -no FSTYPE /var/lib/instacloud)
if [ "$FSTYPE" = "xfs" ] && xfs_info /var/lib/instacloud | grep -q 'reflink=1'; then
  # Both ends inside the data directory: a reflink cannot cross a filesystem, and the install log
  # is not on this one.
  head -c 4096 /dev/urandom > /var/lib/instacloud/.e2e-reflink-src
  cp --reflink=always /var/lib/instacloud/.e2e-reflink-src /var/lib/instacloud/.e2e-reflink-probe \
    || FAIL "reflink copy failed on a reflink filesystem"
  rm -f /var/lib/instacloud/.e2e-reflink-src /var/lib/instacloud/.e2e-reflink-probe
  REFLINK=1
  OK "data dir is xfs with reflink=1"
else
  REFLINK=0
  SKIP "data dir is $FSTYPE without reflinks, fork timing will be soft"
fi
if [ -f "$CA" ]; then
  OK "internal CA at $CA"
else
  CA=
  INSECURE=1
  export INSECURE
  printf 'WARNING: no CA file, falling back to INSECURE=1\n'
fi

STEP "2. health and the auth wall"
wait_for 120 curl_healthz || FAIL "api healthz never answered"
CODE=$(NOAUTH=1 api_code GET /me)
[ "$CODE" = "401" ] || FAIL "GET /me without a token answered $CODE, expected 401"
CONSOLE=$(_curl "https://console.$DOMAIN/setup")
printf '%s\n' "$CONSOLE" | grep -q '__INSTA_OSS__' || FAIL "the setup page is not the dashboard"
OK "healthz public, everything else 401, setup page served"

STEP "3. admin and token"
PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '\n=' | cut -c1-24)
EMAIL=admin@example.test
SIGNUP_BODY=$(printf '{"name":"admin","email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")
CODE=$(_curl -o /tmp/signup.json -w '%{http_code}' -c /tmp/jar.txt \
  -X POST "$API/api/auth/sign-up/email" -H 'content-type: application/json' -d "$SIGNUP_BODY")
[ "$CODE" = "200" ] || FAIL "sign-up answered $CODE, expected 200"
CODE=$(_curl -o /dev/null -w '%{http_code}' -X POST "$API/api/auth/sign-up/email" \
  -H 'content-type: application/json' -d "$SIGNUP_BODY")
[ "$CODE" = "422" ] || FAIL "a second sign-up answered $CODE, expected 422"
OK "one admin, and only one"
TOKEN_JSON=$(_curl -b /tmp/jar.txt -X POST "$API/tokens" \
  -H 'content-type: application/json' -d '{"name":"ci"}')
TOKEN=$(printf '%s\n' "$TOKEN_JSON" | jsel 'd.token')
export TOKEN
case $TOKEN in
  insta_*) OK "minted an insta_ token" ;;
  *) FAIL "POST /tokens did not return an insta_ token: $TOKEN_JSON" ;;
esac
COUNT=$(api GET /tokens | jsel 'd.tokens.length')
[ "$COUNT" = "1" ] || FAIL "GET /tokens lists $COUNT records, expected 1"
OK "the token is listed"

STEP "4. cli login"
command -v insta >/dev/null 2>&1 || npm i -g insta@latest
if [ -n "$CA" ]; then
  NODE_EXTRA_CA_CERTS=$CA
  export NODE_EXTRA_CA_CERTS
  PGSSLROOTCERT=$CA
  export PGSSLROOTCERT
  # Each client reads its OWN variable. The S3 step used to be told nothing, so with
  # --tls internal it was the one call that could not verify the edge certificate every
  # other step had just verified: "SSL validation failed ... unable to get local issuer
  # certificate". botocore trusts AWS_CA_BUNDLE and nothing else.
  AWS_CA_BUNDLE=$CA
  export AWS_CA_BUNDLE
fi
insta login --api-key "$TOKEN" --api-url "$API" | grep -q "$EMAIL" \
  || FAIL "insta login did not print the admin email"
insta status | grep -q "$EMAIL" || FAIL "insta status does not show the admin email"
if insta login --api-key insta_bogus --api-url "$API" 2>&1 | grep -q 'reject'; then
  OK "a bad key is rejected before it is saved"
else
  FAIL "a bogus key was not rejected"
fi
insta login --api-key "$TOKEN" --api-url "$API" >/dev/null
OK "cli logged in"

STEP "5. project, services, credentials, deploy"
insta project create "$PROJECT" >/dev/null || FAIL "project create failed"
SLUG=$(slug "$PROJECT")
REF=$SLUG-main
insta services list | grep -q 'postgres/' && FAIL "a new project must start with no postgres"
insta services add postgres db >/dev/null || FAIL "services add postgres failed"
insta services add storage store >/dev/null || FAIL "services add storage failed"
insta services add compute web >/dev/null || FAIL "services add compute failed"
DBURL=$(insta db url)
DBHOST=$(url_host "$DBURL")
case $DBHOST in
  pg-db-*.$DOMAIN) OK "database host $DBHOST" ;;
  *) FAIL "unexpected database host $DBHOST" ;;
esac
case $DBURL in
  *:5432/*sslmode=require*) OK "public dsn on 5432 with sslmode=require" ;;
  *) FAIL "expected port 5432 and sslmode=require in $DBURL" ;;
esac
ensure_host "$DBHOST"
psql_roundtrip "$DBURL" || FAIL "postgres round trip over the public sni lane failed"
OK "postgres round trip over 5432"
SECRETS=$(insta secrets --print)
printf '%s\n' "$SECRETS" | grep -q "AWS_ENDPOINT_URL_S3=\"https://s3.$DOMAIN\"" \
  || FAIL "the s3 endpoint is not https://s3.$DOMAIN"
s3_roundtrip "$SECRETS" || FAIL "s3 round trip failed"
OK "s3 round trip at https://s3.$DOMAIN"
DEPLOY=$(insta deploy --image "$IMAGE" --port 80 --group web)
URL=$(printf '%s\n' "$DEPLOY" | tr ' ' '\n' | grep -o "https://web-[a-z0-9-]*\.$DOMAIN" | head -1)
[ -n "$URL" ] || FAIL "no https app url in the deploy output"
ensure_host "$(url_host "$URL")"
wait_for 90 curl_ok "$URL/" || FAIL "$URL never answered"
OK "app answers at $URL"
insta services add postgres analytics >/dev/null || FAIL "a second postgres must be allowed"
DBURL2=$(insta db url --group analytics)
[ "$DBURL2" != "$DBURL" ] || FAIL "the two postgres services share a dsn"
if insta services add postgres db >/dev/null 2>&1; then
  FAIL "a duplicate service name must be refused"
fi
OK "several postgres per branch, duplicates refused"

STEP "6. branch fork, with a hard reflink assertion"
psql "$DBURL" -v ON_ERROR_STOP=1 -qtAc \
  "create table qa_branch_probe(v text); insert into qa_branch_probe values ('from-main')" \
  >/dev/null || FAIL "could not seed the probe table"
psql "$DBURL" -v ON_ERROR_STOP=1 -qtAc \
  "create table qa_bulk as select generate_series(1,700000) i, repeat('x',64) p" \
  >/dev/null || FAIL "could not seed 50 MB of bulk data"
measure insta branch create feat --from main >/dev/null || FAIL "branch create failed"
FEAT_IDS=$(insta services list --branch feat --json | jsel '(d.services||d).map(function(s){return s.id}).join(",")')
case $FEAT_IDS in
  *:pg-db*) OK "feat service ids are branch qualified" ;;
  *) FAIL "expected branch-qualified ids on feat, got $FEAT_IDS" ;;
esac
FEATURL=$(insta db url --branch feat --group db)
[ "$FEATURL" != "$DBURL" ] || FAIL "feat and main share a dsn"
FEATHOST=$(url_host "$FEATURL")
ensure_host "$FEATHOST"
FEATVAL=$(psql "$FEATURL" -v ON_ERROR_STOP=1 -qtAc 'select v from qa_branch_probe limit 1')
[ "$FEATVAL" = "from-main" ] || FAIL "feat did not inherit the seeded row"
psql "$FEATURL" -v ON_ERROR_STOP=1 -qtAc \
  "insert into qa_branch_probe values ('only-on-feat')" >/dev/null
MAINCOUNT=$(psql "$DBURL" -v ON_ERROR_STOP=1 -qtAc 'select count(*) from qa_branch_probe')
[ "$MAINCOUNT" = "1" ] || FAIL "a write on feat reached main"
OK "fork carries data and stays isolated"
FEAT_APP=$(printf '%s\n' "$URL" | sed -e 's/-main\./-feat./')
ensure_host "$(url_host "$FEAT_APP")"
wait_for 90 curl_ok "$FEAT_APP/" || FAIL "$FEAT_APP never answered after hold and wake"
OK "the feat app answers after hold and wake"
METHOD=$(insta events --json | jsel '(d.events||d).filter(function(e){return e.kind==="branch.created"}).map(function(e){return (e.payload&&e.payload.db&&e.payload.db.method)||""}).filter(Boolean)[0]')
if [ "$REFLINK" = "1" ]; then
  [ "$METHOD" = "reflink" ] || FAIL "expected a reflink fork, branch.created says '$METHOD'"
  [ "${MEASURED_MS:-999999}" -lt 5000 ] \
    || FAIL "a reflink fork of 50 MB took ${MEASURED_MS}ms, expected under 5000"
  OK "reflink fork in ${MEASURED_MS}ms"
else
  SKIP "fork method '$METHOD' in ${MEASURED_MS}ms (no reflink filesystem)"
fi

STEP "7. sleep and wake"
WEBC=$(svc_container "$REF" web)
PGC=$(pg_container "$REF" db)
wait_for 90 sh -c "[ \"\$(docker inspect -f '{{.State.Status}}' $WEBC)\" = exited ]" \
  || FAIL "$WEBC never slept, state is $(cstate "$WEBC")"
wait_for 90 sh -c "[ \"\$(docker inspect -f '{{.State.Status}}' $PGC)\" = exited ]" \
  || FAIL "$PGC never slept, state is $(cstate "$PGC")"
[ "$(cstate "$WEBC")" != "paused" ] || FAIL "sleep must stop, never pause"
insta compute status web | grep -q 'desired=running' || FAIL "desired state should stay running"
OK "compute and postgres slept"
curl_ok "$URL/" || FAIL "traffic did not wake the app"
[ "$(cstate "$WEBC")" = "running" ] || FAIL "the app is not running after a wake"
PGCONNECT_TIMEOUT=60 psql "$DBURL" -qtAc 'select 1' | grep -q '1' \
  || FAIL "a connection did not wake postgres"
OK "traffic and a connection woke both"
insta compute stop web >/dev/null
wait_for 30 sh -c "[ \"\$(docker inspect -f '{{.State.Status}}' $WEBC)\" = exited ]" \
  || FAIL "compute stop did not stop the container"
curl_ok "$URL/" 2>/dev/null && FAIL "a stopped service answered a request"
sleep 10
[ "$(cstate "$WEBC")" = "exited" ] || FAIL "traffic woke a stopped service"
insta compute start web >/dev/null
wait_for 60 curl_ok "$URL/" || FAIL "compute start did not bring the app back"
OK "stop is durable, start clears it"
insta compute always-on on web >/dev/null || FAIL "always-on on failed"
sleep $(( INSTA_OSS_IDLE_COMPUTE_SEC * 2 + INSTA_OSS_SWEEP_SEC + 5 ))
[ "$(cstate "$WEBC")" = "running" ] || FAIL "an always-on service slept"
insta compute always-on off web >/dev/null || FAIL "always-on off failed"
OK "always-on keeps a service up"
insta events --json | grep -q 'service.sleep' || FAIL "no service.sleep event"
insta events --json | grep -q 'service.wake' || FAIL "no service.wake event"
OK "sleep and wake events recorded"

STEP "8. custom domain"
SETOUT=$(insta compute set-domain e2e.example.test --group web)
printf '%s\n' "$SETOUT" | grep -q '501' && FAIL "set-domain still answers 501"
printf '%s\n' "$SETOUT" | grep -qi 'cname' || FAIL "set-domain printed no CNAME record"
printf '%s\n' "$SETOUT" | grep -q "api.$DOMAIN" || FAIL "the CNAME target is not api.$DOMAIN"
CHECK=$(insta compute check-domain e2e.example.test)
printf '%s\n' "$CHECK" | grep -qi 'pending' || FAIL "check-domain should report the record pending"
printf '%s\n' "$CHECK" | grep -q 'UNCONFIRMED' && FAIL "check-domain must not print an ssl line"
insta compute remove-domain e2e.example.test >/dev/null || FAIL "remove-domain failed"
OK "custom domain add, check and remove"

STEP "9. templates over https"
insta template list | grep -q 'n8n' || FAIL "n8n is missing from the catalog"
CODE=$(NOAUTH=1 api_code GET /templates)
[ "$CODE" = "200" ] || FAIL "GET /templates without a bearer answered $CODE, expected 200"
DEPLOY_JSON=$(insta template deploy "$TPL" --branch main --yes --json)
DSTATUS=$(printf '%s\n' "$DEPLOY_JSON" | jsel 'd.status')
[ "$DSTATUS" = "succeeded" ] || FAIL "template deploy status is '$DSTATUS'"
HELLO_URL=$(printf '%s\n' "$DEPLOY_JSON" | jsel 'd.services[0].url')
ensure_host "$(url_host "$HELLO_URL")"
wait_for 90 curl_ok "$HELLO_URL/" || FAIL "$HELLO_URL never answered"
OK "template deployed and answers over https"

STEP "10. upgrade in place"
( cd "$ROOT" && sh install.sh -y ) 2>&1 | tee -a "$INSTALL_LOG"
wait_for 120 curl_healthz || FAIL "the daemon did not come back after the upgrade"
insta project list | grep -q "$PROJECT" || FAIL "the project is gone after the upgrade"
wait_for 90 curl_ok "$URL/" || FAIL "the app did not answer after the upgrade"
docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$PGC" \
  | grep -q '/var/lib/instacloud/pg/' || FAIL "postgres is not on a data-dir bind mount"
OK "upgrade is idempotent and data survived"

STEP "11. teardown"
allow_delete || FAIL "could not set project.delete to allow"
insta project delete --yes >/dev/null 2>&1 || insta project delete >/dev/null \
  || FAIL "project delete failed"
LEFT=$(docker ps -aq --filter "name=io-$SLUG-")
[ -z "$LEFT" ] || FAIL "containers survived the delete: $LEFT"
[ ! -d "/var/lib/instacloud/pg/$SLUG-main" ] || FAIL "the data directory survived the delete"
OK "teardown removed containers and data directories"

printf '\nSERVER SMOKE PASSED\n'
