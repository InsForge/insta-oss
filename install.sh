#!/usr/bin/env sh
# install.sh: install or upgrade InstaCloud open source on one Linux box (root).
#
#   curl -fsSL https://get.instacloud.com | sh
#   curl -fsSL https://raw.githubusercontent.com/InsForge/insta-oss/main/install.sh | sh
#
# What it does: installs Docker when missing; gives Docker an address pool large enough for
# hundreds of branch networks; mounts an XFS reflink volume at /var/lib/instacloud when the root
# filesystem has no reflinks (a sparse loop image); picks <ip-dashes>.sslip.io as the domain until
# you own one; writes /etc/instacloud/{instad.env,compose.yml,Caddyfile} and the Garage config;
# opens the firewall for the edge and for containers reaching their own databases; brings the stack
# up (io-instad, io-edge, io-garage); waits on /healthz; prints the setup URL.
# Re-running the script is the upgrade; a re-run with --version <tag> is the rollback.
#
# Flags                              Env equivalent                Default
#   --domain <name>                  INSTA_OSS_DOMAIN               <public-ip-with-dashes>.sslip.io
#   --email <addr>                   INSTA_OSS_ACME_EMAIL           (none) ACME contact
#   --version <vX.Y.Z>               INSTA_OSS_VERSION              newest GitHub release
#   --tls acme|internal              INSTA_OSS_TLS                  acme (internal = Caddy's own CA)
#   --data-img-gib <n>               INSTA_OSS_DATA_IMG_GIB         free space minus 5 GiB
#   --data-dir <path>                INSTA_OSS_DATA_DIR             /var/lib/instacloud (the flag is
#                                    required to CHANGE the data dir of an existing install)
#   --print-env | --print-compose | --print-caddyfile | --print-daemon-json | --print-firewall
#                                    render one file to stdout and exit: no root, no side effects
#   -y                               accepted; the script never prompts
# Every other INSTA_OSS_* variable present in the environment is written into instad.env as is.
# Precedence for every value: flag, then environment, then the existing instad.env, then default.
# Requirements: root, Linux, x86_64 or aarch64, 2 vCPU, 2 GiB RAM, 15 GiB free, ports 80/443/5432.
set -eu

# ---- constants ----
CFG=/etc/instacloud
ENV_FILE=$CFG/instad.env
DATA_DEFAULT=/var/lib/instacloud
IMAGE_DEFAULT=ghcr.io/insforge/instacloud
REPO=InsForge/insta-oss
DAEMON_JSON=/etc/docker/daemon.json
POOL_BASE_DEFAULT=10.100.0.0/14
POOL_JSON='{"default-address-pools":[{"base":"10.100.0.0/14","size":24}]}'

# ---- helpers ----
log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# systemd is often INSTALLED without running the box (containers, sysvinit, OpenRC): systemctl is
# then on PATH but every call fails with "System has not been booted with systemd as init system".
# /run/systemd/system exists only while systemd is PID 1.
systemd_running() { have systemctl && [ -d /run/systemd/system ]; }
randhex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
valid_ip() { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }
private_ip() {
  case $1 in
    10.*|127.*|169.254.*|192.168.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
  esac
  return 1
}
# existing KEY: the value the current instad.env holds ('' when absent or unreadable)
existing() {
  [ -r "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1
}
# envval KEY: the environment's value ('' when unset)
envval() { eval "printf '%s' \"\${$1-}\""; }
# resolve KEY FLAG_VALUE DEFAULT: flag, then environment, then the existing instad.env, then default
resolve() {
  if [ -n "$2" ]; then printf '%s' "$2"; return; fi
  _v=$(envval "$1")
  if [ -n "$_v" ]; then printf '%s' "$_v"; return; fi
  _v=$(existing "$1")
  if [ -n "$_v" ]; then printf '%s' "$_v"; return; fi
  printf '%s' "$3"
}
# The header comment is the usage text; under `curl ... | sh` there is no file to read, so point at it.
usage() {
  if [ -r "$0" ]; then sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  else log 'usage: see the header comment of install.sh (https://github.com/InsForge/insta-oss/blob/main/install.sh)'
  fi
}

# ---- flags ----
PRINT=''; F_DOMAIN=''; F_EMAIL=''; F_VERSION=''; F_TLS=''; F_IMG_GIB=''; F_DATA_DIR=''
need() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }
while [ $# -gt 0 ]; do
  case $1 in
    --domain) need "$@"; F_DOMAIN=$2; shift 2 ;;
    --domain=*) F_DOMAIN=${1#*=}; shift ;;
    --email) need "$@"; F_EMAIL=$2; shift 2 ;;
    --email=*) F_EMAIL=${1#*=}; shift ;;
    --version) need "$@"; F_VERSION=$2; shift 2 ;;
    --version=*) F_VERSION=${1#*=}; shift ;;
    --tls) need "$@"; F_TLS=$2; shift 2 ;;
    --tls=*) F_TLS=${1#*=}; shift ;;
    --data-img-gib) need "$@"; F_IMG_GIB=$2; shift 2 ;;
    --data-img-gib=*) F_IMG_GIB=${1#*=}; shift ;;
    --data-dir) need "$@"; F_DATA_DIR=$2; shift 2 ;;
    --data-dir=*) F_DATA_DIR=${1#*=}; shift ;;
    --print-env|--print-compose|--print-caddyfile|--print-daemon-json|--print-firewall) PRINT=${1#--print-}; shift ;;
    -y|--yes) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag $1 (run with --help)" ;;
  esac
