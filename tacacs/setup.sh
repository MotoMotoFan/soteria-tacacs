#!/bin/bash
# =============================================================================
# setup.sh - Soteria TACACS+ Server Environment Setup
# =============================================================================
# Company:    Pathfinder Insights
# Engineer:   MotoMotoFan
# Project:    Soteria AAA Infrastructure
# =============================================================================
# Prepares a fresh Ubuntu/Debian host for Soteria:
#   1. Installs Docker Engine + Compose plugin (if missing)
#   2. Prompts for required environment variables
#   3. Opens editor for optional variable tuning
#   4. Builds the Docker image
#   5. Prints the command to create and start a container
#
# Usage:
#   chmod +x setup.sh
#   sudo ./setup.sh
# =============================================================================

set -e

# =============================================================================
# Constants
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
ENV_EXAMPLE="${SCRIPT_DIR}/.env.example"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
IMAGE_NAME="soteria-tacacs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# =============================================================================
# Functions
# =============================================================================

banner() {
    echo ""
    echo -e "${CYAN}${BOLD}"
    echo "  ╔═══════════════════════════════════════════════════════════╗"
    echo "  ║                                                           ║"
    echo "  ║              Soteria TACACS+ Server Setup                 ║"
    echo "  ║                   Pathfinder Insights                     ║"
    echo "  ║                                                           ║"
    echo "  ╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo ""
    echo -e "${CYAN}${BOLD}── $1 ──${NC}"
    echo ""
}

# -----------------------------------------------------------------------------
# Check if running as root
# -----------------------------------------------------------------------------
check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "This script must be run as root (sudo ./setup.sh)"
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# Check distro is Ubuntu/Debian
# -----------------------------------------------------------------------------
check_distro() {
    if [ ! -f /etc/os-release ]; then
        log_error "Cannot detect OS. This script supports Ubuntu/Debian only."
        exit 1
    fi

    . /etc/os-release

    case "$ID" in
        ubuntu|debian)
            log_info "Detected: ${PRETTY_NAME}"
            ;;
        *)
            log_error "Unsupported distribution: ${PRETTY_NAME}"
            log_error "This script supports Ubuntu and Debian only."
            exit 1
            ;;
    esac
}

# -----------------------------------------------------------------------------
# Install Docker Engine + Compose plugin
# -----------------------------------------------------------------------------
install_docker() {
    log_step "Step 1/5 — Docker Engine + Compose"

    # Check if Docker is already installed
    if command -v docker &> /dev/null; then
        local docker_version
        docker_version=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')
        log_info "Docker is already installed (${docker_version})"
    else
        log_info "Docker not found. Installing Docker Engine..."

        # Install prerequisites
        apt-get update -qq
        apt-get install -y -qq \
            ca-certificates \
            curl \
            gnupg \
            lsb-release > /dev/null

        # Add Docker GPG key
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
            | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg

        # Add Docker repository
        echo \
            "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
            https://download.docker.com/linux/${ID} \
            $(lsb_release -cs) stable" \
            | tee /etc/apt/sources.list.d/docker.list > /dev/null

        # Install Docker
        apt-get update -qq
        apt-get install -y -qq \
            docker-ce \
            docker-ce-cli \
            containerd.io > /dev/null

        log_info "Docker Engine installed successfully."
    fi

    # Check if Compose plugin is installed
    if docker compose version &> /dev/null; then
        local compose_version
        compose_version=$(docker compose version --short 2>/dev/null)
        log_info "Docker Compose is already installed (${compose_version})"
    else
        log_info "Docker Compose plugin not found. Installing..."

        apt-get update -qq
        apt-get install -y -qq docker-compose-plugin > /dev/null

        log_info "Docker Compose plugin installed successfully."
    fi

    # Ensure Docker is running
    if ! systemctl is-active --quiet docker; then
        systemctl start docker
        systemctl enable docker
        log_info "Docker service started and enabled."
    fi
}

# -----------------------------------------------------------------------------
# Prompt for a required variable (loops until non-empty)
# Sets the result in the global variable named by $1
# -----------------------------------------------------------------------------
prompt_required() {
    local var_name="$1"
    local description="$2"
    local example="$3"
    local value=""

    while [ -z "$value" ]; do
        echo -e "  ${BOLD}${var_name}${NC}" >&2
        echo -e "  ${description}" >&2
        if [ -n "$example" ]; then
            echo -e "  ${CYAN}Example: ${example}${NC}" >&2
        fi
        read -r -p "  > " value
        if [ -z "$value" ]; then
            echo -e "  ${RED}This field is required.${NC}" >&2
        fi
        echo "" >&2
    done

    # Set the global variable by name
    printf -v "$var_name" '%s' "$value"
}

