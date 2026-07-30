#!/usr/bin/env bash
# =============================================================================
# install.sh - Soteria TACACS+ full-stack installer
# =============================================================================
# Company:    Pathfinder Insights
# Engineer:   MotoMotoFan
# Project:    Soteria AAA Infrastructure
# =============================================================================
# One command stands up the ENTIRE stack. Core (always installed):
#   1. prerequisites (Docker Engine + Compose plugin, openssl, curl, git)
#   2. configuration & secrets - every generated credential is RECORDED in
#      CREDENTIALS.md (chmod 600, gitignored) so nothing is ever lost
#   3. shared docker network (soteria-net)
#   4. Supabase (auth + MFA)     - CORE, deployed automatically
#   5. OpenBao (secret storage)  - CORE, deployed, initialised, unsealed,
#      KV engine `soteria-app` seeded with the stack secrets
#   6. Keycloak (OIDC / SSO)     - OPTIONAL, asked interactively
#   7. core stack build & start (tac_plus-ng, agent, frontend, BIND9)
#      + nginx TLS reverse proxy - OPTIONAL, asked interactively
#   8. first-run bootstrap: web UI tables + FIRST ADMINISTRATOR
#      (admin@soteria.lab, default password Admin@123 - change it!) + health
#
# Re-run safe / idempotent: existing secrets, deployments and users are kept.
# Usage:
#   sudo ./install.sh                     # interactive (asks the optionals)
#   sudo ./install.sh --non-interactive   # defaults: proxy yes, keycloak no
#   sudo ./install.sh --with-keycloak     # force optional on (no prompt)
#   sudo ./install.sh --without-proxy     # force optional off (no prompt)
#   sudo ./install.sh --skip-prereqs      # Docker/openssl already present
#   sudo ./install.sh --skip-build        # don't (re)build the core stack
# =============================================================================
set -euo pipefail

# ---- config ----------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${REPO_DIR}/.env"
ENV_EXAMPLE="${REPO_DIR}/.env.example"
CRED_FILE="${REPO_DIR}/CREDENTIALS.md"
DEPS_DIR="${DEPS_DIR:-$(dirname "$REPO_DIR")}"   # supabase/openbao/keycloak/nginx live beside the repo
SB_DIR="${DEPS_DIR}/supabase"
OB_DIR="${DEPS_DIR}/openbao"
KC_DIR="${DEPS_DIR}/keycloak"
PX_DIR="${DEPS_DIR}/nginx"
NETWORK="soteria-net"
ADMIN_EMAIL_DEFAULT="admin@soteria.lab"
ADMIN_PW_DEFAULT="Admin@123"

INTERACTIVE=1; SKIP_PREREQS=0; SKIP_BUILD=0; WITH_KEYCLOAK=""; WITH_PROXY=""
for a in "$@"; do case "$a" in
  --non-interactive)  INTERACTIVE=0 ;;
  --skip-prereqs)     SKIP_PREREQS=1 ;;
  --skip-build)       SKIP_BUILD=1 ;;
  --with-keycloak)    WITH_KEYCLOAK=1 ;;
  --without-keycloak) WITH_KEYCLOAK=0 ;;
  --with-proxy)       WITH_PROXY=1 ;;
  --without-proxy)    WITH_PROXY=0 ;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown option: $a" >&2; exit 2 ;;
esac; done

# ---- helpers ---------------------------------------------------------------
c_g="\033[32m"; c_y="\033[33m"; c_r="\033[31m"; c_b="\033[1m"; c_0="\033[0m"
log()  { echo -e "${c_g}[+]${c_0} $*"; }
warn() { echo -e "${c_y}[!]${c_0} $*"; }
err()  { echo -e "${c_r}[x]${c_0} $*" >&2; }
step() { echo -e "\n${c_b}== $* ==${c_0}"; }
have() { command -v "$1" >/dev/null 2>&1; }
ask()  { # ask "Prompt" "default" -> echoes answer
  local p="$1" d="${2:-}" a
  if [ "$INTERACTIVE" -eq 0 ]; then echo "$d"; return; fi
  read -r -p "$p ${d:+[$d] }" a </dev/tty || true; echo "${a:-$d}"
}
ask_secret() { # ask_secret "Prompt" -> echoes typed value (hidden)
  local p="$1" a
  if [ "$INTERACTIVE" -eq 0 ]; then echo ""; return; fi
  read -r -s -p "$p " a </dev/tty || true; echo >&2; echo "$a"
}
ask_yn() { # ask_yn "Prompt" "y|n" -> echoes 1 or 0
  local a; a=$(ask "$1 (y/n)" "$2")
  case "$a" in y|Y|yes|YES) echo 1 ;; *) echo 0 ;; esac
}
SUDO=""; [ "$(id -u)" -ne 0 ] && have sudo && SUDO="sudo"

