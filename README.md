# Soteria TACACS+

Self-hosted **TACACS+ AAA platform**: the `tac_plus-ng` server, a management **agent** (REST API),
a **web frontend**, and **BIND9 DNS**, orchestrated with Docker Compose. This monorepo holds the
server-side stack; the native phone apps live in a separate repository.

> Company: Pathfinder Insights · Engineer: MotoMotoFan · Project: Soteria AAA Infrastructure

---

## Components

| Path | Service | Description |
|------|---------|-------------|
| `tacacs/` | `soteria-tacacs` | Marc Huber's `tac_plus-ng` in a container (config, entrypoint, binaries). |
| `agent/` | `soteria-agent` | Go REST API: manages config via a staged commit pipeline, drives BIND9, restarts containers. |
| `frontend/` | `soteria-frontend` | React/Vite web UI, served by nginx that also proxies the backends and emits `/connect-info.json` for the mobile apps. |
| `dns/` | `bind9` | Authoritative DNS managed by the agent (forward + reverse zones). |
| `compose/`, `docker-compose.yml` | orchestration | Top-level stack. |
| `install.sh` | installer | One step-by-step script: prerequisites → secrets → network → deps → build → health. |
| `docs/` | documentation | Architecture, deployment, configuration, dependencies. |

**Dependencies (stood up separately, on the same `soteria-net`):** self-hosted **Supabase** (auth +
MFA), **Keycloak** (OIDC/SSO), **OpenBao** (secrets), and a TLS-terminating reverse proxy
(nginx/Cloudflare). See [`docs/dependencies.md`](docs/dependencies.md).

## Quick start

```bash
git clone <this repo> soteria-tacacs && cd soteria-tacacs
sudo ./install.sh          # installs Docker + deps, generates secrets, builds & starts the stack
```

Or manually:

```bash
cp .env.example .env       # fill in secrets (or let install.sh generate them)
docker compose up -d --build
```

Then complete Supabase/Keycloak setup ([`docs/dependencies.md`](docs/dependencies.md)) and open the
frontend (default `http://localhost:8080/`, behind your TLS proxy in production).

## Security posture

- **No secrets in git.** All secrets live in `.env` (gitignored); config uses `${VAR}` env injection.
  `install.sh` generates the TACACS key and hashes the seed-user passwords locally.
- **Supabase service role key never ships** to clients; the frontend + apps use the public anon key only.
- **TLS off cleartext by default;** put a TLS-terminating proxy in front. See
  [`docs/deployment.md`](docs/deployment.md).

## Documentation

- [Architecture](docs/architecture.md) - components, data flow, the staged-commit safety model.
- [Deployment](docs/deployment.md) - hosts, networking, TLS/tunnel, production notes.
- [Configuration](docs/configuration.md) - every `.env` var, LDAP/MAVIS, DNS, TLS.
- [Dependencies](docs/dependencies.md) - Supabase, Keycloak, OpenBao setup.

## Repositories in the Soteria project

- **soteria-tacacs** (this repo) - the server-side stack.
- **soteria-android** / **soteria-ios** - native phone apps (separate repos; connect via QR / endpoint).
