# Architecture

## Components & data flow

```
                         ┌──────────────────────────────────────────────┐
   network devices ─────▶│  soteria-tacacs (tac_plus-ng)  :49 / :300tls  │
   (switches/routers)    │   - AAA for device administration             │
                         │   - MAVIS -> LDAP/AD (optional)               │
                         └───────────────┬──────────────────────────────┘
                                         │ shared config volume (tacacs-config)
                                         │ + Docker socket control
   ┌─────────────────────────────────────▼─────────────────┐
   │  soteria-agent (Go REST API)  :8081                    │
   │   - staged commit pipeline (backup->write->validate    │
   │     ->reload) for all config                           │
   │   - drives BIND9 (zones) and restarts containers       │
   └───────▲───────────────────────────┬───────────────────┘
           │ Bearer (Supabase JWT)      │ writes zone files, SIGHUP/restart
           │                            ▼
   ┌───────┴──────────┐        ┌──────────────────┐
   │ soteria-frontend │        │  bind9 (DNS) :53  │
   │  nginx SPA +     │        └──────────────────┘
   │  proxy /agent    │
   │  /supabase       │◀── auth (login + MFA + OIDC/SSO)
   │  /keycloak       │
   │  /connect-info   │──▶ mobile apps (QR / endpoint onboarding)
   └───────┬──────────┘
           │ same-origin proxy
   ┌───────▼───────┐   ┌──────────┐   ┌──────────┐
   │ Supabase/Kong │   │ Keycloak │   │ OpenBao  │   (dependencies on soteria-net)
   │ auth + MFA    │   │ OIDC/SSO │   │ secrets  │
   └───────────────┘   └──────────┘   └──────────┘
```

## Layers

- **tac_plus-ng (`tacacs/`)** - the AAA daemon. Config lives in a Docker volume (`tacacs-config`)
  under `/etc/tac_plus-ng/conf.d/NN-*.cfg`. The image ships defaults in `/etc/tac_plus-ng-defaults`;
  the entrypoint copies them on first run and env-injects `${VAR}` placeholders from `.env`.
- **agent (`agent/`)** - the only writer of live config. Every change goes through a **staged commit
  pipeline**: open staging -> stage entity writes -> `commit` = backup + write + validate
  (`tac_plus-ng -P`) + reload (SIGHUP, or container restart for restart-group changes like LDAP/TLS/
  listener). Rejected commits leave the live config untouched and return the validator output.
- **frontend (`frontend/`)** - the web UI. In production it is nginx serving the built SPA and
  proxying `/agent`, `/supabase`, `/keycloak` (same-origin, no CORS/mixed-content) and serving
  `/connect-info.json` for mobile onboarding.
- **bind9 (`dns/`)** - authoritative DNS. The agent writes zone files (shared host dirs) and reloads
  BIND. Reverse zones use a resolvable out-of-bailiwick NS (a self-referential NS fails to load).
- **dependencies** - Supabase (GoTrue auth + mandatory TOTP MFA), Keycloak (OIDC/SSO), OpenBao
  (secret storage). They run alongside on `soteria-net`.

## The staged-commit safety model (why it matters)

TACACS config is live: a bad change can lock admins out of every device. So the agent never edits the
running config directly. Writes are **staged**, then a single atomic **commit** validates against the
real binary before applying and reloading. A failed validation is a no-op on the live server. This is
the backbone of both the web and mobile UIs.

## Auth model (summary)

- Login is via **Supabase** (email + password + **mandatory TOTP MFA**), plus **LDAP** (the agent
  binds the directory directly) and **Keycloak OIDC/SSO**.
- The agent verifies the Supabase **JWT** (ES256 via JWKS, or HS256 secret) on each request and
  enforces **scopes** per route; `role=admin` bypasses.
- The frontend/apps hold only the **public anon key** + the user's session. The **service role key**
  is never given to clients.

## Networking

All services share the `soteria-net` Docker network. The frontend is the single browser-facing origin
(behind a TLS proxy). The agent reaches the TACACS container and BIND via the Docker socket + shared
volumes. See [deployment.md](deployment.md).