gen_pw()  { openssl rand -base64 24 | tr -d '/+=' | cut -c1-20; }
b64url()  { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
# $ must be written as $$ in .env: docker compose interpolates $VAR sequences
# inside values, which would silently mangle SHA-512 crypt hashes.
hash_pw() { openssl passwd -6 "$1" | sed -e 's/\$/$$/g'; }

set_kv() { # set_kv FILE KEY VALUE  (idempotent in-place update)
  local f="$1" k="$2" v="$3" ev
  ev=$(printf '%s' "$v" | sed -e 's/[|&\\]/\\&/g')
  if grep -qE "^${k}=" "$f"; then sed -i "s|^${k}=.*|${k}=${ev}|" "$f"
  else echo "${k}=${v}" >> "$f"; fi
}
# '|| true': a missing key must yield empty, not kill the script (set -e + pipefail)
get_kv()  { grep -E "^$2=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }
set_env() { set_kv "$ENV_FILE" "$1" "$2"; }
get_env() { get_kv "$ENV_FILE" "$1"; }

# EVERY credential this installer creates goes through cred_set so it ends up
# in CREDENTIALS.md. Losing a password to a hidden prompt is not acceptable.
cred_init() {
  [ -f "$CRED_FILE" ] && return
  umask 077
  cat > "$CRED_FILE" <<EOF
# Soteria Lab Credentials - $(hostname) ($(date -Is))
# Written by install.sh. chmod 600, gitignored. Check HERE before asking
# "what was the password". KEY=VALUE lines are machine-readable.
EOF
  chmod 600 "$CRED_FILE"
}
cred_set() { cred_init; set_kv "$CRED_FILE" "$1" "$2"; }
cred_get() { get_kv "$CRED_FILE" "$1"; }

mk_supabase_jwt() { # role secret -> HS256 JWT (10y expiry), the Supabase key format
  local role="$1" secret="$2" hdr pl sig iat exp
  iat=$(date +%s); exp=$((iat + 315360000))
  hdr=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  pl=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$role" "$iat" "$exp" | b64url)
  sig=$(printf '%s' "$hdr.$pl" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)
  echo "$hdr.$pl.$sig"
}

detect_lan_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1
}

compose() { (cd "$1" && shift && docker compose "$@"); }

# ---- 1. prerequisites ------------------------------------------------------
install_prereqs() {
  step "1/8  Prerequisites"
  if [ "$SKIP_PREREQS" -eq 1 ]; then warn "skipping prereqs (--skip-prereqs)"; return; fi

  local pkgmgr=""
  if have apt-get; then pkgmgr=apt; elif have dnf; then pkgmgr=dnf; elif have yum; then pkgmgr=yum; fi
  [ -z "$pkgmgr" ] && { err "unsupported distro (need apt or dnf/yum). Install Docker + openssl manually."; exit 1; }

  case "$pkgmgr" in
    apt) $SUDO apt-get update -qq; $SUDO apt-get install -y -qq ca-certificates curl gnupg git openssl netcat-openbsd python3 >/dev/null ;;
    dnf|yum) $SUDO "$pkgmgr" install -y -q curl git openssl nmap-ncat ca-certificates python3 >/dev/null ;;
  esac
  log "base tools present (curl, git, openssl, python3)"

  if ! have docker; then
    log "installing Docker Engine (get.docker.com)"
    curl -fsSL https://get.docker.com | $SUDO sh
  else log "docker present ($(docker --version))"; fi

  if ! docker compose version >/dev/null 2>&1; then
    warn "Docker Compose plugin missing"
    case "$pkgmgr" in
      apt) $SUDO apt-get install -y -qq docker-compose-plugin >/dev/null || true ;;
      dnf|yum) $SUDO "$pkgmgr" install -y -q docker-compose-plugin >/dev/null || true ;;
    esac
  fi
  docker compose version >/dev/null 2>&1 || { err "docker compose plugin still missing; install it and re-run"; exit 1; }
  log "docker compose present ($(docker compose version | head -1))"

  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true

  # let the invoking (or sudo-invoking) user run docker without sudo
  local u="${SUDO_USER:-$USER}"
  if [ "$u" != "root" ] && ! id -nG "$u" 2>/dev/null | grep -qw docker; then
    usermod -aG docker "$u" 2>/dev/null || $SUDO usermod -aG docker "$u" || true
    warn "added $u to the 'docker' group - log out/in (or use 'sg docker -c ...') for it to take effect"
  fi
}

