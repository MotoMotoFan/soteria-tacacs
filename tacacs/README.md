# Soteria — TACACS+ Server

Container-ready TACACS+ server powering Soteria's AAA (Authentication, Authorization, Accounting) infrastructure.

Built on [tac_plus-ng](https://github.com/MarcJHuber/event-driven-servers) from the event-driven-servers project, compiled from source inside a multi-stage Docker build with modular configuration, optional LDAP/Active Directory integration, TLS support, and automated log management.

Out of the box, Soteria uses **local authentication only** — no external dependencies required. LDAP/AD can be enabled when you're ready to integrate.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Modular Config Files](#modular-config-files)
  - [LDAP / Active Directory](#ldap--active-directory)
  - [Local Users](#local-users)
  - [Groups and Profiles](#groups-and-profiles)
  - [Devices](#devices)
- [TLS Encryption](#tls-encryption)
- [Log Management](#log-management)
- [Operations](#operations)
  - [Build and Deploy](#build-and-deploy)
  - [Reload Configuration](#reload-configuration)
  - [Health Check](#health-check)
  - [Viewing Logs](#viewing-logs)
  - [Backup and Restore](#backup-and-restore)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

---

## Quick Start

### Automated Setup (Recommended)

```bash
# 1. Clone the repository
git clone https://github.com/Pathfinder-Insights/soteria.git
cd soteria

# 2. Run the setup script (installs Docker if needed, prompts for config, builds the image)
sudo chmod +x setup.sh
sudo ./setup.sh

# 3. Start the server
docker compose up -d
```

The setup script will:
1. Install Docker Engine + Compose plugin if not present
2. Prompt for all required environment variables (TACACS key, LDAP, DNS)
3. Optionally open the `.env` file for fine-tuning optional settings
4. Build the Docker image
5. Print the commands to start and manage the container

### Manual Setup

```bash
# 1. Clone the repository
git clone https://github.com/Pathfinder-Insights/soteria.git
cd soteria

# 2. Create your environment file
cp .env.example .env

# 3. Edit .env with your values (TACACS key, LDAP settings, DNS, etc.)
nano .env

# 4. Build and start the container
docker compose up -d --build

# 5. Verify it's running
docker compose ps
docker compose logs -f soteria
```

---

## Project Structure

```
soteria/
├── binaries/                    # tac_plus-ng source (event-driven-servers)
├── config/
│   ├── tac_plus-ng.cfg          # Main config - spawnd + includes
│   ├── conf.d/
│   │   ├── 01-logging.cfg       # Log destinations and assignments
│   │   ├── 02-dns.cfg           # DNS resolution settings
│   │   ├── 03-mavis.cfg         # MAVIS/LDAP authentication backend
│   │   ├── 04-devices.cfg       # Network device (NAS) definitions
│   │   ├── 05-local-users.cfg   # Local fallback users
│   │   ├── 06-groups.cfg        # Group definitions
│   │   ├── 07-profiles.cfg      # Authorization profiles
│   │   ├── 08-ruleset.cfg       # Group-to-profile mapping rules
│   │   └── 09-tls.cfg           # TLS certificate config (optional)
│   └── logrotate.conf           # Process log rotation
├── scripts/
│   ├── entrypoint.sh            # Container entrypoint
│   └── monthly-archive.sh       # Monthly AAA log archiving
├── tls/                         # TLS certificates (not committed)
├── Dockerfile                   # Multi-stage build
├── docker-compose.yml           # Deployment definition
├── setup.sh                     # Automated environment setup script
├── .env.example                 # Environment variable template
├── .gitignore                   # Protects secrets from commits
└── README.md                    # This file
```

---

## Architecture

The Docker image is built in two stages:

**Stage 1 — Builder:** Compiles `tac_plus-ng`, `spawnd`, MAVIS modules, and `tactrace.pl` from source on Ubuntu 24.04 with all build dependencies (clang, make, OpenSSL dev, LDAP dev, PCRE2 dev, etc.).

**Stage 2 — Runtime:** Clean Ubuntu 24.04 with only runtime libraries. Compiled binaries and Perl modules are copied from the builder stage. No compilers or build tools are present in the final image.

The entrypoint script handles:
1. Environment variable validation
2. Variable injection into config files via `envsubst`
3. Optional TLS activation
4. Log directory creation (year/month structure)
5. Configuration syntax validation (`tac_plus-ng -P`)
6. Cron setup for logrotate and monthly archiving
7. SIGHUP trap for live config reload

The `spawnd` connection broker is built into `tac_plus-ng` and manages worker process scaling internally (1–20 instances by default).

---

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and fill in your values. The `.env` file is excluded from version control via `.gitignore`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TACACS_KEY` | **Yes** | — | Shared secret for TACACS+ device communication |
| `TACACS_LISTEN_PORT` | No | `49` | Host port for plain TACACS+ |
| `DNS_SERVER_IP_01` | No | — | Primary DNS server for reverse lookups |
| `ENABLE_LDAP` | No | `false` | Enable LDAP/AD authentication backend |
| `LDAP_SERVER_TYPE` | When LDAP | `microsoft` | `microsoft` (AD) or `generic` (OpenLDAP) |
| `LDAP_HOSTS` | When LDAP | — | LDAP server(s), space-separated for failover |
| `LDAP_USER` | When LDAP | — | LDAP bind DN (service account) |
| `LDAP_PASSWD` | When LDAP | — | LDAP bind password |
| `LDAP_BASE` | When LDAP | — | User search base DN |
| `LDAP_SCOPE` | No | `sub` | User search scope |
| `LDAP_FILTER` | No | `(&(objectClass=user)(sAMAccountName=%s))` | User search filter |
| `LDAP_BASE_GROUP` | When LDAP | — | Group search base DN |
| `LDAP_SCOPE_GROUP` | No | `sub` | Group search scope |
| `LDAP_FILTER_GROUP` | No | `(&(objectClass=group)(member=%s))` | Group search filter |
| `LDAP_CONNECT_TIMEOUT` | No | `5` | LDAP connection timeout (seconds) |
| `LDAP_TACMEMBER` | No | `memberOf` | LDAP attribute for group membership |
| `ENABLE_TLS` | No | `false` | Enable TACACS+ over TLS on port 300 |
| `TACACS_TLS_PORT` | No | `300` | Host port for TACACS+ TLS |
| `ENABLE_LOGROTATE` | No | `true` | Enable weekly process log rotation |
| `ENABLE_MONTHLY_ARCHIVE` | No | `true` | Enable monthly AAA log archiving |

### Modular Config Files

Configuration is split into numbered files loaded in order. Each file handles one concern:

| File | Purpose |
|---|---|
| `01-logging.cfg` | Log destinations (per-day files) and assignments |
| `02-dns.cfg` | DNS resolver and reverse lookup settings |
| `03-mavis.cfg` | LDAP backend, authentication/authorization backends, caching |
| `04-devices.cfg` | Network device definitions and TACACS+ keys |
| `05-local-users.cfg` | Local fallback users with SHA-512 hashed passwords |
| `06-groups.cfg` | Group definitions (mapped from LDAP) |
| `07-profiles.cfg` | Authorization profiles (privilege levels, command rules) |
| `08-ruleset.cfg` | Maps group membership to profiles (first match wins) |
| `09-tls.cfg` | TLS certificate paths and validation settings (optional) |

All files support `${VARIABLE}` placeholders that are replaced at container startup by `envsubst`.

### LDAP / Active Directory (Optional)

LDAP is **disabled by default**. To enable it, set `ENABLE_LDAP=true` in your `.env` file and provide the required LDAP variables. The entrypoint will dynamically activate the MAVIS backend at startup.

The MAVIS external backend (`mavis_tacplus-ng_ldap.pl`) authenticates users against LDAP/AD and retrieves group membership. The flow is:

1. User attempts login on a network device
2. Device sends TACACS+ request to Soteria
3. MAVIS queries LDAP to validate credentials
4. Group membership is retrieved and matched against the ruleset
5. The matching profile determines privilege level and command authorization

For AD environments, ensure your LDAP service account has read access to user objects and group membership attributes. The `LDAP_HOSTS` variable supports multiple servers for failover (space-separated).

### Local Users

Local users in `05-local-users.cfg` serve as fallback when LDAP is unreachable. Passwords are stored as SHA-512 crypt hashes.

To generate a password hash:
```bash
openssl passwd -6 'yourpassword'
```

The default config includes two local users:
- `network_admin` — Member of `tacacs_admin` (privilege 15)
- `network_readonly` — Member of `tacacs_readonly` (privilege 3)

**Important:** Change these default passwords before deploying to production.

### Groups and Profiles

Groups are defined in `06-groups.cfg` and must match the LDAP group names returned by the MAVIS backend. Profiles in `07-profiles.cfg` define what each group can do:

- **tacacs_admin** — Privilege level 15, full shell access
- **tacacs_readonly** — Privilege level 3, restricted shell access

The ruleset in `08-ruleset.cfg` maps group membership to profiles. Rules are evaluated top-down — first match wins. If no rule matches, access is denied.

### Devices

Devices (NAS) are defined in `04-devices.cfg`. The default configuration uses a catch-all entry that matches any device:

```
device all {
    address = 0.0.0.0/0
    key     = "${TACACS_KEY}"
}
```

To add per-device keys or settings, add specific device blocks above the catch-all:

```
device core-switch-01 {
    address = 10.0.1.1/32
    key     = "device-specific-key"
}
```

---

## TLS Encryption

TACACS+ over TLS is supported on port 300 (IANA assigned) but **disabled by default**.

### Enabling TLS

1. **Generate or obtain certificates:**
   ```bash
   # Self-signed for testing
   mkdir -p tls
   openssl req -x509 -newkey rsa:4096 -keyout tls/server.key -out tls/server.crt \
     -sha256 -days 365 -nodes -subj "/CN=soteria-tacacs"
   cp your-ca.crt tls/ca.crt
   ```

2. **Set the environment variable in `.env`:**
   ```
   ENABLE_TLS=true
   ```

3. **Uncomment the TLS volume in `docker-compose.yml`:**
   ```yaml
   volumes:
     - tacacs-logs:/var/log/tac_plus
     - ./tls:/etc/tac_plus-ng/tls:ro    # <-- uncomment this line
   ```

4. **Rebuild and restart:**
   ```bash
   docker compose up -d --build
   ```

The entrypoint will validate that `server.crt`, `server.key`, and `ca.crt` exist, enforce `chmod 600` on the private key, and dynamically activate the TLS listener and config. The container will refuse to start if certificates are missing when `ENABLE_TLS=true`.

### TLS Certificate Files

| File | Description |
|---|---|
| `tls/server.crt` | Server certificate (PEM format) |
| `tls/server.key` | Server private key (PEM format) |
| `tls/ca.crt` | Certificate Authority chain (PEM format) |

**Note:** TLS certificate files are excluded from version control via `.gitignore`.

---

## Log Management

### Log Structure

AAA logs are written as daily files organized by year and month:

```
/var/log/tac_plus/
├── authentication/2026/02/authentication-02-24-2026.log
├── authorization/2026/02/authorization-02-24-2026.log
├── accounting/2026/02/accounting-02-24-2026.log
├── archive/
│   ├── authentication/2026-01.tar.gz
│   ├── authorization/2026-01.tar.gz
│   └── accounting/2026-01.tar.gz
└── tac_plus-ng.log                # Process/entrypoint log
```

All logs use RFC 5424 timestamps.

### Log Rotation

Two mechanisms handle log lifecycle:

- **Process log** (`tac_plus-ng.log`): Rotated weekly by `logrotate`, keeping 12 compressed rotations. Controlled by `ENABLE_LOGROTATE`.

- **AAA logs**: Archived monthly on the 1st of each month by `monthly-archive.sh`. Previous month's daily files are compressed into a single `YYYY-MM.tar.gz`, integrity-verified, then originals are removed. Controlled by `ENABLE_MONTHLY_ARCHIVE`.

Both can be disabled (set to `false`) if you're shipping logs to an external syslog collector.

### Persistent Storage

AAA logs are stored in the `tacacs-logs` Docker named volume, which persists across container restarts and image rebuilds.

---

## Operations

### Build and Deploy

```bash
# Build and start
docker compose up -d --build

# Rebuild after config changes
docker compose up -d --build --force-recreate

# Stop
docker compose down

# Stop and remove volumes (WARNING: deletes all logs)
docker compose down -v
```

### Reload Configuration

Send SIGHUP to reload `tac_plus-ng` configuration without restarting the container:

```bash
docker compose kill -s SIGHUP soteria
```

**Note:** This reloads the tac_plus-ng daemon config. If you changed environment variables or the entrypoint logic, you need a full container restart.

### Health Check

The container includes a built-in health check that verifies port 49 is listening:

```bash
# Check health status
docker inspect --format='{{.State.Health.Status}}' soteria-tacacs

# View health check history
docker inspect --format='{{json .State.Health}}' soteria-tacacs | python3 -m json.tool
```

### Viewing Logs

```bash
# Container stdout (entrypoint messages)
docker compose logs -f soteria

# Process log
docker compose exec soteria cat /var/log/tac_plus/tac_plus-ng.log

# Today's authentication log
docker compose exec soteria cat /var/log/tac_plus/authentication/$(date +%Y)/$(date +%m)/authentication-$(date +%m-%d-%Y).log

# Today's authorization log
docker compose exec soteria cat /var/log/tac_plus/authorization/$(date +%Y)/$(date +%m)/authorization-$(date +%m-%d-%Y).log

# Today's accounting log
docker compose exec soteria cat /var/log/tac_plus/accounting/$(date +%Y)/$(date +%m)/accounting-$(date +%m-%d-%Y).log
```

### Backup and Restore

```bash
# Backup logs volume to a tar file
docker run --rm -v tacacs-logs:/data -v $(pwd):/backup alpine tar czf /backup/tacacs-logs-backup.tar.gz -C /data .

# Restore logs from backup
docker run --rm -v tacacs-logs:/data -v $(pwd):/backup alpine sh -c "cd /data && tar xzf /backup/tacacs-logs-backup.tar.gz"
```

---

## Security

### Hardening Measures

- **Multi-stage build** — No compilers, build tools, or source code in the runtime image
- **Dedicated service user** — `tacacs` user/group (no shell, no home directory)
- **Strict file permissions** — Config files `640`, TLS directory `700`, private key `600`, logs `750`
- **No-new-privileges** — Docker security option prevents privilege escalation
- **Secrets via environment** — All sensitive values injected via `.env` (excluded from git)
- **TLS certificates excluded from git** — `.gitignore` blocks `tls/*.key`, `tls/*.crt`, `tls/*.pem`
- **Resource limits** — CPU and memory caps prevent runaway resource consumption
- **Health check** — Automatic container health monitoring

### Password Hashing

Local user passwords use SHA-512 crypt hashes. Never store plaintext passwords in config files.

```bash
# Generate a SHA-512 hash
openssl passwd -6 'yourpassword'
```

### Docker Secrets (Alternative)

For orchestrated environments (Swarm, Kubernetes), consider using Docker secrets or Kubernetes secrets instead of `.env` files for sensitive values like `TACACS_KEY` and `LDAP_PASSWD`.

---

## Troubleshooting

### Container won't start

**Check the process log:**
```bash
docker compose logs soteria
```

**Common causes:**
- Missing required environment variables — the entrypoint logs which ones are missing
- Configuration syntax error — run validation manually:
  ```bash
  docker compose exec soteria /usr/local/sbin/tac_plus-ng -P /etc/tac_plus-ng/tac_plus-ng.cfg
  ```
- TLS enabled but certificates missing — mount the `./tls` directory and ensure all three files exist

### Authentication failures

**Check the authentication log:**
```bash
docker compose exec soteria tail -50 /var/log/tac_plus/authentication/$(date +%Y)/$(date +%m)/authentication-$(date +%m-%d-%Y).log
```

**Common causes:**
- LDAP server unreachable — verify `LDAP_HOSTS` and network connectivity from the container:
  ```bash
  docker compose exec soteria fping <ldap-server-ip>
  ```
- Wrong LDAP bind credentials — verify `LDAP_USER` and `LDAP_PASSWD`
- User not in the correct LDAP group — check `LDAP_FILTER` and `LDAP_FILTER_GROUP`
- TACACS+ key mismatch — ensure `TACACS_KEY` matches the key configured on the network device

### Authorization failures

**Check the authorization log:**
```bash
docker compose exec soteria tail -50 /var/log/tac_plus/authorization/$(date +%Y)/$(date +%m)/authorization-$(date +%m-%d-%Y).log
```

**Common causes:**
- User's LDAP group doesn't match any group in `06-groups.cfg`
- No ruleset match in `08-ruleset.cfg` — rules are top-down, first match wins
- Profile missing or misconfigured in `07-profiles.cfg`

### Testing connectivity

```bash
# Test TACACS+ port from another host
nc -zv <soteria-host-ip> 49

# Test from inside the container
docker compose exec soteria netstat -tlnp | grep 49

# Test LDAP connectivity from the container
docker compose exec soteria perl -e 'use Net::LDAP; my $l = Net::LDAP->new("your-ldap-host"); print $l ? "OK\n" : "FAIL: $@\n"'
```

### Inspecting the running config

```bash
# View the processed config (after envsubst)
docker compose exec soteria cat /etc/tac_plus-ng/tac_plus-ng.cfg
docker compose exec soteria cat /etc/tac_plus-ng/conf.d/03-mavis.cfg
```

---

## Credits

- **tac_plus-ng** — [Marc Huber / event-driven-servers](https://github.com/MarcJHuber/event-driven-servers)
- **Soteria** — Pathfinder Insights, engineered by MotoMotoFan