done

# ---- 1. preconditions (before anything is resolved: resolving needs curl and ip) ----
pkg_install() {
  if have apt-get; then apt-get update -qq >/dev/null 2>&1 || true; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif have dnf; then dnf install -y -q "$@" >/dev/null
  elif have yum; then yum install -y -q "$@" >/dev/null
  elif have apk; then apk add --quiet --no-cache "$@" >/dev/null
  elif have zypper; then zypper --non-interactive --quiet install "$@" >/dev/null
  else return 1
  fi
}
# A stock Ubuntu or Debian cloud image ships neither curl nor iproute2, and this script needs both
# before it can resolve a single value: curl reads the newest release tag and the public address,
# `ip` is the offline fallback for that address, `ss` finds whoever holds 80, 443 or 5432. Install
# them here, not after the resolve block, or a box without them dies on a detection failure whose
# real cause was the missing tool. The print modes resolve nothing that needs either, so they skip
# this whole section and stay root-free.
preflight() {
  [ "$(id -u)" -eq 0 ] || die "run as root: curl -fsSL https://get.instacloud.com | sudo sh"
  [ "$(uname -s)" = Linux ] || die "Linux only (a laptop runs the daemon with npm run dev, no installer)"
  case $(uname -m) in x86_64|aarch64) ;; *) die "unsupported architecture $(uname -m) (x86_64 or aarch64)" ;; esac
  have curl || pkg_install curl || die "curl is required and no supported package manager was found"
  { have ip && have ss; } || pkg_install iproute2 >/dev/null 2>&1 || true
}
[ -n "$PRINT" ] || preflight

# ---- resolve every value (shared by the print modes and the real run) ----
UPGRADE=0
[ -f "$ENV_FILE" ] && UPGRADE=1

DATA=$(resolve INSTA_OSS_DATA_DIR "$F_DATA_DIR" "$DATA_DEFAULT")
case $DATA in /?*) ;; *) die "INSTA_OSS_DATA_DIR must be an absolute path (got '$DATA')" ;; esac
DATA=${DATA%/}
IMG=$DATA.img

# INSTA_OSS_IMAGE may carry a tag (INSTA_OSS_IMAGE=ghcr.io/insforge/instacloud:ci); the tag is the version.
IMAGE=$(resolve INSTA_OSS_IMAGE '' "$IMAGE_DEFAULT")
IMAGE_TAG=''
case ${IMAGE##*/} in *:*) IMAGE_TAG=${IMAGE##*:}; IMAGE=${IMAGE%:*} ;; esac

latest_release() {
  curl -fsSL --max-time 10 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1
}
# version: flag, env, the image tag, the newest GitHub release (upgrade), the existing value, 'latest'
VERSION=$F_VERSION
[ -n "$VERSION" ] || VERSION=$(envval INSTA_OSS_VERSION)
[ -n "$VERSION" ] || VERSION=$IMAGE_TAG
if [ -z "$VERSION" ] && [ -z "$PRINT" ]; then VERSION=$(latest_release || true); fi
[ -n "$VERSION" ] || VERSION=$(existing INSTA_OSS_VERSION)
[ -n "$VERSION" ] || VERSION=latest
VERSION=${VERSION#v}

TLS=$(resolve INSTA_OSS_TLS "$F_TLS" acme)
case $TLS in acme|internal) ;; *) die "--tls must be acme or internal (got '$TLS')" ;; esac
EMAIL=$(resolve INSTA_OSS_ACME_EMAIL "$F_EMAIL" '')
PORT=$(resolve INSTA_OSS_PORT '' 8080)
INTERNAL_PORT=$(resolve INSTA_OSS_INTERNAL_PORT '' 8081)
# The database lanes the daemon binds on the host; the port check and instad.env share these.
LANE_PG=$(resolve INSTA_OSS_LANE_PG_PORT '' 5432)
LANE_REDIS=$(resolve INSTA_OSS_LANE_REDIS_PORT '' 6379)
LANE_MONGO=$(resolve INSTA_OSS_LANE_MONGO_PORT '' 27017)

# route_src: the address this box uses to reach the internet (its own, even behind NAT)
route_src() {
  have ip || return 0
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}'
}
# ip_is_local ADDR: true when ADDR is configured on an interface of this box
ip_is_local() {
  have ip || return 1
  ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -Fxq "$1"
}
detect_ip() {
  _ip=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null) || _ip=''
  if ! valid_ip "$_ip"; then _ip=$(curl -4 -fsS --max-time 5 https://ifconfig.me/ip 2>/dev/null) || _ip=''; fi
  if ! valid_ip "$_ip"; then _ip=$(route_src) || _ip=''; fi
  if valid_ip "$_ip"; then printf '%s' "$_ip"; fi
}
PUBLIC_IP=$(resolve INSTA_OSS_PUBLIC_IP '' '')
if [ -z "$PUBLIC_IP" ] && [ -z "$PRINT" ]; then PUBLIC_IP=$(detect_ip); fi
if [ -n "$PUBLIC_IP" ] && ! valid_ip "$PUBLIC_IP"; then die "INSTA_OSS_PUBLIC_IP must be a dotted IPv4 address (got '$PUBLIC_IP')"; fi