# ---- 2. configuration & secrets --------------------------------------------
setup_env() {
  step "2/8  Configuration & secrets"
  [ -f "$ENV_FILE" ] || { cp "$ENV_EXAMPLE" "$ENV_FILE"; chmod 600 "$ENV_FILE"; log "created .env from .env.example"; }
  cred_init

  # -- questions first, all in one place (real-time, before anything deploys) --
  local lan_ip; lan_ip=$(detect_lan_ip); lan_ip="${lan_ip:-127.0.0.1}"

  PUBLIC_HOST=$(get_env PUBLIC_HOST)
  PUBLIC_HOST=$(ask "Public hostname (or IP) for URLs and the TLS certificate:" "${PUBLIC_HOST:-$lan_ip}")
  set_env PUBLIC_HOST "$PUBLIC_HOST"

  local dns_addr; dns_addr=$(get_env DNS_LISTEN_ADDR)
  # 0.0.0.0 collides with systemd-resolved's 127.0.0.53:53 on most distros -
  # default to the LAN IP so bind9 can actually start.
  [ -z "$dns_addr" ] || [ "$dns_addr" = "0.0.0.0" ] && dns_addr="$lan_ip"
  dns_addr=$(ask "IP for BIND9 (DNS) to listen on:" "$dns_addr")
  set_env DNS_LISTEN_ADDR "$dns_addr"
  [ -z "$(get_env DNS_SERVER_IP_01)" ] && set_env DNS_SERVER_IP_01 "$lan_ip"

  if [ -z "$WITH_PROXY" ];    then WITH_PROXY=$(ask_yn "Deploy the nginx TLS reverse proxy (recommended)?" "y"); fi
  if [ -z "$WITH_KEYCLOAK" ]; then WITH_KEYCLOAK=$(ask_yn "Deploy Keycloak (optional OIDC / SSO)?" "n"); fi

  ADMIN_EMAIL=$(ask "First web UI administrator email:" "$ADMIN_EMAIL_DEFAULT")
  ADMIN_PW=$(cred_get WEBUI_ADMIN_PASSWORD)
  if [ -z "$ADMIN_PW" ]; then
    ADMIN_PW=$(ask_secret "First administrator password (blank = default ${ADMIN_PW_DEFAULT}):")
    ADMIN_PW="${ADMIN_PW:-$ADMIN_PW_DEFAULT}"
    cred_set WEBUI_ADMIN_EMAIL "$ADMIN_EMAIL"
    cred_set WEBUI_ADMIN_PASSWORD "$ADMIN_PW"
  fi

  # -- core stack secrets (generated once, always recorded) --
  if [ -z "$(get_env TACACS_KEY)" ]; then
    local k; k=$(openssl rand -hex 24); set_env TACACS_KEY "$k"; cred_set TACACS_KEY "$k"
    log "generated TACACS_KEY"
  fi
  if [ -z "$(get_env LOCAL_ADMIN_PW_HASH)" ]; then
    local p; p=$(ask_secret "Set the network_admin (TACACS) password (blank = generate):")
    [ -z "$p" ] && p=$(gen_pw)
    set_env LOCAL_ADMIN_PW_HASH "$(hash_pw "$p")"; cred_set NETWORK_ADMIN_PASSWORD "$p"
    log "network_admin password set (recorded in CREDENTIALS.md)"
  fi
  if [ -z "$(get_env LOCAL_READONLY_PW_HASH)" ]; then
    local p; p=$(ask_secret "Set the network_readonly (TACACS) password (blank = generate):")
    [ -z "$p" ] && p=$(gen_pw)
    set_env LOCAL_READONLY_PW_HASH "$(hash_pw "$p")"; cred_set NETWORK_READONLY_PASSWORD "$p"
    log "network_readonly password set (recorded in CREDENTIALS.md)"
  fi

  # -- Supabase secrets (needed BEFORE the frontend build bakes the anon key) --
  local jwt_secret; jwt_secret=$(cred_get JWT_SECRET)
  if [ -z "$jwt_secret" ]; then
    jwt_secret=$(openssl rand -hex 20)
    cred_set JWT_SECRET "$jwt_secret"
    cred_set POSTGRES_PASSWORD "$(gen_pw)"
    cred_set DASHBOARD_USERNAME "supabase"
    cred_set DASHBOARD_PASSWORD "$(gen_pw)"
    cred_set ANON_KEY "$(mk_supabase_jwt anon "$jwt_secret")"
    cred_set SERVICE_ROLE_KEY "$(mk_supabase_jwt service_role "$jwt_secret")"
    log "generated Supabase secrets (postgres, dashboard, JWT + API keys)"
  fi
  set_env VITE_SUPABASE_ANON_KEY "$(cred_get ANON_KEY)"
  # LAB ONLY: enables the Settings admin sections without a backend.
  set_env VITE_SUPABASE_SERVICE_ROLE_KEY "$(cred_get SERVICE_ROLE_KEY)"
  set_env AGENT_JWT_SECRET "$jwt_secret"

  chmod 600 "$ENV_FILE" "$CRED_FILE"
  log ".env ready; ALL credentials recorded in $CRED_FILE"
}

