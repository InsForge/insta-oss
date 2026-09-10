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
#   (no flag)                        INSTA_OSS_IMAGE                ghcr.io/insforge/instacloud (a tag
#                                    here is the version: build your own with
#                                    `docker build -t instacloud:dev .`)
#   --tls acme|internal              INSTA_OSS_TLS                  acme (internal = Caddy's own CA)
#   --data-img-gib <n>               INSTA_OSS_DATA_IMG_GIB         free space minus 5 GiB
#   --data-dir <path>                INSTA_OSS_DATA_DIR             /var/lib/instacloud (the flag is
#                                    required to CHANGE the data dir of an existing install)
#   --print-env | --print-compose | --print-caddyfile | --print-daemon-json | --print-firewall
#   --print-ssh-advice               render one file (or the ssh advisory) to stdout and exit:
#                                    no root, no side effects
#   -y                               accepted; the script never prompts
# Every other INSTA_OSS_* variable present in the environment is written into instad.env as is.
# Precedence for every value: flag, then environment, then the existing instad.env, then default.
# Requirements: root, Linux, x86_64 or aarch64, 2 vCPU, 2 GiB RAM, 15 GiB free disk, and the ports
# 80, 443, 8080, 8081, 5432, 6379 and 27017 free (each refusal names the key that moves it).
set -eu

# ---- constants ----
# IO_CFG_DIR is a TEST HOOK, never set in production: it is what lets the suite exercise the
# UPGRADE path, where values come back out of an instad.env the operator may have edited.
CFG=${IO_CFG_DIR:-/etc/instacloud}
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
  if [ -r "$0" ]; then sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
  else log 'usage: see the header comment of install.sh (https://github.com/InsForge/insta-oss/blob/main/install.sh)'
  fi
}

# ---- flags ----
PRINT=''; F_DOMAIN=''; F_EMAIL=''; F_VERSION=''; F_TLS=''; F_IMG_GIB=''; F_DATA_DIR=''
need() { if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi; }
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
    --print-env|--print-compose|--print-caddyfile|--print-daemon-json|--print-firewall|--print-ssh-advice) PRINT=${1#--print-}; shift ;;
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
# ...and a path, not a sentence. This one is not eval'd, but it IS written into /etc/fstab as a
# space-separated field and into compose, and it comes back out of instad.env on every upgrade,
# so whitespace or a shell metacharacter in it is the same "planted once, used as root later"
# shape as the lane range.
printf '%s' "$DATA" | grep -Eq '^/[A-Za-z0-9._/-]*$' ||
  die "INSTA_OSS_DATA_DIR must be an absolute path of letters, digits, dot, dash, underscore and / (got '$DATA')"
DATA=${DATA%/}
IMG=$DATA.img

# INSTA_OSS_IMAGE may carry a tag (INSTA_OSS_IMAGE=ghcr.io/insforge/instacloud:ci); the tag is the version.
IMAGE=$(resolve INSTA_OSS_IMAGE '' "$IMAGE_DEFAULT")
# A reference, not a sentence: it is written into instad.env, which compose parses, and read
# back from there on every upgrade. Same reasoning as the data directory.
printf '%s' "$IMAGE" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/:@-]*$' ||
  die "INSTA_OSS_IMAGE must be an image reference (got '$IMAGE')"
