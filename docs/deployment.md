# Deployment

## Host requirements

- Linux host (apt or dnf based) with Docker Engine + Compose plugin (installed by `install.sh`).
- Ports: **49/tcp** (TACACS+), **300/tcp** (TACACS+ TLS, optional), **53/tcp+udp** (DNS),
  **8081/tcp** (agent API), **8080/tcp** (frontend, behind your TLS proxy). Adjust in `.env`.
- Outbound reachability to your LDAP/AD (if used) and NetBox (if used).

## Install

```bash
sudo ./install.sh
```

Steps it performs (each idempotent): prerequisites -> `.env` + secret generation -> `soteria-net`
network -> dependency check/guidance -> `docker compose up -d --build` -> health checks.

Non-interactive / partial runs:
```bash
sudo ./install.sh --non-interactive   # use an existing .env, no prompts
sudo ./install.sh --skip-prereqs      # Docker/openssl already installed
sudo ./install.sh --skip-build        # only set up .env + network + deps
```

## Networking & the reverse proxy

- The **frontend** container is the single browser-facing origin. Its nginx serves the SPA and
  proxies `/agent`, `/supabase`, `/keycloak` to the services by name on `soteria-net`, and serves
  `/connect-info.json` (mobile onboarding). This replicates the dev-server proxy so there is no CORS
  or mixed-content over a public tunnel.
- Put a **TLS-terminating reverse proxy** (nginx, Caddy, or a Cloudflare tunnel) in front of the
  frontend. Terminate HTTPS there; forward to `soteria-frontend:80`. The upstream service names the
  frontend proxies to are set via `AGENT_UPSTREAM` / `SUPABASE_UPSTREAM` / `KEYCLOAK_UPSTREAM`.
- If a public tunnel fronts the app, ensure the tunnel host is allowed (the dev server uses
  `allowed-hosts.json`; in production the reverse proxy governs allowed hosts).

## TLS for TACACS+ (optional)

Set `ENABLE_TLS=true` and mount certs into the tacacs container at `/etc/tac_plus-ng/tls/`
(`server.crt`, `server.key`, `ca.crt`). Uncomment the `./tls` mount in `docker-compose.yml`.
Enabling TLS is a **restart-group** change (the container restarts on commit).

## Dependencies

Supabase, Keycloak and OpenBao must run on `soteria-net`. `install.sh` detects them; set them up per
[dependencies.md](dependencies.md). Login does not work until Supabase is reachable and the agent's
`AGENT_JWKS_URL` points at it.

## Upgrades & operations

```bash
git pull
docker compose up -d --build            # rebuild changed services
docker compose logs -f soteria-agent    # follow a service
docker compose restart soteria          # SIGHUP-safe restart of a service
```

- **Config changes** go through the web UI / agent (staged commit), not by editing volume files.
- **Backups**: the agent snapshots config to `backups/` on every commit/restore (retention
  `AGENT_BACKUP_RETAIN`). A golden config baseline is admin-managed.
- **DNS**: zone files live in `dns/zones/` (bind-mounted into both the agent and bind9). The agent
  reloads BIND on change.

## Production checklist

- [ ] `.env` populated; `TACACS_KEY` + seed-user hashes generated; `AGENT_JWKS_URL` set; anon key set.
- [ ] Supabase + Keycloak reachable on `soteria-net`; MFA enforced.
- [ ] TLS reverse proxy in front of the frontend; cleartext not exposed.
- [ ] `AGENT_JWT_SECRET`/`AGENT_JWKS_URL` set so the agent enforces auth (not lab no-auth).
- [ ] Firewall: expose only 49/300/53 and the HTTPS proxy; keep 8080/8081 internal.
- [ ] Backups/retention verified; golden config saved.