# ---- 3. network ------------------------------------------------------------
ensure_network() {
  step "3/8  Docker network"
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then log "network '$NETWORK' exists";
  else docker network create "$NETWORK" >/dev/null && log "created network '$NETWORK'"; fi
}

# ---- 4. Supabase (CORE) ----------------------------------------------------
setup_supabase() {
  step "4/8  Supabase (core: auth + MFA)"
  if [ ! -d "$SB_DIR" ]; then
    log "fetching self-hosted Supabase stack"
    local tmp; tmp=$(mktemp -d)
    git clone --depth 1 --quiet https://github.com/supabase/supabase "$tmp/supabase"
    cp -r "$tmp/supabase/docker" "$SB_DIR"; rm -rf "$tmp"
  else log "supabase directory exists ($SB_DIR)"; fi

  if [ ! -f "$SB_DIR/.env" ]; then
    umask 077; cp "$SB_DIR/.env.example" "$SB_DIR/.env"; chmod 600 "$SB_DIR/.env"
    set_kv "$SB_DIR/.env" POSTGRES_PASSWORD  "$(cred_get POSTGRES_PASSWORD)"
    set_kv "$SB_DIR/.env" JWT_SECRET         "$(cred_get JWT_SECRET)"
    set_kv "$SB_DIR/.env" ANON_KEY           "$(cred_get ANON_KEY)"
    set_kv "$SB_DIR/.env" SERVICE_ROLE_KEY   "$(cred_get SERVICE_ROLE_KEY)"
    set_kv "$SB_DIR/.env" DASHBOARD_PASSWORD "$(cred_get DASHBOARD_PASSWORD)"
    set_kv "$SB_DIR/.env" SITE_URL           "https://${PUBLIC_HOST}"
    set_kv "$SB_DIR/.env" SUPABASE_PUBLIC_URL "https://${PUBLIC_HOST}/supabase"
    set_kv "$SB_DIR/.env" API_EXTERNAL_URL   "https://${PUBLIC_HOST}/supabase/auth/v1"
    set_kv "$SB_DIR/.env" DISABLE_SIGNUP     "true"   # admins create users
    set_kv "$SB_DIR/.env" ENABLE_EMAIL_AUTOCONFIRM "true"
    log "supabase .env configured from recorded credentials"
  else log "supabase .env exists - keeping it"; fi

  # Kong must join soteria-net or the frontend's /supabase proxy 502s. The
  # stack layers overrides via COMPOSE_FILE in .env (run.sh manages it) - the
  # docker-compose.override.yml auto-include does NOT apply here.
  cat > "$SB_DIR/docker-compose.soteria-net.yml" <<'EOF'
# Attach Kong to the shared soteria-net so the Soteria frontend can proxy
# /supabase -> kong:8000. Registered in .env via: sh run.sh config add soteria-net
services:
  kong:
    networks:
      default: {}
      soteria-net: {}

networks:
  soteria-net:
    external: true
EOF
  grep -qE '^COMPOSE_FILE=.*soteria-net' "$SB_DIR/.env" || (cd "$SB_DIR" && sh run.sh config add soteria-net >/dev/null)

  # GoTrue <-> Keycloak wiring rides in a second override (only when chosen)
  if [ "$WITH_KEYCLOAK" = "1" ]; then
    [ -z "$(cred_get KEYCLOAK_CLIENT_SECRET)" ] && cred_set KEYCLOAK_CLIENT_SECRET "$(gen_pw)"
    cat > "$SB_DIR/docker-compose.soteria-keycloak.yml" <<EOF
# GoTrue external OIDC provider: Keycloak realm 'soteria', client 'soteria-frontend'.
services:
  auth:
    environment:
      GOTRUE_EXTERNAL_KEYCLOAK_ENABLED: "true"
      GOTRUE_EXTERNAL_KEYCLOAK_CLIENT_ID: "soteria-frontend"
      GOTRUE_EXTERNAL_KEYCLOAK_SECRET: "$(cred_get KEYCLOAK_CLIENT_SECRET)"
      GOTRUE_EXTERNAL_KEYCLOAK_REDIRECT_URI: "https://${PUBLIC_HOST}/supabase/auth/v1/callback"
      GOTRUE_EXTERNAL_KEYCLOAK_URL: "https://${PUBLIC_HOST}/keycloak/realms/soteria"
EOF
    grep -qE '^COMPOSE_FILE=.*soteria-keycloak' "$SB_DIR/.env" || (cd "$SB_DIR" && sh run.sh config add soteria-keycloak >/dev/null)
  fi

  log "starting Supabase (first run pulls ~10 images, this can take a while)"
  (cd "$SB_DIR" && sh run.sh start >/dev/null 2>&1 || docker compose up -d)

  local anon kong_port; anon=$(cred_get ANON_KEY); kong_port=$(get_kv "$SB_DIR/.env" KONG_HTTP_PORT); kong_port="${kong_port:-8000}"
  local i=0
  until curl -fsS -H "apikey: ${anon}" "http://localhost:${kong_port}/auth/v1/health" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -gt 60 ] && { err "Supabase did not become healthy in 3 min - check 'docker ps' / kong logs"; exit 1; }
    sleep 3
  done
  log "Supabase healthy (kong :${kong_port})"
}