IMAGE_TAG=''
case ${IMAGE##*/} in *:*) IMAGE_TAG=${IMAGE##*:}; IMAGE=${IMAGE%:*} ;; esac

latest_release() {
  curl -fsSL --max-time 10 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1
}
# version: flag, env, the image tag, the newest GitHub release (upgrade), the existing value, 'latest'
# The leading v is stripped from a version a human typed and from a release tag, because the
# published image tags carry no v (release v0.1.0 is image :0.1.0). A tag that came from
# INSTA_OSS_IMAGE is NOT touched: it already names a tag that exists, in a registry or in this
# box's own Docker, and rewriting it invents one that does not. Stripping it turned
# `INSTA_OSS_IMAGE=instacloud:v1` into a pull of `instacloud:1`, which fails the whole install
# after instad.env has already been rewritten.
VERSION=$F_VERSION
[ -n "$VERSION" ] || VERSION=$(envval INSTA_OSS_VERSION)
VERSION=${VERSION#v}
[ -n "$VERSION" ] || VERSION=$IMAGE_TAG
if [ -z "$VERSION" ] && [ -z "$PRINT" ]; then VERSION=$(latest_release || true); VERSION=${VERSION#v}; fi
[ -n "$VERSION" ] || VERSION=$(existing INSTA_OSS_VERSION)
[ -n "$VERSION" ] || VERSION=latest

TLS=$(resolve INSTA_OSS_TLS "$F_TLS" acme)
case $TLS in acme|internal) ;; *) die "--tls must be acme or internal (got '$TLS')" ;; esac
EMAIL=$(resolve INSTA_OSS_ACME_EMAIL "$F_EMAIL" '')
PORT=$(resolve INSTA_OSS_PORT '' 8080)
INTERNAL_PORT=$(resolve INSTA_OSS_INTERNAL_PORT '' 8081)
# The database lanes the daemon binds on the host. The port CHECK, instad.env and the FIREWALL
# rules all read these same resolved values: the rules used to be written with the defaults
# hardcoded, which made a moved lane unreachable behind an active firewall and, worse, opened the
# default port anyway -- so moving the Postgres lane because something else already held 5432
# meant the installer skipped its own check on 5432 and then published a stranger's service.
#
# They are validated HERE, once, because they reach `run_rules`, which evals what it is given.
# Until now its input was script-internal; a lane port is operator input.
valid_port() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
lane_port() {   # lane_port KEY DEFAULT -> the resolved, validated port
  _lp=$(resolve "$1" '' "$2")
  valid_port "$_lp" || die "$1 must be a port between 1 and 65535 (got '$_lp')"
  printf '%s' "$_lp"
}
LANE_PG=$(lane_port INSTA_OSS_LANE_PG_PORT 5432)
LANE_REDIS=$(lane_port INSTA_OSS_LANE_REDIS_PORT 6379)
LANE_MONGO=$(lane_port INSTA_OSS_LANE_MONGO_PORT 27017)
# The per-service lane range (server-mode MySQL). Validated as a RANGE, not as a port.
LANE_RANGE=$(resolve INSTA_OSS_LANE_PORT_RANGE '' 20000-20999)
# The WHOLE STRING, not its ends. `${LANE_RANGE%%-*}` and `${LANE_RANGE##*-}` read the text
# before the FIRST hyphen and after the LAST one, so everything between them was never looked
# at: a value of the shape `1-<payload>-2` gave a low of 1 and a high of 2, passed the numeric
# checks, and was rendered into a firewall line that `run_rules` then evals AS ROOT. Shape
# first, bounds second.
printf '%s' "$LANE_RANGE" | grep -Eq '^[0-9]{1,5}-[0-9]{1,5}$' ||
  die "INSTA_OSS_LANE_PORT_RANGE must be <low>-<high>, digits only (got '$LANE_RANGE')"
LANE_RANGE_LO=${LANE_RANGE%%-*}
LANE_RANGE_HI=${LANE_RANGE##*-}
{ valid_port "$LANE_RANGE_LO" && valid_port "$LANE_RANGE_HI" && [ "$LANE_RANGE_LO" -le "$LANE_RANGE_HI" ]; } ||
  die "INSTA_OSS_LANE_PORT_RANGE must be <low>-<high> with 1 <= low <= high <= 65535 (got '$LANE_RANGE')"

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
# Every base is checked against the CIDR grammar before it is kept. It comes out of a file this
# script does not own, it is interpolated into the firewall lines, and run_rules evals those, so
# anything that is not a.b.c.d/len is dropped with a warning rather than carried into a root shell.
valid_cidr() { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'; }
keep_cidrs() {
  _out=''
  for _c in $1; do
    if valid_cidr "$_c"; then _out="$_out $_c"
    else warn "ignoring an address pool base that is not a CIDR block: $_c"
    fi
  done
  printf '%s' "${_out# }"
}
POOL_BASES=$POOL_BASE_DEFAULT
if [ -r "$DAEMON_JSON" ] && grep -q '"default-address-pools"' "$DAEMON_JSON"; then
  POOL_BASES=$(keep_cidrs "$(grep -o '"base" *: *"[^"]*"' "$DAEMON_JSON" | sed 's/.*: *"//; s/"$//' | tr '\n' ' ')")
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
  emit INSTA_OSS_LANE_PORT_RANGE "$LANE_RANGE"
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
# Every port ssh may be reachable on, empty when nothing could be established. No source here is
# authoritative and none is a fallback for another: they answer different questions, and on a
# socket-activated box they DISAGREE (see the union below). Never guesses: a guess is what put a
# hardcoded 22 in advice aimed at hardened boxes, which are exactly the ones that moved it.
# IO_SSH_PORTS is a test hook, never set in production.
ssh_ports() {
  if [ -n "${IO_SSH_PORTS:-}" ]; then
    printf '%s\n' "$IO_SSH_PORTS" | tr -s ', ' '\n' | grep -E '^[0-9]+$' | sort -un
    return 0
  fi
  # The UNION of three sources, never one with the others as fallbacks. `sshd -T` reports what
  # the CONFIG says, and on a socket-activated box (the Ubuntu 24.04 default) that is not what
  # the machine is listening on: the documented way to move SSH there is
  # `systemctl edit ssh.socket` with ListenStream=2222, which leaves sshd_config at `#Port 22`.
  # A fallback chain therefore asserts 22 on exactly the hardened boxes that moved it, because
  # `sshd -T` always answers where sshd is installed and the later sources never run. With
  # `Accept=no` systemd owns the listener too, so the `ss` source is process-filtered on sshd
  # only as a third opinion, not as the socket-activation answer.
  {
    { sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null; } | awk '/^port /{print $2}'
    systemctl show ssh.socket sshd.socket --value -p Listen 2>/dev/null |
      sed -n 's/.*:\([0-9][0-9]*\)[[:space:]]*(Stream).*/\1/p'
    ss -tlnpH 2>/dev/null | awk '/sshd/{n=split($4,a,":"); print a[n]}'
  } | grep -E '^[0-9]+$' | sort -un
}
# The advisory the no-firewall arm prints: one allow per port sshd is ACTUALLY on, before the
# enable, because an `ufw enable` that names the wrong port is the same lockout as one that names
# none. Every detected port, not the first: a box can listen on several and dropping the one the
# operator uses is the whole failure. Nothing detected means nothing is assumed, so it names the
# app profile and spells out the substitution.
ssh_advice() {
  _adv=$(ssh_ports)
  _advn=$(printf '%s\n' "$_adv" | grep -c '^[0-9]' || true)
  if [ -z "$_adv" ]; then
    printf '    ufw allow OpenSSH           # or your own SSH port: allow it BEFORE the enable\n'
  else
    # Where the sources DISAGREE, every candidate is printed and the disagreement is stated.
    # Advice that admits uncertainty cannot lock anyone out; advice that asserts the wrong port
    # can, and that is the whole failure this detection exists to avoid.
    if [ "$_advn" -gt 1 ]; then
      printf '    # sshd config and the socket unit report DIFFERENT ports. Allow every one you use:\n'
    fi
    for _a in $_adv; do
      printf '    ufw allow %s/tcp          # ssh candidate %s: allow it BEFORE the enable\n' "$_a" "$_a"
    done
  fi
  printf '    ufw allow 80,443,5432/tcp   # the edge and the postgres lane\n'
  printf '    ufw enable\n'
}
# The rules for the services THIS script installs, and nothing else. There is deliberately no SSH
# rule here: SSH policy belongs to the operator, and an installer that edits it either skips a
# rule the box needed or widens one the operator narrowed on purpose. The advisory above tells
# them what to allow; this only opens what insta-oss itself needs.
# Every rule below is generated from the RESOLVED lane values, never from the defaults, and each
# one is re-checked on the way out: `run_rules` evals these lines, so nothing that failed
# validation may reach it even if a later edit sets these variables somewhere else.
lane_ports() {   # the container-facing set: the edge plus the three database lanes
  for _p in 443 "$LANE_PG" "$LANE_REDIS" "$LANE_MONGO"; do
    valid_port "$_p" || die "refusing to write a firewall rule for '$_p': not a port"
  done
  printf '443,%s,%s,%s' "$LANE_PG" "$LANE_REDIS" "$LANE_MONGO"
}
fw_ufw() {
  _lanes=$(lane_ports)
  _range=$(printf '%s' "$LANE_RANGE" | tr '-' ':')   # ufw spells a range low:high
  for _b in $POOL_BASES; do
    log "ufw allow from $_b to any port $_lanes proto tcp"
    log "ufw allow from $_b to any port $_range proto tcp"
  done
  log "ufw allow in on docker0 to any port $_lanes proto tcp"
  log "ufw allow in on docker0 to any port $_range proto tcp"
  # The only PUBLIC rule: the edge and the Postgres lane, on the port that lane actually uses.
  log "ufw allow 80,443,$LANE_PG/tcp"
}
fw_firewalld() {
  lane_ports >/dev/null   # validate before either zone is written
  log "firewall-cmd --permanent --zone=docker --add-port=443/tcp --add-port=$LANE_PG/tcp --add-port=$LANE_REDIS/tcp --add-port=$LANE_MONGO/tcp --add-port=$LANE_RANGE/tcp"
  log "firewall-cmd --permanent --zone=public --add-port=80/tcp --add-port=443/tcp --add-port=$LANE_PG/tcp"
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
  ssh-advice) ssh_advice; exit 0 ;;
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

# ---- 3a. cpu, memory and disk ----
# The minimums this script documents were enforced nowhere except the loop-image path, so a box
# under them installed cleanly and then failed later under load, on an error that says nothing
# about sizing. They are checked here, once, by name. A first install refuses; an upgrade only
# warns, because an installer that will not update a box that is already running helps nobody.
# A machine sold as 2 GiB reports a little less, since firmware and the kernel's own reserve come
# off MemTotal (a 2 GiB cloud instance shows about 1.9 GiB), so the floor is 1900 MiB: the
# documented 2 GiB machine passes and a 1 GiB one does not.
MEM_FLOOR_MIB=1900
DISK_FLOOR_GIB=15
# The file is an argument so the check is testable without a Linux box. Production never passes it,
# which is exactly what SC2120 (and SC2119 at the call site) reports; the seam is deliberate.
# shellcheck disable=SC2120
mem_total_mib() {
  _f=${1:-/proc/meminfo}
  [ -r "$_f" ] || return 1
  awk '/^MemTotal:/ {print int($2 / 1024); found = 1} END {exit !found}' "$_f"
}
# The filesystem that will hold the data directory: the directory itself when it already exists (an
# operator who pre-mounted a volume there), otherwise its nearest existing ancestor.
free_gib() {
  _d=$1
  while [ ! -d "$_d" ] && [ "$_d" != / ]; do _d=$(dirname "$_d"); done
  df -Pk "$_d" 2>/dev/null | awk 'NR==2 {print int($4 / 1048576)}'
}
check_resources() {
  _cpu=$(nproc 2>/dev/null) || _cpu=$(getconf _NPROCESSORS_ONLN 2>/dev/null) || _cpu=''
  case $_cpu in
    ''|*[!0-9]*) ;;
    *) if [ "$_cpu" -lt 2 ]; then warn "$_cpu vCPU: the minimum is 2, and one core makes every deploy and branch fork slow"; fi ;;
  esac
  UNDERSIZED=0
  _mem=$(mem_total_mib) || _mem=''
  case $_mem in
    ''|*[!0-9]*) warn "could not read MemTotal from /proc/meminfo: skipping the memory check" ;;
    *) if [ "$_mem" -lt "$MEM_FLOOR_MIB" ]; then
         warn "${_mem} MiB of RAM: the minimum is 2 GiB, which is what the daemon, the edge, Garage and one Postgres need together"
         UNDERSIZED=1
       fi ;;
  esac
  _free=$(free_gib "$DATA")
  case $_free in
    ''|*[!0-9]*) warn "could not read the free space for $DATA: skipping the disk check" ;;
    *) if [ "$_free" -lt "$DISK_FLOOR_GIB" ]; then
         warn "${_free} GiB free where $DATA lives: the minimum is $DISK_FLOOR_GIB GiB, and images, database directories and branch forks all land there"
         UNDERSIZED=1
       fi ;;
  esac
  if [ "$UNDERSIZED" = 0 ]; then return 0; fi
  if [ "$UPGRADE" = 1 ]; then
    warn "continuing: this is an upgrade of an install that already exists on this box"
    return 0
  fi
  die "this box is under the documented minimum (2 vCPU, 2 GiB RAM, $DISK_FLOOR_GIB GiB free): resize it, or put the data on a larger filesystem with --data-dir <path>"
}
check_resources

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
    _p=$(printf '%s' "$POOL_BASES" | sed 's/  *$//')
    # The pools this script writes are the normal state of an installed box, so seeing them on an
    # upgrade is not a warning. Anything else is: it caps the box at that many branch networks.
    if [ "$_p" = "$POOL_BASE_DEFAULT" ]; then log "$DAEMON_JSON already sets default-address-pools ($_p)"
    elif [ -z "$_p" ]; then warn "$DAEMON_JSON sets default-address-pools but none of its bases parse as a CIDR block: left as is, and no per-pool firewall rule is written for them"
    else warn "$DAEMON_JSON already sets default-address-pools ($_p): left as is; each branch needs one network"
    fi
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
  if [ "$DOCKER_FRESH" != 1 ] || [ "$STACK_UP" != 0 ]; then log "  (running containers restart with it)"; fi
  restart_docker
}
ensure_pools

