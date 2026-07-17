#!/bin/bash
# =============================================================================
# entrypoint.sh - Soteria TACACS+ Server Entrypoint
# =============================================================================
# Company:    Pathfinder Insights
# Engineer:   MotoMotoFan
# Project:    Soteria AAA Infrastructure
# =============================================================================

set -eE
trap 'echo "[ENTRYPOINT] Script failed at line $LINENO with exit code $?" >&2' ERR

CONFIG_DIR="/etc/tac_plus-ng"
CONFD_DIR="${CONFIG_DIR}/conf.d"
LOG_DIR="/var/log/tac_plus"
PROCESS_LOG="${LOG_DIR}/tac_plus-ng.log"
TACACS_BIN="/usr/local/sbin/tac_plus-ng"
TACACS_CFG="${CONFIG_DIR}/tac_plus-ng.cfg"

# =============================================================================
# Functions
# =============================================================================

log() {
    local msg="[$(date '+%Y-%m-%dT%H:%M:%S%z')] [ENTRYPOINT] $1"
    echo "$msg" | tee -a "${PROCESS_LOG}"
}

die() {
    local msg="[$(date '+%Y-%m-%dT%H:%M:%S%z')] [ENTRYPOINT] ERROR: $1"
    echo "$msg" | tee -a "${PROCESS_LOG}" >&2
    exit 1
}

# -----------------------------------------------------------------------------
# Enable TLS listener and config when ENABLE_TLS=true
# Uncomments the TLS listen block in spawnd and the TLS include
# -----------------------------------------------------------------------------
configure_tls() {
    if [ "${ENABLE_TLS:-false}" = "true" ]; then
        log "TLS is enabled - activating TLS listener and config..."

        # Verify certificate files exist
        local tls_dir="/etc/tac_plus-ng/tls"
        local missing=0
        for cert_file in server.crt server.key ca.crt; do
            if [ ! -f "${tls_dir}/${cert_file}" ]; then
                log "ERROR: TLS enabled but ${tls_dir}/${cert_file} not found."
                missing=$((missing + 1))
            fi
        done
        [ "$missing" -gt 0 ] && die "Missing ${missing} TLS certificate file(s). Mount them to ${tls_dir}/."

        # Enforce strict permissions on TLS key
        chmod 600 "${tls_dir}/server.key"
        log "  TLS key permissions set to 600."

        # Uncomment TLS listen block in main config
        sed -i 's|^    # listen = {$|    listen = {|' "${TACACS_CFG}"
        sed -i 's|^    #     address = 0.0.0.0$|        address = 0.0.0.0|' "${TACACS_CFG}"
        sed -i 's|^    #     port = 300$|        port = 300|' "${TACACS_CFG}"
        sed -i 's|^    #     tls = yes$|        tls = yes|' "${TACACS_CFG}"
        sed -i 's|^    # }$|    }|' "${TACACS_CFG}"

        # Uncomment TLS config include
        sed -i 's|^    # include = /etc/tac_plus-ng/conf.d/09-tls.cfg$|    include = /etc/tac_plus-ng/conf.d/09-tls.cfg|' "${TACACS_CFG}"

        log "  TLS listener on port 300 activated."
        log "  TLS config 09-tls.cfg included."
    else
        log "TLS is disabled (ENABLE_TLS=${ENABLE_TLS:-false})."
    fi
}

# -----------------------------------------------------------------------------
# Validate required environment variables
# Core vars are always required. LDAP vars only when ENABLE_LDAP=true.
# -----------------------------------------------------------------------------
validate_env() {
    log "Validating environment variables..."

    local required_vars=(
        TACACS_KEY
        LOCAL_ADMIN_PW_HASH
        LOCAL_READONLY_PW_HASH
    )

    local missing=0
    for var in "${required_vars[@]}"; do
        if [ -z "${!var}" ]; then
            log "ERROR: Required variable ${var} is not set."
            missing=$((missing + 1))
        fi
    done

    # Validate LDAP variables only when LDAP is enabled
    if [ "${ENABLE_LDAP:-false}" = "true" ]; then
        local ldap_vars=(
            LDAP_HOSTS
            LDAP_USER
            LDAP_PASSWD
            LDAP_BASE
            LDAP_BASE_GROUP
        )
        for var in "${ldap_vars[@]}"; do
            if [ -z "${!var}" ]; then
                log "ERROR: LDAP is enabled but ${var} is not set."
                missing=$((missing + 1))
            fi
        done
    fi

    [ "$missing" -gt 0 ] && die "Missing ${missing} required environment variable(s). Aborting."
    log "All required environment variables are set."
}