# ---- 5. OpenBao (CORE) -----------------------------------------------------
setup_openbao() {
  step "5/8  OpenBao (core: secret storage)"
  mkdir -p "$OB_DIR/config"
  [ -f "$OB_DIR/config/openbao.hcl" ] || cat > "$OB_DIR/config/openbao.hcl" <<'EOF'
ui = true
api_addr = "http://openbao:8200"
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1   # internal soteria-net only; TLS terminates at the proxy
}
# /openbao/file is the image's canonical data path - its entrypoint chowns it
# for the openbao user before dropping privileges (a custom path stays root-owned
# and init fails with "permission denied").
storage "file" {
  path = "/openbao/file"
}
EOF
  [ -f "$OB_DIR/docker-compose.yml" ] || cat > "$OB_DIR/docker-compose.yml" <<'EOF'
services:
  openbao:
    image: openbao/openbao:latest
    container_name: openbao
    restart: unless-stopped
    # entrypoint chowns the data volume then drops privileges to the openbao user
    user: root
    command: server -config=/openbao/config/openbao.hcl
    cap_add: [IPC_LOCK]
    environment:
      BAO_ADDR: http://127.0.0.1:8200
    ports:
      - "8200:8200"
    volumes:
      - ./config:/openbao/config:ro
      - openbao-data:/openbao/file
    networks: [soteria-net]

volumes:
  openbao-data:

networks:
  soteria-net:
    external: true
EOF
  compose "$OB_DIR" up -d >/dev/null 2>&1
  sleep 3

  bao() { docker exec openbao bao "$@"; }
  local i=0
  until bao status >/dev/null 2>&1 || [ $? -eq 2 ]; do   # exit 2 = up but sealed
    i=$((i+1)); [ "$i" -gt 20 ] && { err "OpenBao did not come up - check 'docker logs openbao'"; exit 1; }
    sleep 3
  done

  # NOTE: capture status first - 'bao status' exits 2 while sealed, which with
  # pipefail would make 'bao status | grep' fail even when grep matches.
  local st; st=$(bao status 2>/dev/null || true)
  if echo "$st" | grep -qE '^Initialized\s+false'; then
    log "initialising OpenBao (1 unseal key share)"
    local out; out=$(bao operator init -key-shares=1 -key-threshold=1)
    cred_set OPENBAO_UNSEAL_KEY "$(echo "$out" | sed -n 's/^Unseal Key 1: //p')"
    cred_set OPENBAO_ROOT_TOKEN "$(echo "$out" | sed -n 's/^Initial Root Token: //p')"
    log "OpenBao initialised - unseal key + root token recorded in CREDENTIALS.md"
  fi
  st=$(bao status 2>/dev/null || true)
  if echo "$st" | grep -qE '^Sealed\s+true'; then
    bao operator unseal "$(cred_get OPENBAO_UNSEAL_KEY)" >/dev/null
    log "OpenBao unsealed"
  fi

  # helper for after host/container restarts (file storage starts sealed)
  cat > "$OB_DIR/unseal.sh" <<EOF