OLD_DOMAIN=$(existing INSTA_OSS_DOMAIN)
DOMAIN=$(resolve INSTA_OSS_DOMAIN "$F_DOMAIN" '')
DOMAIN_AUTO=0
if [ -z "$DOMAIN" ]; then
  DOMAIN_AUTO=1
  if [ -n "$PUBLIC_IP" ]; then DOMAIN=$(printf '%s' "$PUBLIC_IP" | tr . -).sslip.io
  elif [ -n "$PRINT" ]; then DOMAIN=127-0-0-1.sslip.io
  else die "could not detect a public IPv4 address; pass --domain <name> or INSTA_OSS_PUBLIC_IP=<ip>"
  fi
fi
DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's/\.$//')
printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9.-]+$' || die "domain must match [a-z0-9.-] (got '$DOMAIN')"
DOMAIN_CHANGED=0
[ -n "$OLD_DOMAIN" ] && [ "$OLD_DOMAIN" != "$DOMAIN" ] && DOMAIN_CHANGED=1

SECRET=$(resolve INSTA_OSS_SECRET '' '')
[ -n "$SECRET" ] || SECRET=$(randhex 32)

# The daemon trusts the internal CA through NODE_EXTRA_CA_CERTS (compose.yml); the path is written
# only once the file exists (Caddy mints it on the first HTTPS request), so a fresh install sets it
# after readiness and recreates io-instad once.
CA_FILE=''
if [ "$TLS" = internal ] && { [ -n "$PRINT" ] || [ -f "$DATA/edge/ca.pem" ]; }; then CA_FILE=$DATA/edge/ca.pem; fi

# Docker address pools known to the box (for the firewall rules); refined by ensure_pools.
POOL_BASES=$POOL_BASE_DEFAULT
if [ -r "$DAEMON_JSON" ] && grep -q '"default-address-pools"' "$DAEMON_JSON"; then
  POOL_BASES=$(grep -o '"base" *: *"[^"]*"' "$DAEMON_JSON" | sed 's/.*: *"//; s/"$//' | tr '\n' ' ')
fi

# ---- renderers ----
EMITTED=''
emit() { EMITTED="$EMITTED $1"; printf '%s=%s\n' "$1" "$2"; }
ek() { emit "$1" "$(resolve "$1" '' "$2")"; }   # env, then existing, then default
emitted() { case " $EMITTED " in *" $1 "*) return 0 ;; esac; return 1; }

