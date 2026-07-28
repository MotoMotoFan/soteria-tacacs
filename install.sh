#!/usr/bin/env bash
# =============================================================================
# install.sh - Soteria TACACS+ full-stack installer
# =============================================================================
# Company:    Pathfinder Insights
# Engineer:   MotoMotoFan
# Project:    Soteria AAA Infrastructure
# =============================================================================
# Step-by-step, idempotent installer for a Linux host (apt or dnf based). It:
#   1. installs prerequisites (Docker Engine + Compose plugin, openssl, curl, git)
#   2. generates all secrets into .env (nothing secret is committed)
#   3. creates the shared docker network
#   4. checks / guides the dependencies (Supabase, Keycloak, OpenBao)
#   5. builds and starts the core stack (tac_plus-ng, agent, frontend, BIND9)
#   6. runs post-install health checks
#
# Re-run safe. Usage:
#   sudo ./install.sh                 # interactive
#   sudo ./install.sh --non-interactive   # use existing .env, don't prompt
#   sudo ./install.sh --skip-prereqs      # assume Docker/openssl already present
#   sudo ./install.sh --skip-build        # set up .env + deps only
# =============================================================================
set -euo pipefail

# ---- config ----------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${REPO_DIR}/.env"
ENV_EXAMPLE="${REPO_DIR}/.env.example"
NETWORK="soteria-net"
INTERACTIVE=1; SKIP_PREREQS=0; SKIP_BUILD=0
for a in "$@"; do case "$a" in
  --non-interactive) INTERACTIVE=0 ;;
  --skip-prereqs)    SKIP_PREREQS=1 ;;
  --skip-build)      SKIP_BUILD=1 ;;
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
  read -r -p "$p ${d:+[$d] }" a || true; echo "${a:-$d}"
}
ask_secret() { # ask_secret "Prompt" -> echoes typed value (hidden)
  local p="$1" a
  if [ "$INTERACTIVE" -eq 0 ]; then echo ""; return; fi
  read -r -s -p "$p " a || true; echo >&2; echo "$a"
}
SUDO=""; [ "$(id -u)" -ne 0 ] && have sudo && SUDO="sudo"

# ---- 1. prerequisites ------------------------------------------------------
install_prereqs() {
  step "1/6  Prerequisites"
  if [ "$SKIP_PREREQS" -eq 1 ]; then warn "skipping prereqs (--skip-prereqs)"; return; fi

  local pkgmgr=""
  if have apt-get; then pkgmgr=apt; elif have dnf; then pkgmgr=dnf; elif have yum; then pkgmgr=yum; fi
  [ -z "$pkgmgr" ] && { err "unsupported distro (need apt or dnf/yum). Install Docker + openssl manually."; exit 1; }

  # base tools
  case "$pkgmgr" in
    apt) $SUDO apt-get update -qq; $SUDO apt-get install -y -qq ca-certificates curl gnupg git openssl netcat-openbsd >/dev/null ;;
    dnf|yum) $SUDO "$pkgmgr" install -y -q curl git openssl nmap-ncat ca-certificates >/dev/null ;;
  esac
  log "base tools present (curl, git, openssl)"

  # Docker Engine + Compose plugin
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

  # let the invoking user run docker without sudo (takes effect on next login)
  if [ -n "${SUDO}" ] && ! groups "$USER" 2>/dev/null | grep -qw docker; then
    $SUDO usermod -aG docker "$USER" || true
    warn "added $USER to the 'docker' group - log out/in for it to take effect (this run uses sudo)"
  fi
}

# ---- 2. secrets / .env -----------------------------------------------------
gen_key() { openssl rand -hex 24; }
# $ must be written as $$ in .env: docker compose interpolates $VAR sequences
# inside values, which would silently mangle SHA-512 crypt hashes.
hash_pw() { openssl passwd -6 "$1" | sed -e 's/\$/$$/g'; }
set_env() { # set_env KEY VALUE  (idempotent in-place update of .env)
  local k="$1" v="$2"
  if grep -qE "^${k}=" "$ENV_FILE"; then
    # escape / and & for sed replacement
    local ev; ev=$(printf '%s' "$v" | sed -e 's/[\/&]/\\&/g')
    sed -i "s/^${k}=.*/${k}=${ev}/" "$ENV_FILE"
  else echo "${k}=${v}" >> "$ENV_FILE"; fi
}
get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- ; }