#!/usr/bin/env bash
# Unseal OpenBao after a restart using the key recorded at install time.
set -euo pipefail
KEY=\$(grep '^OPENBAO_UNSEAL_KEY=' "$CRED_FILE" | cut -d= -f2-)
docker exec openbao bao operator unseal "\$KEY"
EOF
  chmod 700 "$OB_DIR/unseal.sh"

  # KV engine + the stack's secrets (paths the frontend docs reference)
  local tok; tok=$(cred_get OPENBAO_ROOT_TOKEN)
  docker exec -e BAO_TOKEN="$tok" openbao bao secrets enable -path=soteria-app kv-v2 >/dev/null 2>&1 || true
  docker exec -e BAO_TOKEN="$tok" openbao bao kv put soteria-app/supabase \
      postgres_password="$(cred_get POSTGRES_PASSWORD)" \
      jwt_secret="$(cred_get JWT_SECRET)" \
      anon_key="$(cred_get ANON_KEY)" \
      service_role_key="$(cred_get SERVICE_ROLE_KEY)" \
      dashboard_username="supabase" \
      dashboard_password="$(cred_get DASHBOARD_PASSWORD)" >/dev/null
  docker exec -e BAO_TOKEN="$tok" openbao bao kv put soteria-app/frontend-admin \
      email="$(cred_get WEBUI_ADMIN_EMAIL)" \
      password="$(cred_get WEBUI_ADMIN_PASSWORD)" >/dev/null
  docker exec -e BAO_TOKEN="$tok" openbao bao kv put soteria-app/tacacs \
      tacacs_key="$(cred_get TACACS_KEY)" \
      network_admin_password="$(cred_get NETWORK_ADMIN_PASSWORD)" \
      network_readonly_password="$(cred_get NETWORK_READONLY_PASSWORD)" >/dev/null
  log "KV engine 'soteria-app' seeded (supabase, frontend-admin, tacacs)"
  warn "OpenBao starts SEALED after every restart - run ${OB_DIR}/unseal.sh"
}

# ---- 6. Keycloak (optional) ------------------------------------------------
setup_keycloak() {
  step "6/8  Keycloak (optional: OIDC / SSO)"
  if [ "$WITH_KEYCLOAK" != "1" ]; then warn "skipped (enable later with: sudo ./install.sh --with-keycloak --skip-prereqs --skip-build)"; return; fi

  [ -z "$(cred_get KEYCLOAK_ADMIN_PASSWORD)" ] && cred_set KEYCLOAK_ADMIN_PASSWORD "$(gen_pw)"
  mkdir -p "$KC_DIR"
  umask 077
  cat > "$KC_DIR/.env" <<EOF
KC_ADMIN_PASSWORD=$(cred_get KEYCLOAK_ADMIN_PASSWORD)
PUBLIC_HOST=${PUBLIC_HOST}
EOF
  chmod 600 "$KC_DIR/.env"
  [ -f "$KC_DIR/docker-compose.yml" ] || cat > "$KC_DIR/docker-compose.yml" <<'EOF'
services:
  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    container_name: keycloak
    restart: unless-stopped
    command: start-dev
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: ${KC_ADMIN_PASSWORD}
      KC_HTTP_RELATIVE_PATH: /keycloak
      KC_HTTP_ENABLED: "true"
      KC_PROXY_HEADERS: xforwarded
      KC_HOSTNAME: https://${PUBLIC_HOST}/keycloak
    volumes:
      - keycloak-data:/opt/keycloak/data
    networks: [soteria-net]

volumes:
  keycloak-data:

networks:
  soteria-net:
    external: true
EOF
  compose "$KC_DIR" up -d >/dev/null 2>&1

  kcadm() { docker exec keycloak /opt/keycloak/bin/kcadm.sh "$@"; }
  log "waiting for Keycloak to boot (can take ~1 min)"
  local i=0
  until kcadm config credentials --server http://localhost:8080/keycloak --realm master \
        --user admin --password "$(cred_get KEYCLOAK_ADMIN_PASSWORD)" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -gt 40 ] && { warn "Keycloak not ready - realm/client NOT bootstrapped; re-run later with --with-keycloak"; return; }
    sleep 5
  done
  if ! kcadm get realms/soteria >/dev/null 2>&1; then
    kcadm create realms -s realm=soteria -s enabled=true >/dev/null
    log "created realm 'soteria'"
  fi
  if ! kcadm get clients -r soteria -q clientId=soteria-frontend 2>/dev/null | grep -q soteria-frontend; then
    kcadm create clients -r soteria \
      -s clientId=soteria-frontend -s enabled=true -s protocol=openid-connect \
      -s publicClient=false -s secret="$(cred_get KEYCLOAK_CLIENT_SECRET)" \
      -s "redirectUris=[\"https://${PUBLIC_HOST}/supabase/auth/v1/callback\"]" >/dev/null
    log "created client 'soteria-frontend'"
  fi
  log "Keycloak ready (admin console: https://${PUBLIC_HOST}/keycloak/ user 'admin', password in CREDENTIALS.md)"
  warn "Enable the SSO method in the web UI (Settings -> Authentication) to show the login button"
}