render_env() {
  EMITTED=''
  cat <<EOF
# instad.env: written by install.sh (re-runs keep the values you edit here and append missing keys).
# Read by docker compose (interpolation) and by the io-instad container (env_file). Every key the
# daemon reads is listed; an empty value means "derive the default". Contract: 00-contract.md §15.
# After a change: cd $CFG && docker compose --env-file instad.env up -d
# --- run mode ---
EOF
  emit INSTA_OSS_MODE server
  emit INSTA_OSS_VERSION "$VERSION"
  emit INSTA_OSS_DOMAIN "$DOMAIN"
  emit INSTA_OSS_PUBLIC_IP "$PUBLIC_IP"
  emit INSTA_OSS_DATA_DIR "$DATA"
  ek INSTA_OSS_LISTEN_HOST 127.0.0.1
  emit INSTA_OSS_PORT "$PORT"
  emit INSTA_OSS_INTERNAL_PORT "$INTERNAL_PORT"
  ek INSTA_OSS_TRUST_PROXY 1
  ek INSTA_OSS_UI_DIST /app/ui/dist
  ek INSTA_OSS_TEMPLATES_DIR /app/templates
  cat <<EOF
# --- derived from INSTA_OSS_DOMAIN and INSTA_OSS_DATA_DIR while empty: <dataDir>/state.json,
#     <dataDir>/garage/garage.toml (compose mounts exactly that path), https://s3.<domain>,
#     https://api.<domain>, https://console.<domain>, <dataDir>/caddy/data/caddy/certificates ---
EOF
  ek INSTA_OSS_STATE ''
  ek INSTA_OSS_GARAGE_CONFIG ''
  ek INSTA_OSS_S3_HOST_ENDPOINT ''
  ek INSTA_OSS_API_URL ''
  ek INSTA_OSS_CONSOLE_URL ''
  ek INSTA_OSS_TLS_CERT_DIR ''
  log '# --- identity (INSTA_OSS_SECRET signs sessions and tokens: generated once, never rotated here) ---'
  ek INSTA_OSS_AUTH 1
  emit INSTA_OSS_SECRET "$SECRET"
  ek INSTA_OSS_SESSION_TTL_SEC 604800
  log '# --- router lanes ---'
  ek INSTA_OSS_LANE_BIND 0.0.0.0
  emit INSTA_OSS_LANE_PG_PORT "$LANE_PG"
  emit INSTA_OSS_LANE_REDIS_PORT "$LANE_REDIS"
  emit INSTA_OSS_LANE_MONGO_PORT "$LANE_MONGO"
  ek INSTA_OSS_LANE_PORT_RANGE 20000-20999
  ek INSTA_OSS_LANE_IDLE_SEC 900
  ek INSTA_OSS_PROBE_WINDOW_MS 8000
  ek INSTA_OSS_READY_WINDOW_MS 30000
  ek INSTA_OSS_TOUCH_DEBOUNCE_MS 5000
  ek INSTA_OSS_EDGE_PORT 443
  log '# --- scheduler (sleep after idle: 5 min compute, 10 min databases; evict below 15 percent free RAM) ---'
  ek INSTA_OSS_SCHEDULER 1
  ek INSTA_OSS_IDLE_COMPUTE_SEC 300
  ek INSTA_OSS_IDLE_DB_SEC 600
  ek INSTA_OSS_SWEEP_SEC 30
  ek INSTA_OSS_CREATE_GRACE_SEC 600
  ek INSTA_OSS_STOP_GRACE_SEC 10
  ek INSTA_OSS_STOP_GRACE_DB_SEC 30
  ek INSTA_OSS_WAKE_TIMEOUT_SEC 60
  ek INSTA_OSS_WAKE_PROTECT_SEC 60
  ek INSTA_OSS_RAM_FLOOR_PCT 15
  ek INSTA_OSS_MEM_BUDGET_MB ''
  ek INSTA_OSS_ALWAYS_ON_DEFAULT 0
  log '# --- data dir and forks ---'
  ek INSTA_OSS_HELPER_IMAGE node:22-alpine
  ek INSTA_OSS_FORK auto
  ek INSTA_OSS_DATA_MIGRATE 1
  ek INSTA_OSS_SWEEP_ORPHANS 0
  log '# --- services and templates ---'
  ek INSTA_OSS_MAX_SERVICES_PER_TYPE 5
  ek INSTA_OSS_TEMPLATE_VOLUME_GIB 10
  ek INSTA_OSS_TEMPLATE_HEALTH_TIMEOUT_MS 90000
  ek INSTA_OSS_TEMPLATE_HEALTH_POLL_MS 3000
  log '# --- stack only (compose.yml and this script; the daemon ignores them) ---'
  emit INSTA_OSS_IMAGE "$IMAGE"
  emit INSTA_OSS_TLS "$TLS"
  emit INSTA_OSS_ACME_EMAIL "$EMAIL"
  emit INSTA_OSS_CA_FILE "$CA_FILE"
  emit INSTA_OSS_DATA_IMG_GIB "$(resolve INSTA_OSS_DATA_IMG_GIB "$F_IMG_GIB" '')"
  # pass-through: keys the operator added to instad.env, then INSTA_OSS_* keys from the environment
  _extra=''
  if [ -r "$ENV_FILE" ]; then _extra=$(sed -n 's/^\(INSTA_OSS_[A-Z0-9_]*\)=.*/\1/p' "$ENV_FILE"); fi
  _extra="$_extra
$(env | sed -n 's/^\(INSTA_OSS_[A-Z0-9_]*\)=.*/\1/p')"
  _first=1
  for _k in $_extra; do
    emitted "$_k" && continue
    if [ "$_first" = 1 ]; then log '# --- pass-through (environment and operator additions) ---'; _first=0; fi
    ek "$_k" ''
  done
}

# Compose stack, written verbatim on every run (put your own changes in compose.override.yml).
render_compose() {
  cat <<EOF
# compose.yml: written by install.sh on every run; overrides go in compose.override.yml.
# The image and the CA file come from instad.env, which install.sh also symlinks to .env in this
# directory, so a plain \`docker compose up -d\` here interpolates them without --env-file. The
# data directory does NOT: it is written in here as the concrete path this run resolved, because
# compose interpolation lets the CALLING SHELL outrank --env-file, so an INSTA_OSS_DATA_DIR left
# over in an operator's environment would silently point every bind below (the daemon's own data,
# the certificate store, garage's meta and data) at another directory. This installer already
# refuses to move the data directory of an existing install, so the path is fixed at install time.
name: instacloud
services:
  instad:
    image: \${INSTA_OSS_IMAGE}:\${INSTA_OSS_VERSION}
    container_name: io-instad
    restart: unless-stopped
    # host network: 127.0.0.1:8080 (API, console, HTTP lane behind the edge), 127.0.0.1:8081 (edge
    # ask + healthz), 0.0.0.0:5432/6379/27017 database lanes; reaches container IPs directly.
    network_mode: host
    init: true
    stop_grace_period: 30s
    env_file: instad.env
    environment:
      # set by install.sh with INSTA_OSS_TLS=internal so the daemon trusts the edge's own CA
      NODE_EXTRA_CA_CERTS: \${INSTA_OSS_CA_FILE:-}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # identical path on both sides: every bind mount the daemon emits is valid on the host
      - $DATA:$DATA
  edge:
    image: caddy:2.11.4
    container_name: io-edge
    restart: unless-stopped
    network_mode: host
    depends_on: [instad]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      # certificate store; the daemon reads it (INSTA_OSS_TLS_CERT_DIR) for the database lanes
      - $DATA/caddy/data:/data
      - $DATA/caddy/config:/config
  garage:
    image: dxflrs/garage:v2.3.0
    container_name: io-garage
    restart: unless-stopped
    # stays on the compose bridge: the daemon attaches it to every branch network (rclone, apps)
    ports:
      - 127.0.0.1:3900:3900
      - 127.0.0.1:3902:3902
    volumes:
      - $DATA/garage/garage.toml:/etc/garage.toml:ro
      - $DATA/garage/meta:/var/lib/garage/meta
      - $DATA/garage/data:/var/lib/garage/data
EOF
}