# -----------------------------------------------------------------------------
# Prompt for a secret variable (hidden input, loops until non-empty)
# Sets the result in the global variable named by $1
# -----------------------------------------------------------------------------
prompt_secret() {
    local var_name="$1"
    local description="$2"
    local value=""
    local confirm=""

    while true; do
        value=""
        while [ -z "$value" ]; do
            echo -e "  ${BOLD}${var_name}${NC}" >&2
            echo -e "  ${description}" >&2
            read -r -s -p "  > " value
            echo "" >&2
            if [ -z "$value" ]; then
                echo -e "  ${RED}This field is required.${NC}" >&2
            fi
            echo "" >&2
        done

        echo -e "  ${BOLD}Confirm ${var_name}${NC}" >&2
        read -r -s -p "  > " confirm
        echo "" >&2
        echo "" >&2

        if [ "$value" = "$confirm" ]; then
            break
        else
            echo -e "  ${RED}Values do not match. Please try again.${NC}" >&2
            echo "" >&2
        fi
    done

    # Set the global variable by name
    printf -v "$var_name" '%s' "$value"
}

# -----------------------------------------------------------------------------
# Collect required environment variables interactively
# -----------------------------------------------------------------------------
collect_env_vars() {
    log_step "Step 2/5 — Required Configuration"

    log_info "You will be prompted for required environment variables."
    log_info "These are needed for the server to start."
    echo ""

    # Detect host timezone as default
    local host_tz="UTC"
    if [ -f /etc/timezone ]; then
        host_tz=$(cat /etc/timezone)
    elif command -v timedatectl &> /dev/null; then
        host_tz=$(timedatectl show --property=Timezone --value 2>/dev/null || echo "UTC")
    fi

    echo -e "  ${BOLD}TZ${NC}" >&2
    echo -e "  Timezone for all containers" >&2
    echo -e "  ${CYAN}Detected host timezone: ${host_tz}${NC}" >&2
    echo -e "  ${CYAN}Press Enter to use detected, or type a timezone (e.g. America/Sao_Paulo)${NC}" >&2
    read -r -p "  > " TZ_INPUT
    echo "" >&2
    if [ -z "$TZ_INPUT" ]; then
        TZ="$host_tz"
    else
        TZ="$TZ_INPUT"
    fi
    log_info "Timezone set to: ${TZ}"
    echo ""

    prompt_secret \
        "TACACS_KEY" \
        "Shared secret for TACACS+ communication with network devices"

    echo -e "  ${BOLD}DNS_SERVER_IP_01${NC}" >&2
    echo -e "  Primary DNS server IP for reverse lookups (optional, press Enter to skip)" >&2
    echo -e "  ${CYAN}Example: 10.0.0.53${NC}" >&2
    read -r -p "  > " DNS_SERVER_IP_01
    echo "" >&2
    if [ -z "$DNS_SERVER_IP_01" ]; then
        log_info "DNS skipped. Reverse lookups will use system DNS."
    fi

    # Ask if LDAP should be enabled
    echo ""
    echo -e "  ${BOLD}LDAP / Active Directory${NC}"
    echo -e "  By default, Soteria uses local authentication only."
    echo -e "  Enable LDAP to authenticate users against AD/LDAP."
    echo ""
    read -r -p "  Enable LDAP authentication? [y/N] " ldap_response
    echo ""

    ENABLE_LDAP="false"
    if [[ "$ldap_response" =~ ^[Yy]$ ]]; then
        ENABLE_LDAP="true"

        prompt_required \
            "LDAP_HOSTS" \
            "LDAP/AD server(s) - space-separated for failover" \
            "ldaps://dc01.domain.local ldaps://dc02.domain.local"

        prompt_required \
            "LDAP_USER" \
            "LDAP bind DN (service account)" \
            "CN=svc-tacacs,OU=Service Accounts,DC=domain,DC=local"

        prompt_secret \
            "LDAP_PASSWD" \
            "LDAP bind password for the service account"

        prompt_required \
            "LDAP_BASE" \
            "User search base DN" \
            "DC=domain,DC=local"

        prompt_required \
            "LDAP_BASE_GROUP" \
            "Group search base DN" \
            "OU=TACACS,OU=Groups,DC=domain,DC=local"
    else
        log_info "LDAP disabled. Using local authentication only."
    fi
}