# ---- 3b. firewall ----
# The LAST line of defence, on the final rendered rule rather than on any of the parts it was
# built from. Every rule this script emits is machine-generated from validated values, so a
# strict allowlist on the rendered line costs nothing and holds whatever upstream validation
# misses or a future edit introduces: a line carrying a shell metacharacter never reaches
# `eval`, and the install stops rather than running it as root.
rule_ok() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9 ,:./=_-]*$'; }
run_rules() {
  while read -r _l; do
    [ -n "$_l" ] || continue
    rule_ok "$_l" || die "refusing to run a firewall rule with unexpected characters: $_l"
    log "  $_l"
    eval "$_l" >/dev/null 2>&1 || warn "failed: $_l"
  done
}
# ...and the renderer runs FIRST, into a variable, with its status checked. `fw_ufw | run_rules`
# put the renderer in a subshell, so a `die` inside it exited that subshell only: the pipeline's
# status was `run_rules` succeeding, and with no `pipefail` the script carried on and reported a
# successful install. The here-document keeps `run_rules` in THIS shell, so its own `die` aborts.
apply_rules() {   # apply_rules RENDERER
  _rendered=$("$1") || die "could not render the firewall rules ($1)"
  run_rules <<RULES
$_rendered
RULES
}
if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
  log "ufw is active: allowing the edge, the database lane and container-to-host traffic"
  apply_rules fw_ufw