# Caddyfile with concrete values (Caddy has no env placeholders for an omitted email line).
render_caddyfile() {
  printf '{\n\tadmin off\n'
  [ -z "$EMAIL" ] || printf '\temail %s\n' "$EMAIL"
  printf '\ton_demand_tls {\n\t\task http://127.0.0.1:%s/tls/ask\n\t}\n}\n' "$INTERNAL_PORT"
  printf 'https:// {\n\ttls {\n\t\ton_demand\n'
  [ "$TLS" = internal ] || printf '\t\tissuer acme\n'
  printf '\t\tissuer internal\n\t}\n'
  printf '\tencode zstd gzip\n'
  printf '\treverse_proxy 127.0.0.1:%s {\n' "$PORT"
  printf '\t\theader_up X-Forwarded-Proto https\n\t\theader_up X-Forwarded-Host {host}\n\t\tflush_interval -1\n\t}\n}\n'
  printf 'http:// {\n\tredir https://{host}{uri} permanent\n}\n'
}

render_garage_toml() {
  cat <<EOF
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_secret = "$1"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.$DOMAIN"
[s3_web]
bind_addr = "[::]:3902"
root_domain = ".s3.$DOMAIN"
index = "index.html"
EOF
}

render_daemon_json() { printf '%s\n' "$POOL_JSON"; }

# Apps reach the router at the host through --add-host ...:host-gateway; that traffic arrives on the
# branch bridge and traverses the host INPUT chain, which a default-deny firewall drops silently.
fw_ufw() {
  for _b in $POOL_BASES; do
    log "ufw allow from $_b to any port 443,5432,6379,27017 proto tcp"
    log "ufw allow from $_b to any port 20000:20999 proto tcp"
  done
  log 'ufw allow in on docker0 to any port 443,5432,6379,27017 proto tcp'
  log 'ufw allow in on docker0 to any port 20000:20999 proto tcp'
  log 'ufw allow 80,443,5432/tcp'
}
fw_firewalld() {
  log 'firewall-cmd --permanent --zone=docker --add-port=443/tcp --add-port=5432/tcp --add-port=6379/tcp --add-port=27017/tcp --add-port=20000-20999/tcp'
  log 'firewall-cmd --permanent --zone=public --add-port=80/tcp --add-port=443/tcp --add-port=5432/tcp'
  log 'firewall-cmd --reload'
}
render_firewall() {
  log "# ufw rules (applied when 'ufw status' reports active; ufw de-duplicates, so re-runs are idempotent)"
  fw_ufw
  log "# firewalld rules (applied when 'firewall-cmd --state' reports running)"
  fw_firewalld
}

# ---- print modes: render and exit, no root, no side effects ----
case $PRINT in
  env) render_env; exit 0 ;;
  compose) render_compose; exit 0 ;;
  caddyfile) render_caddyfile; exit 0 ;;
  daemon-json) render_daemon_json; exit 0 ;;
  firewall) render_firewall; exit 0 ;;
esac

# ---- 2. install or upgrade ----
if [ "$UPGRADE" = 1 ]; then
  _ex=$(existing INSTA_OSS_DATA_DIR)
  if [ -n "$_ex" ] && [ "$_ex" != "$DATA" ] && [ -z "$F_DATA_DIR" ]; then
    die "instad.env has INSTA_OSS_DATA_DIR=$_ex but this run resolved $DATA; move the data first, then re-run with --data-dir $DATA"
  fi
  log "upgrading the InstaCloud install in $CFG (version $VERSION)"
else
  log "installing InstaCloud into $CFG (version $VERSION)"
fi

# Compose interpolation lets the CALLING SHELL outrank --env-file, and this script is routinely
# invoked as `INSTA_OSS_IMAGE=... sh install.sh`. An INSTA_OSS_IMAGE that carries a tag would then
# reach compose whole and render `repo:tag:tag`, so every value compose.yml interpolates is pinned
# here to what this run resolved, which is also what instad.env was just written with.
compose() {
  (cd "$CFG" && INSTA_OSS_IMAGE=$IMAGE INSTA_OSS_VERSION=$VERSION INSTA_OSS_CA_FILE=$CA_FILE \
    docker compose --env-file instad.env "$@")
}
STACK_UP=0
if have docker && [ -f "$CFG/compose.yml" ] && [ -n "$(compose ps -q 2>/dev/null || true)" ]; then STACK_UP=1; fi