# -----------------------------------------------------------------------------
# Enable LDAP/MAVIS backend when ENABLE_LDAP=true
# Uncomments the MAVIS include in the main config
# -----------------------------------------------------------------------------
configure_ldap() {
    if [ "${ENABLE_LDAP:-false}" = "true" ]; then
        log "LDAP is enabled - activating MAVIS backend..."

        # Uncomment MAVIS config include
        sed -i 's|^    # include = /etc/tac_plus-ng/conf.d/03-mavis.cfg$|    include = /etc/tac_plus-ng/conf.d/03-mavis.cfg|' "${TACACS_CFG}"

        log "  MAVIS/LDAP backend activated (03-mavis.cfg included)."
        log "  Authentication: LDAP with local fallback."
    else
        log "LDAP is disabled (ENABLE_LDAP=${ENABLE_LDAP:-false})."
        log "  Authentication: local users only (05-local-users.cfg)."
    fi
}

# -----------------------------------------------------------------------------
# Configure DNS when DNS_SERVER_IP_01 is set
# -----------------------------------------------------------------------------
configure_dns() {
    local dns_cfg="${CONFD_DIR}/02-dns.cfg"
    if [ -n "${DNS_SERVER_IP_01:-}" ]; then
        log "DNS configured: ${DNS_SERVER_IP_01}"
        sed -i "s|^# DNS_PLACEHOLDER.*|dns servers = \"${DNS_SERVER_IP_01}\"|" "$dns_cfg"
    else
        log "DNS not configured - using system defaults."
    fi
}

# -----------------------------------------------------------------------------
# Inject environment variables into config files
# -----------------------------------------------------------------------------
inject_env() {
    log "Injecting environment variables into configuration files..."

    # CRITICAL: Only substitute known variables to avoid destroying
    # SHA-512 password hashes ($6$...) and other dollar-sign content
    local env_vars='${TACACS_KEY}'
    env_vars+=' ${LOCAL_ADMIN_PW_HASH}'
    env_vars+=' ${LOCAL_READONLY_PW_HASH}'
    env_vars+=' ${LDAP_SERVER_TYPE}'
    env_vars+=' ${LDAP_HOSTS}'
    env_vars+=' ${LDAP_USER}'
    env_vars+=' ${LDAP_PASSWD}'
    env_vars+=' ${LDAP_BASE}'
    env_vars+=' ${LDAP_SCOPE}'
    env_vars+=' ${LDAP_FILTER}'
    env_vars+=' ${LDAP_BASE_GROUP}'
    env_vars+=' ${LDAP_SCOPE_GROUP}'
    env_vars+=' ${LDAP_FILTER_GROUP}'
    env_vars+=' ${LDAP_CONNECT_TIMEOUT}'
    env_vars+=' ${LDAP_TACMEMBER}'

    local files=(
        "${TACACS_CFG}"
        "${CONFD_DIR}/01-logging.cfg"
        "${CONFD_DIR}/02-dns.cfg"
        "${CONFD_DIR}/03-mavis.cfg"
        "${CONFD_DIR}/04-devices.cfg"
        "${CONFD_DIR}/05-local-users.cfg"
        "${CONFD_DIR}/06-groups.cfg"
        "${CONFD_DIR}/07-profiles.cfg"
        "${CONFD_DIR}/08-ruleset.cfg"
    )

    for file in "${files[@]}"; do
        if [ -f "$file" ]; then
            envsubst "$env_vars" < "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
            log "  Processed: ${file}"
        else
            die "Config file not found: ${file}"
        fi
    done

    log "Environment variable injection complete."
}

# -----------------------------------------------------------------------------
# Create log directory structure
# -----------------------------------------------------------------------------
setup_log_dirs() {
    log "Setting up log directory structure..."

    local year
    local month
    year=$(date '+%Y')
    month=$(date '+%m')

    mkdir -p "${LOG_DIR}/authorization/${year}/${month}"
    mkdir -p "${LOG_DIR}/accounting/${year}/${month}"
    mkdir -p "${LOG_DIR}/authentication/${year}/${month}"
    mkdir -p "${LOG_DIR}/archive/authorization"
    mkdir -p "${LOG_DIR}/archive/accounting"
    mkdir -p "${LOG_DIR}/archive/authentication"
    mkdir -p /tmp/tacinfo

    log "Log directories ready."
}