# -----------------------------------------------------------------------------
# Generate .env file from template + collected values
# -----------------------------------------------------------------------------
generate_env_file() {
    log_step "Step 3/5 — Generating .env File"

    if [ -f "$ENV_FILE" ]; then
        local backup="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
        cp "$ENV_FILE" "$backup"
        log_warn "Existing .env backed up to: ${backup}"
    fi

    # Copy template
    cp "$ENV_EXAMPLE" "$ENV_FILE"

    # Helper: safely set a variable in the .env file
    # Uses awk to avoid sed delimiter issues with special characters
    set_env_var() {
        local key="$1"
        local val="$2"
        local file="$3"
        awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{$2=v} {print}' "$file" > "${file}.tmp" \
            && mv "${file}.tmp" "$file"
    }

    # Inject core values
    set_env_var "TZ"              "$TZ"              "$ENV_FILE"
    set_env_var "TACACS_KEY"       "$TACACS_KEY"       "$ENV_FILE"
    set_env_var "DNS_SERVER_IP_01" "$DNS_SERVER_IP_01" "$ENV_FILE"
    set_env_var "ENABLE_LDAP"      "$ENABLE_LDAP"      "$ENV_FILE"

    # Only inject LDAP values if LDAP was enabled
    if [ "${ENABLE_LDAP}" = "true" ]; then
        set_env_var "LDAP_HOSTS"      "$LDAP_HOSTS"      "$ENV_FILE"
        set_env_var "LDAP_USER"       "$LDAP_USER"       "$ENV_FILE"
        set_env_var "LDAP_PASSWD"     "$LDAP_PASSWD"     "$ENV_FILE"
        set_env_var "LDAP_BASE"       "$LDAP_BASE"       "$ENV_FILE"
        set_env_var "LDAP_BASE_GROUP" "$LDAP_BASE_GROUP" "$ENV_FILE"
    fi

    # Lock down permissions on the .env file
    chmod 600 "$ENV_FILE"

    log_info ".env file generated with required values."
    log_info "File permissions set to 600 (owner read/write only)."
}

# -----------------------------------------------------------------------------
# Open editor for optional variable tuning
# -----------------------------------------------------------------------------
edit_optional_vars() {
    log_step "Step 4/5 — Optional Configuration"

    echo -e "  The required variables have been set. The .env file also contains"
    echo -e "  optional settings (LDAP filters, TLS, log management, etc.)."
    echo ""
    read -r -p "  Would you like to review and edit optional settings now? [y/N] " response
    echo ""

    if [[ "$response" =~ ^[Yy]$ ]]; then
        # Pick an editor
        local editor
        if command -v nano &> /dev/null; then
            editor="nano"
        elif command -v vi &> /dev/null; then
            editor="vi"
        elif command -v vim &> /dev/null; then
            editor="vim"
        else
            log_warn "No text editor found (nano/vi/vim). Install one and edit .env manually."
            return
        fi

        log_info "Opening .env in ${editor}..."
        log_info "Save and exit when done."
        echo ""
        "$editor" "$ENV_FILE"
        log_info "Optional configuration complete."
    else
        log_info "Skipped. You can edit .env manually later: nano ${ENV_FILE}"
    fi
}

# -----------------------------------------------------------------------------
# Build the Docker image
# -----------------------------------------------------------------------------
build_image() {
    log_step "Step 5/5 — Building Docker Image"

    log_info "Building Soteria TACACS+ image. This may take a few minutes..."
    log_info "The first build compiles tac_plus-ng from source."
    echo ""

    cd "$SCRIPT_DIR"
    docker compose build --no-cache

    echo ""
    log_info "Docker image built successfully."
}

# -----------------------------------------------------------------------------
# Print final instructions
# -----------------------------------------------------------------------------
print_summary() {
    echo ""
    echo -e "${GREEN}${BOLD}"
    echo "  ╔═══════════════════════════════════════════════════════════╗"
    echo "  ║                                                           ║"
    echo "  ║              Setup Complete!                               ║"
    echo "  ║                                                           ║"
    echo "  ╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"

    echo -e "  ${BOLD}Image built:${NC}      soteria-tacacs"
    echo -e "  ${BOLD}Config file:${NC}      ${ENV_FILE}"
    echo -e "  ${BOLD}Compose file:${NC}     ${COMPOSE_FILE}"
    echo ""
    echo -e "  ${CYAN}${BOLD}To start the server:${NC}"
    echo ""
    echo -e "    docker compose up -d"
    echo ""
    echo -e "  ${CYAN}${BOLD}To start with a custom container name:${NC}"
    echo ""
    echo -e "    COMPOSE_PROJECT_NAME=myproject docker compose up -d"
    echo ""
    echo -e "  ${CYAN}${BOLD}Useful commands:${NC}"
    echo ""
    echo -e "    docker compose ps                          # Check status"
    echo -e "    docker compose logs -f soteria              # Follow logs"
    echo -e "    docker compose kill -s SIGHUP soteria       # Reload config"
    echo -e "    docker compose down                         # Stop"
    echo -e "    docker compose up -d --build                # Rebuild & restart"
    echo ""
    echo -e "  ${YELLOW}${BOLD}Important:${NC}"
    echo -e "    - Change the default local user passwords in config/conf.d/05-local-users.cfg"
    echo -e "    - Review the README.md for full documentation"
    echo ""
}

# =============================================================================
# Main
# =============================================================================

banner
check_root
check_distro
install_docker
collect_env_vars
generate_env_file
edit_optional_vars
build_image
print_summary