setup_env() {
  step "2/6  Configuration & secrets (.env)"
  [ -f "$ENV_FILE" ] || { cp "$ENV_EXAMPLE" "$ENV_FILE"; chmod 600 "$ENV_FILE"; log "created .env from .env.example"; }

  # TACACS shared key
  if [ -z "$(get_env TACACS_KEY)" ]; then
    local k; k=$(gen_key); set_env TACACS_KEY "$k"; log "generated TACACS_KEY"
  fi

  # seed local user password hashes
  if [ -z "$(get_env LOCAL_ADMIN_PW_HASH)" ]; then
    local p; p=$(ask_secret "Set the network_admin password:")
    [ -z "$p" ] && { p=$(gen_key); warn "no password entered; generated a random one (see below)"; echo "  network_admin password: $p"; }
    set_env LOCAL_ADMIN_PW_HASH "$(hash_pw "$p")"; log "hashed network_admin password"
  fi
  if [ -z "$(get_env LOCAL_READONLY_PW_HASH)" ]; then
    local p; p=$(ask_secret "Set the network_readonly password:")
    [ -z "$p" ] && { p=$(gen_key); warn "no password entered; generated a random one (see below)"; echo "  network_readonly password: $p"; }
    set_env LOCAL_READONLY_PW_HASH "$(hash_pw "$p")"; log "hashed network_readonly password"
  fi

  # Supabase anon key (public) + JWKS URL for the agent to verify tokens
  if [ -z "$(get_env VITE_SUPABASE_ANON_KEY)" ] && [ "$INTERACTIVE" -eq 1 ]; then
    local ak; ak=$(ask "Supabase anon (public) key (blank to set later):" "")
    [ -n "$ak" ] && set_env VITE_SUPABASE_ANON_KEY "$ak"
  fi
  if [ -z "$(get_env AGENT_JWKS_URL)" ] && [ "$INTERACTIVE" -eq 1 ]; then
    local j; j=$(ask "Supabase JWKS URL for the agent (e.g. https://host/supabase/auth/v1/.well-known/jwks.json), blank=lab no-auth:" "")
    [ -n "$j" ] && set_env AGENT_JWKS_URL "$j"
  fi

  chmod 600 "$ENV_FILE"
  log ".env ready (secrets are local only; .env is gitignored)"
}

# ---- 3. network ------------------------------------------------------------
ensure_network() {
  step "3/6  Docker network"
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then log "network '$NETWORK' exists";
  else docker network create "$NETWORK" >/dev/null && log "created network '$NETWORK'"; fi
}

# ---- 4. dependencies -------------------------------------------------------
check_dep() { # check_dep name host:port
  local name="$1" hp="$2" h p; h="${hp%%:*}"; p="${hp##*:}"
  if docker ps --format '{{.Names}}' | grep -qiw "$name" 2>/dev/null; then
    log "dependency '$name' appears to be running"; return 0
  fi
  warn "dependency '$name' not detected"
  return 1
}
setup_deps() {
  step "4/6  Dependencies (Supabase, Keycloak, OpenBao)"
  echo "These are stood up from upstream on the '$NETWORK' network. Full config: docs/dependencies.md"
  local missing=0
  check_dep supabase-kong "kong:8000"  || missing=1
  check_dep keycloak      "keycloak:8080" || missing=1
  check_dep openbao       "openbao:8200" || missing=1
  if [ "$missing" -eq 1 ]; then
    warn "One or more dependencies are not running."
    warn "Bring them up per docs/dependencies.md, joining network '$NETWORK', then re-run with --skip-prereqs."
    warn "Login/auth will not work until Supabase (and, for SSO, Keycloak) are reachable."
  else
    log "all dependencies detected"
  fi
}

# ---- 5. build & up ---------------------------------------------------------
build_up() {
  step "5/6  Build & start the core stack"
  if [ "$SKIP_BUILD" -eq 1 ]; then warn "skipping build (--skip-build)"; return; fi
  ( cd "$REPO_DIR" && docker compose --env-file .env up -d --build )
  log "core stack started"
}

# ---- 6. health -------------------------------------------------------------
healthcheck() {
  step "6/6  Health checks"
  sleep 5
  local ap; ap="$(get_env AGENT_LISTEN_PORT)"; ap="${ap:-8081}"
  local fp; fp="$(get_env FRONTEND_LISTEN_PORT)"; fp="${fp:-8080}"
  if curl -fsS "http://localhost:${ap}/ready" >/dev/null 2>&1; then log "agent /ready OK (:$ap)"; else warn "agent /ready not responding yet (:$ap) - check 'docker compose logs soteria-agent'"; fi
  docker ps --format '  {{.Names}}\t{{.Status}}' | grep -E 'soteria|bind9' || true
  echo ""
  log "Frontend:  http://localhost:${fp}/   (put a TLS reverse proxy in front for production)"
  log "Agent API: http://localhost:${ap}/"
  echo -e "\n${c_b}Done.${c_0} Next: complete Supabase/Keycloak setup (docs/dependencies.md) and sign in."
}

main() {
  echo -e "${c_b}Soteria TACACS+ installer${c_0}  (repo: $REPO_DIR)"
  install_prereqs
  setup_env
  ensure_network
  setup_deps
  build_up
  healthcheck
}
main "$@"