elif have firewall-cmd && [ "$(firewall-cmd --state 2>/dev/null || true)" = running ]; then
  log "firewalld is running: allowing the edge, the database lane and container-to-host traffic"
  apply_rules fw_firewalld
else
  # No host firewall to restrict anything, and the lanes bind 0.0.0.0 in server mode
  # (INSTA_OSS_LANE_BIND above), so 6379 and 27017 are reachable from wherever this box is
  # reachable. A warning and not a refusal: most of these boxes are protected by a cloud
  # security group instead, and refusing would break every one of those installs.
  warn "no active ufw or firewalld found, so nothing here restricts the database lanes"
  warn "  the redis (6379) and mongodb (27017) lanes listen on all interfaces and are NOT meant to be public"
  warn "  restrict them at your cloud security group, or enable ufw yourself. Your SSH access is"
  warn "  yours to preserve: this script adds no SSH rule, and ufw defaults to DROP, so allow"
  warn "  every port sshd listens on BEFORE you enable it:"
  ssh_advice | while read -r _l; do warn "$_l"; done
  warn "  then re-run the installer the same way you installed it, so it adds the container rules"
  warn "  for the database lanes (they are what lets your apps reach them)"
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
  log "domain: $DOMAIN (auto, from the address it detected; pass --domain to use your own)"
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
  # 0600: the file carries rpc_secret. The garage image runs as root, so the read-only bind still
  # reads it (src/adapters/garage.ts writes the same file with the same mode).
  (umask 077 && render_garage_toml "$(randhex 32)" > "$TOML")
  chmod 600 "$TOML"
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
# A first ACME issuance is an order, an HTTP-01 challenge and a poll against a public CA, and on a
# fresh public box that regularly outlasts a single request, so a healthy install used to end on a
# warning saying its certificate was missing when it was merely late. What the lanes actually need
# is the file, so the wait polls the store Caddy writes and the daemon reads:
# <dataDir>/caddy/data/caddy/certificates/<issuer>/<host>/<host>.crt, whichever issuer wins (acme
# first, the internal CA as the fallback the Caddyfile lists after it).
CERT_DIR=$DATA/caddy/data/caddy/certificates
cert_present() { [ -n "$(find "$CERT_DIR" -type f -name "api.$DOMAIN.crt" 2>/dev/null | head -n 1)" ]; }
# The internal issuer is local and answers in seconds; ACME does not, and four minutes covers a
# first issuance plus one retry. Past that the edge keeps trying on its own, so this is a warning.
if [ "$TLS" = internal ]; then CERT_WAIT=60; else CERT_WAIT=240; fi
# Each attempt gets a full minute because Caddy issues INSIDE the handshake: a client that hangs up
# early can take the issuance with it, so a short timeout retried often is worse than a long one.
# The budget is wall time, measured, not a constant charged per attempt: an attempt that answers in
# a second must not spend the whole budget, which is what a fixed 65 s charge did to every value
# under 65 (the internal issuer's 60 collapsed to a single try, and the line below never printed).
_started=$(date +%s)
_tries=0
while :; do
  curl -sk --resolve "api.$DOMAIN:443:127.0.0.1" --max-time 60 -o /dev/null "https://api.$DOMAIN/healthz" || true
  if cert_present; then break; fi
  _tries=$((_tries + 1))
  if [ "$(( $(date +%s) - _started ))" -ge "$CERT_WAIT" ]; then break; fi
  if [ "$_tries" -eq 1 ]; then log "waiting for the edge to issue the certificate for api.$DOMAIN (up to ${CERT_WAIT}s)"; fi
  sleep 5
done
if cert_present; then
  log "certificate issued for api.$DOMAIN"
else
  warn "no certificate for api.$DOMAIN after ${CERT_WAIT}s: the edge keeps retrying, and the database lanes start presenting it the moment it lands"
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
[ -z "$CA_FILE" ] || log "  CA:       $CA_FILE (internal issuer: pass it to curl --cacert, PGSSLROOTCERT, NODE_EXTRA_CA_CERTS, AWS_CA_BUNDLE)"
log "  Config $CFG   Data $DATA   Reflinks: $REFLINK"
log 'Re-run this script to upgrade (add --version vX.Y.Z to pin).'