# ---- 3. ports (skipped while the stack itself holds them) ----
# Every port here is fatal. The daemon binds all three database lanes at startup and exits when one
# of them is taken (router: "a busy fixed port is fatal and names itself"), so warning about a busy
# 6379 and continuing only moved the failure sixty seconds later, to a healthz timeout that says
# nothing about ports. Each lane names the key that moves it instead. Nothing checks 3306: in server
# mode MySQL takes a port out of INSTA_OSS_LANE_PORT_RANGE, not the well known one.
port_busy() { [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]; }
port_holder() { ss -Hltnp "sport = :$1" 2>/dev/null | awk '{print $NF}' | head -n 1; }
PORTS_BUSY=0
need_port() {   # need_port PORT WHAT
  port_busy "$1" || return 0
  _h=$(port_holder "$1")
  warn "port $1 is in use by ${_h:-an unknown process}: $2"
  PORTS_BUSY=1
}
check_ports() {
  if ! have ss; then warn "ss (iproute2) not found; skipping the port check"; return; fi
  need_port 80 'the edge redirects HTTP here and answers the ACME challenge on it'
  need_port 443 'the edge serves HTTPS on it'
  need_port "$PORT" 'the daemon serves the API and the console on it; move it with INSTA_OSS_PORT'
  need_port "$INTERNAL_PORT" 'the daemon answers the edge and healthz on it; move it with INSTA_OSS_INTERNAL_PORT'
  need_port "$LANE_PG" 'the Postgres lane; free it or set INSTA_OSS_LANE_PG_PORT to another port'
  need_port "$LANE_REDIS" 'the Redis lane; free it or set INSTA_OSS_LANE_REDIS_PORT to another port'
  need_port "$LANE_MONGO" 'the MongoDB lane; free it or set INSTA_OSS_LANE_MONGO_PORT to another port'
  [ "$PORTS_BUSY" = 0 ] || die "the daemon cannot start while those ports are taken: free them (or move the lanes with the keys named above), then re-run"
}
[ "$STACK_UP" = 1 ] || check_ports

# ---- 4. docker, compose plugin, address pools ----
DOCKER_FRESH=0
if ! have docker; then
  log "installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
  DOCKER_FRESH=1
fi
if systemd_running; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
docker compose version >/dev/null 2>&1 || die "docker compose (the v2 plugin) is required: install docker-compose-plugin, then re-run"

restart_docker() {
  if systemd_running; then systemctl restart docker || true
  elif have service && [ -x /etc/init.d/docker ]; then service docker restart || true
  else warn "no service manager found to restart Docker; restart it yourself if the next step fails"
  fi
  _i=0
  until docker info >/dev/null 2>&1 || [ "$_i" -ge 30 ]; do _i=$((_i + 1)); sleep 1; done
  docker info >/dev/null 2>&1 || die "Docker is not answering after a restart (systemctl status docker, journalctl -u docker); start it, then re-run"
}
# get.docker.com enables the unit through systemd; a box that boots something else is left with an
# installed but stopped daemon, and every later step would fail on a raw "cannot connect" error.
if ! docker info >/dev/null 2>&1; then
  log "Docker is installed but not answering: starting it"
  restart_docker
fi
# Every branch is one user-defined network and stock dockerd yields only 31 of them; the 32nd
# `branch create` fails with "could not find an available, non-overlapping IPv4 address pool".
ensure_pools() {
  if [ -f "$DAEMON_JSON" ] && grep -q '"default-address-pools"' "$DAEMON_JSON"; then
    warn "$DAEMON_JSON already sets default-address-pools ($POOL_BASES): left as is; each branch needs one network"
    return
  fi
  if [ -f "$DAEMON_JSON" ] && [ -n "$(tr -d ' \t\r\n{}' < "$DAEMON_JSON")" ]; then
    POOL_BASES='172.16.0.0/12 192.168.0.0/16'
    warn "$DAEMON_JSON has other settings and no default-address-pools; Docker allows only 31 branch networks until you add:"
    warn "  \"default-address-pools\": [{\"base\": \"10.100.0.0/14\", \"size\": 24}]   then: systemctl restart docker"
    return
  fi
  mkdir -p /etc/docker
  render_daemon_json > "$DAEMON_JSON"
  POOL_BASES=$POOL_BASE_DEFAULT
  log "wrote $DAEMON_JSON (default-address-pools 10.100.0.0/14, one /24 per branch network); restarting Docker"
  [ "$DOCKER_FRESH" = 1 ] && [ "$STACK_UP" = 0 ] || log "  (running containers restart with it)"
  restart_docker
}
ensure_pools