# -----------------------------------------------------------------------------
# Validate tac_plus-ng configuration syntax
# -----------------------------------------------------------------------------
validate_config() {
    log "Validating tac_plus-ng configuration syntax..."
    log "Running: ${TACACS_BIN} -P ${TACACS_CFG}"
    "${TACACS_BIN}" -P "${TACACS_CFG}" 2>&1 | tee -a "${PROCESS_LOG}" || true
    local exit_code=${PIPESTATUS[0]}
    if [ "$exit_code" -ne 0 ]; then
        log "Validation exited with code: ${exit_code}"
        log "--- Dumping processed config files ---"
        for f in "${TACACS_CFG}" "${CONFD_DIR}"/*.cfg; do
            echo "=== ${f} ===" | tee -a "${PROCESS_LOG}"
            cat "$f" | tee -a "${PROCESS_LOG}"
        done
        die "Configuration validation failed (exit code: ${exit_code})."
    fi
    log "Configuration syntax is valid."
}

# -----------------------------------------------------------------------------
# Start cron for logrotate and monthly archiving
# Controlled by environment variables:
#   ENABLE_LOGROTATE=true/false       (default: true)
#   ENABLE_MONTHLY_ARCHIVE=true/false (default: true)
# Set to false when shipping logs to an external syslog collector
# -----------------------------------------------------------------------------
start_cron() {
    log "Configuring cron jobs..."

    local cron_enabled=false

    # Clear existing jobs first so a disable (from overrides) actually removes
    # them on restart, not just skips re-creating.
    rm -f /etc/cron.d/soteria-logrotate /etc/cron.d/soteria-monthly-archive

    # Weekly logrotate for process log
    if [ "${ENABLE_LOGROTATE:-true}" = "true" ]; then
        echo "0 0 * * 0 logrotate /etc/logrotate.d/tac_plus-ng >> ${PROCESS_LOG} 2>&1" > /etc/cron.d/soteria-logrotate
        chmod 0644 /etc/cron.d/soteria-logrotate
        log "  Logrotate cron job enabled."
        cron_enabled=true
    else
        log "  Logrotate cron job disabled (ENABLE_LOGROTATE=false)."
    fi

    # Monthly archive on the 1st of every month at 00:30
    if [ "${ENABLE_MONTHLY_ARCHIVE:-true}" = "true" ]; then
        echo "30 0 1 * * /usr/local/bin/monthly-archive.sh" > /etc/cron.d/soteria-monthly-archive
        chmod 0644 /etc/cron.d/soteria-monthly-archive
        log "  Monthly archive cron job enabled."
        cron_enabled=true
    else
        log "  Monthly archive cron job disabled (ENABLE_MONTHLY_ARCHIVE=false)."
    fi

    # Only start cron daemon if at least one job is enabled
    if [ "${cron_enabled}" = "true" ]; then
        cron >> "${PROCESS_LOG}" 2>&1
        log "Cron started."
    else
        log "No cron jobs enabled - cron daemon not started."
    fi
}

# -----------------------------------------------------------------------------
# Signal handler - reload tac_plus-ng on SIGHUP
# -----------------------------------------------------------------------------
handle_sighup() {
    log "Received SIGHUP - reloading tac_plus-ng configuration..."
    kill -HUP "$TACACS_PID" 2>/dev/null || log "WARNING: Could not send SIGHUP to tac_plus-ng."
}

# =============================================================================
# Main
# =============================================================================

# Ensure log directory and process log file exist before anything else
mkdir -p "${LOG_DIR}"
touch "${PROCESS_LOG}"

# Populate config volume from defaults on first run
# When using the agent, config is managed by the cloud control plane
if [ ! -f "${TACACS_CFG}" ]; then
    log "Config volume is empty - copying defaults..."
    mkdir -p "${CONFD_DIR}"
    cp -a /etc/tac_plus-ng-defaults/. "${CONFIG_DIR}/"
    log "Default configuration copied to ${CONFIG_DIR}"
fi

log "============================================"
log "Soteria TACACS+ Server - Pathfinder Insights"
log "============================================"

# -----------------------------------------------------------------------------
# Runtime overrides managed by soteria-agent (persisted in the config volume).
# Lets the web UI change TZ / log rotation via a config file + container
# restart, without recreating the container. .env only seeds the first deploy.
# -----------------------------------------------------------------------------
OVERRIDES="${CONFIG_DIR}/agent-overrides.env"
if [ -f "${OVERRIDES}" ]; then
    log "Loading agent runtime overrides from ${OVERRIDES}"
    set -a; . "${OVERRIDES}"; set +a
    if [ -n "${TZ:-}" ] && [ -f "/usr/share/zoneinfo/${TZ}" ]; then
        ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime
        echo "${TZ}" > /etc/timezone
        log "  Timezone set to ${TZ}"
    fi
fi

validate_env
inject_env
configure_dns
configure_ldap
configure_tls
setup_log_dirs
validate_config
start_cron

# Trap SIGHUP to reload config without restarting the container
trap handle_sighup SIGHUP

log "Launching tac_plus-ng..."
"${TACACS_BIN}" "${TACACS_CFG}" >> "${PROCESS_LOG}" 2>&1 &
TACACS_PID=$!

log "tac_plus-ng running with PID ${TACACS_PID}"
log "============================================"

# Wait and keep container alive - exit only when tac_plus-ng actually dies.
# A trapped SIGHUP interrupts the bash 'wait' builtin with status 129
# (128+SIGHUP) even though the daemon is still running, so loop until the
# process is really gone. The '||' also keeps set -e / the ERR trap from
# treating the signal interruption as a fatal error.
EXIT_CODE=0
while :; do
    wait "$TACACS_PID" && EXIT_CODE=0 || EXIT_CODE=$?
    if ! kill -0 "$TACACS_PID" 2>/dev/null; then
        break
    fi
done

log "tac_plus-ng exited with code ${EXIT_CODE}"
exit "$EXIT_CODE"