# ---- 7. core stack + optional TLS proxy ------------------------------------
build_up() {
  step "7/8  Core stack (tac_plus-ng, agent, frontend, BIND9) + TLS proxy"
  if [ "$SKIP_BUILD" -eq 1 ]; then warn "skipping core build (--skip-build)"
  else
    (cd "$REPO_DIR" && docker compose --env-file .env up -d --build)
    log "core stack started"
  fi

  if [ "$WITH_PROXY" = "1" ]; then
    mkdir -p "$PX_DIR/certs"
    if [ ! -f "$PX_DIR/certs/soteria.lab.crt" ]; then
      local lan_ip san; lan_ip=$(detect_lan_ip)
      if echo "$PUBLIC_HOST" | grep -qE '^[0-9.]+$'; then san="IP:${PUBLIC_HOST}"
      else san="DNS:${PUBLIC_HOST},DNS:*.${PUBLIC_HOST}"; fi
      [ -n "$lan_ip" ] && [ "$lan_ip" != "$PUBLIC_HOST" ] && san="${san},IP:${lan_ip}"
      openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
        -keyout "$PX_DIR/certs/soteria.lab.key" -out "$PX_DIR/certs/soteria.lab.crt" \
        -subj "/CN=${PUBLIC_HOST}/O=Pathfinder Insights Lab" \
        -addext "subjectAltName=${san}" 2>/dev/null
      chmod 600 "$PX_DIR/certs/soteria.lab.key"
      log "generated self-signed TLS cert (SAN: ${san}) - trust ${PX_DIR}/certs/soteria.lab.crt on your PC"
    fi
    [ -f "$PX_DIR/nginx.conf" ] || cat > "$PX_DIR/nginx.conf" <<EOF
# TLS-terminating reverse proxy for the Soteria stack. The frontend is the
# single origin and same-origin-proxies /agent, /supabase and /keycloak itself.
server {
    listen 80;
    server_name ${PUBLIC_HOST} *.${PUBLIC_HOST};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name ${PUBLIC_HOST} *.${PUBLIC_HOST};

    ssl_certificate     /etc/nginx/certs/soteria.lab.crt;
    ssl_certificate_key /etc/nginx/certs/soteria.lab.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 50m;

    location / {
        proxy_pass http://soteria-frontend:80;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
EOF
    [ -f "$PX_DIR/docker-compose.yml" ] || cat > "$PX_DIR/docker-compose.yml" <<'EOF'
services:
  nginx:
    image: nginx:alpine
    container_name: soteria-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./certs:/etc/nginx/certs:ro
    networks: [soteria-net]

networks:
  soteria-net:
    external: true
EOF
    compose "$PX_DIR" up -d >/dev/null 2>&1
    log "nginx TLS proxy up (https://${PUBLIC_HOST}/)"
  else
    warn "TLS proxy skipped - the frontend is plain HTTP on :8080 (do not expose it)"
  fi
}

# ---- 8. first-run bootstrap + health ---------------------------------------
bootstrap() {
  step "8/8  First-run bootstrap & health"

  # web UI tables (the repo ships no migrations; the app expects these)
  docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create table if not exists public.web_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists public.auth_settings (
  method text primary key,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
grant usage on schema public to service_role;
grant all on public.web_roles, public.auth_settings to service_role;
notify pgrst, 'reload schema';
SQL
  log "web UI tables ready (web_roles, auth_settings)"

  # First administrator. Created WITH app_metadata.role=admin - without it the
  # account can sign in but has no rights anywhere in the UI.
  local srk kong_port code
  srk=$(cred_get SERVICE_ROLE_KEY)
  kong_port=$(get_kv "$SB_DIR/.env" KONG_HTTP_PORT); kong_port="${kong_port:-8000}"
  code=$(curl -s -o /tmp/soteria-admin-create.json -w '%{http_code}' \
    -X POST "http://localhost:${kong_port}/auth/v1/admin/users" \
    -H "apikey: ${srk}" -H "Authorization: Bearer ${srk}" -H "Content-Type: application/json" \
    -d "{\"email\":\"$(cred_get WEBUI_ADMIN_EMAIL)\",\"password\":\"$(cred_get WEBUI_ADMIN_PASSWORD)\",\"email_confirm\":true,\"app_metadata\":{\"role\":\"admin\",\"group\":\"Administrator\"}}")
  case "$code" in
    200|201)
      log "created first administrator: $(cred_get WEBUI_ADMIN_EMAIL)"
      [ "$(cred_get WEBUI_ADMIN_PASSWORD)" = "$ADMIN_PW_DEFAULT" ] && \
        warn "password is the DEFAULT ${ADMIN_PW_DEFAULT} - change it after first login!"
      ;;
    422)
      log "administrator $(cred_get WEBUI_ADMIN_EMAIL) already exists - ensuring admin role"
      if have python3; then
        local uid
        uid=$(curl -fsS "http://localhost:${kong_port}/auth/v1/admin/users?per_page=200" \
                -H "apikey: ${srk}" -H "Authorization: Bearer ${srk}" \
              | python3 -c "import json,sys; email='$(cred_get WEBUI_ADMIN_EMAIL)'; users=json.load(sys.stdin).get('users',[]); print(next((u['id'] for u in users if u.get('email')==email),''))")
        [ -n "$uid" ] && curl -fsS -X PUT "http://localhost:${kong_port}/auth/v1/admin/users/${uid}" \
            -H "apikey: ${srk}" -H "Authorization: Bearer ${srk}" -H "Content-Type: application/json" \
            -d '{"app_metadata":{"role":"admin","group":"Administrator"}}' >/dev/null && log "admin role confirmed"
      fi
      ;;
    *) warn "could not create the administrator (HTTP ${code}) - see /tmp/soteria-admin-create.json" ;;
  esac
  rm -f /tmp/soteria-admin-create.json

  # health
  sleep 3
  local ap fp; ap="$(get_env AGENT_LISTEN_PORT)"; ap="${ap:-8081}"; fp="$(get_env FRONTEND_LISTEN_PORT)"; fp="${fp:-8080}"
  if curl -fsS "http://localhost:${ap}/ready" >/dev/null 2>&1; then log "agent /ready OK (:$ap)"; else warn "agent /ready not responding yet (:$ap)"; fi
  docker ps --format '  {{.Names}}\t{{.Status}}' | grep -E 'soteria|bind9|supabase-kong|openbao|keycloak' || true

  echo ""
  echo -e "${c_b}Done.${c_0}"
  log "Web UI:        https://${PUBLIC_HOST}/  ->  $(cred_get WEBUI_ADMIN_EMAIL) (MFA enrollment on first login)"
  log "OpenBao UI:    http://${PUBLIC_HOST}:8200/  (root token in CREDENTIALS.md)"
  [ "$WITH_KEYCLOAK" = "1" ] && log "Keycloak:      https://${PUBLIC_HOST}/keycloak/  (admin console)"
  log "ALL credentials: ${CRED_FILE}  (chmod 600 - back it up somewhere safe)"
}

main() {
  echo -e "${c_b}Soteria TACACS+ installer${c_0}  (repo: $REPO_DIR, deps: $DEPS_DIR)"
  install_prereqs
  setup_env
  ensure_network
  setup_supabase
  setup_openbao
  setup_keycloak
  build_up
  bootstrap
}
main "$@"