# ---- 3b. firewall ----
run_rules() { while read -r _l; do log "  $_l"; eval "$_l" >/dev/null 2>&1 || warn "failed: $_l"; done; }
if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
  log "ufw is active: allowing the edge, the database lane and container-to-host traffic"
  fw_ufw | run_rules
elif have firewall-cmd && [ "$(firewall-cmd --state 2>/dev/null || true)" = running ]; then
  log "firewalld is running: allowing the edge, the database lane and container-to-host traffic"
  fw_firewalld | run_rules
fi

# ---- 5. data dir and reflinks ----
is_mounted() { mountpoint -q "$1" 2>/dev/null || grep -q " $1 " /proc/mounts; }
probe_reflink() {
  mkdir -p "$DATA/.probe" || return 1
  printf 'x' > "$DATA/.probe/install-a" || return 1
  if cp --reflink=always "$DATA/.probe/install-a" "$DATA/.probe/install-b" 2>/dev/null; then
    rm -f "$DATA/.probe/install-a" "$DATA/.probe/install-b"; return 0
  fi
  rm -f "$DATA/.probe/install-a" "$DATA/.probe/install-b"; return 1
}
data_nonempty() { [ -n "$(find "$DATA" -mindepth 1 -maxdepth 1 ! -name .probe 2>/dev/null | head -n 1)" ]; }
img_gib() { du -k --apparent-size "$IMG" 2>/dev/null | awk '{print int($1/1048576)}'; }
make_loop_image() {
  have mkfs.xfs || pkg_install xfsprogs || die "xfsprogs is required for the reflink volume (mkfs.xfs)"
  _parent=$(dirname "$DATA")
  _free=$(df -Pk "$_parent" | awk 'NR==2 {print int($4/1048576)}')
  [ "${_free:-0}" -ge 15 ] || die "need at least 15 GiB free under $_parent for the data volume (have ${_free:-0} GiB)"
  _size=$(resolve INSTA_OSS_DATA_IMG_GIB "$F_IMG_GIB" '')
  [ -n "$_size" ] || _size=$((_free - 5))
  printf '%s' "$_size" | grep -Eq '^[0-9]+$' || die "--data-img-gib must be an integer (got '$_size')"
  [ "$_size" -ge 10 ] || _size=10
  log "no reflinks on $(df -P "$_parent" | awk 'NR==2 {print $1}'): creating a ${_size} GiB XFS reflink volume at $IMG"
  truncate -s "${_size}G" "$IMG"
  mkfs.xfs -q -m reflink=1 "$IMG"
  if ! grep -q " $DATA " /etc/fstab 2>/dev/null; then
    # docker.service must not start while the data mount is absent: its restart policy would
    # otherwise bring every Postgres up on an empty directory before instad's guard runs.
    printf '%s\n' "$IMG $DATA xfs loop,nofail,x-systemd.required-by=docker.service,x-systemd.before=docker.service 0 0" >> /etc/fstab
  fi
  if systemd_running; then systemctl daemon-reload || true; fi
  mount "$DATA" || mount -o loop "$IMG" "$DATA"
  probe_reflink || die "$IMG is mounted at $DATA but reflinks still fail; check dmesg and mkfs.xfs -m reflink=1 support"
  REFLINK="loop image ($_size GiB)"
}
mkdir -p "$DATA"
if [ -f "$IMG" ] && ! is_mounted "$DATA"; then
  log "mounting $IMG at $DATA"
  mount "$DATA" 2>/dev/null || mount -o loop "$IMG" "$DATA"
fi
REFLINK=unavailable
if probe_reflink; then
  REFLINK=native
  [ -f "$IMG" ] && REFLINK="loop image ($(img_gib) GiB)"
elif [ -f "$IMG" ]; then
  die "$DATA sits on $IMG but reflinks fail; check the mount (findmnt $DATA) and dmesg"
elif data_nonempty; then
  warn "$DATA has no reflinks: branch forks stream pg_basebackup and copy volumes (slower, still correct)."
  warn "  to convert: docker compose -f $CFG/compose.yml down; mv $DATA $DATA.old; re-run; move the data back"
else
  make_loop_image
fi
mkdir -p "$DATA/pg" "$DATA/vol" "$DATA/md" "$DATA/garage/meta" "$DATA/garage/data" "$DATA/caddy/data" "$DATA/caddy/config" "$DATA/edge"
chmod 700 "$DATA"

# ---- 6. domain ----
# NAT_NOTE: repeated next to the setup URL at the end, because that URL is the one thing an
# operator copies out of this script and a name that resolves somewhere else is silent.
NAT_NOTE=''
if [ "$DOMAIN_AUTO" = 1 ]; then
  log "domain: $DOMAIN (auto, from the public IP; pass --domain to use your own)"
else
  log "domain: $DOMAIN"
fi
# The checks below are about the sslip.io name derived from the detected address, on a re-run as
# much as on the first install: an upgrade is often the run an operator actually reads.
if [ -n "$PUBLIC_IP" ] && [ "$DOMAIN" = "$(printf '%s' "$PUBLIC_IP" | tr . -).sslip.io" ]; then
  if private_ip "$PUBLIC_IP"; then
    warn "$PUBLIC_IP is a private address: certificates fall back to the internal issuer until a public name points here"
  elif ! ip_is_local "$PUBLIC_IP"; then
    # The address the internet sees is on no interface here: a cloud box with a floating or elastic
    # IP (fine, DNS points at it) or a laptop VM behind a home router (not fine, nothing forwards).
    # The script cannot tell those apart, so it says what to check.
    _lan=$(route_src)
    NAT_NOTE="$PUBLIC_IP is not an address of this box (NAT), so those URLs answer only if $PUBLIC_IP forwards 80 and 443 here."
    [ -z "$_lan" ] || NAT_NOTE="$NAT_NOTE On a laptop VM re-run with --domain $(printf '%s' "$_lan" | tr . -).sslip.io, which points at this box."
    warn "$NAT_NOTE"
  fi
fi

# ---- 7. secrets and files ----
mkdir -p "$CFG"
TOML=$DATA/garage/garage.toml
if [ ! -f "$TOML" ]; then
  render_garage_toml "$(randhex 32)" > "$TOML"
elif [ "$DOMAIN_CHANGED" = 1 ]; then
  sed -i "s/^root_domain = .*/root_domain = \".s3.$DOMAIN\"/" "$TOML"
fi
_tmp=$(mktemp "$CFG/.instad.env.XXXXXX")
render_env > "$_tmp"
chmod 600 "$_tmp"
mv -f "$_tmp" "$ENV_FILE"
render_compose > "$CFG/compose.yml"
render_caddyfile > "$CFG/Caddyfile"
# docker compose interpolates ${VAR} from the shell and from a .env file in the project directory,
# never from env_file. Without this symlink every documented bare command here (`docker compose
# down`, `up -d`, `stop instad`) resolves the image to ':' and `up` fails with "invalid reference
# format", which is how an operator who edited instad.env ends up unable to start the stack again.
ln -sfn instad.env "$CFG/.env"
log "wrote $ENV_FILE (0600), $CFG/compose.yml, $CFG/Caddyfile, $CFG/.env -> instad.env"

# ---- 8. up ----
log "pulling $IMAGE:$VERSION, caddy and garage"
compose pull --ignore-pull-failures -q 2>&1 | grep -v '^$' || true
log "starting the stack (io-instad, io-edge, io-garage)"
compose up -d --remove-orphans
if [ "$DOMAIN_CHANGED" = 1 ]; then compose restart garage >/dev/null 2>&1 || true; fi

# ---- 9. readiness ----
wait_healthy() {
  _i=0
  while [ "$_i" -lt 30 ]; do
    if curl -fsS -H "Host: api.$DOMAIN" "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then return 0; fi
    _i=$((_i + 1)); sleep 2
  done
  return 1
}
if ! wait_healthy; then
  compose logs --tail=40 instad 2>&1 || true
  die "instad did not answer on http://127.0.0.1:$PORT/healthz within 60 s (see the log above)"
fi
# One HTTPS request to api.<domain> makes the edge issue its certificate now (the database lanes
# use it as their default certificate). Pinned to loopback so a NAT'd box needs no hairpin route.
if ! curl -sk --resolve "api.$DOMAIN:443:127.0.0.1" --max-time 90 -o /dev/null "https://api.$DOMAIN/healthz"; then
  warn "the edge has not issued a certificate for api.$DOMAIN yet; it retries on the first request"
fi
if [ "$TLS" = internal ]; then
  _root=$DATA/caddy/data/caddy/pki/authorities/local/root.crt
  _i=0
  while [ ! -f "$_root" ] && [ "$_i" -lt 15 ]; do _i=$((_i + 1)); sleep 2; done
  if [ -f "$_root" ]; then
    cp "$_root" "$DATA/edge/ca.pem"
    chmod 644 "$DATA/edge/ca.pem"
    if [ -z "$CA_FILE" ]; then
      CA_FILE=$DATA/edge/ca.pem
      sed -i "s|^INSTA_OSS_CA_FILE=.*|INSTA_OSS_CA_FILE=$CA_FILE|" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      log "internal CA at $CA_FILE; restarting io-instad so the daemon trusts it"
      compose up -d --remove-orphans
      wait_healthy || die "instad did not come back after the CA restart"
    fi
  else
    warn "Caddy's internal root CA has not appeared at $_root; re-run the installer after the first HTTPS request"
  fi
fi

# ---- 10. done ----
log ''
log 'InstaCloud is running.'
log "  Setup:    https://console.$DOMAIN/setup"
log "  API:      https://api.$DOMAIN"
[ -z "$NAT_NOTE" ] || log "  Note:     $NAT_NOTE"
log "  CLI:      insta login --api-key <token from the setup page> --api-url https://api.$DOMAIN"
[ -z "$CA_FILE" ] || log "  CA:       $CA_FILE (internal issuer: pass it to curl --cacert, PGSSLROOTCERT, NODE_EXTRA_CA_CERTS)"
log "  Config $CFG   Data $DATA   Reflinks: $REFLINK"
log 'Re-run this script to upgrade (add --version vX.Y.Z to pin).'
