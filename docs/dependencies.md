# Dependencies

The core stack (tac_plus-ng, agent, frontend, BIND9) is vendored here. Everything else runs on the
shared `soteria-net` docker network **and is deployed automatically by `install.sh`** — you no
longer set any of it up by hand. This page documents what the installer stands up and how to manage
it afterwards. Deployment directories live beside this repo (override with `DEPS_DIR=`):

| Component | Directory | Status | Installed |
|---|---|---|---|
| Supabase (auth + MFA) | `../supabase` | **core** | always |
| OpenBao (secret storage) | `../openbao` | **core** | always |
| Keycloak (OIDC / SSO) | `../keycloak` | optional | installer asks |
| nginx TLS reverse proxy | `../nginx` | recommended | installer asks |

> All generated passwords, keys and tokens are recorded in the repo's `CREDENTIALS.md`
> (chmod 600, gitignored). Check there first — nothing is ever printed once and lost.

## 1. Supabase (authentication + MFA) — core

Provides email+password login, mandatory TOTP MFA, and the JWT the agent trusts.

What `install.sh` does:

1. Clones the official self-hosted stack and copies `docker/` to `../supabase`.
2. Generates `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY` and
   `DASHBOARD_PASSWORD`, writes them to `../supabase/.env`, and records them in `CREDENTIALS.md`.
   Signups are disabled (admins create users).
3. Attaches Kong to `soteria-net` via `docker-compose.soteria-net.yml`, registered with
   `sh run.sh config add soteria-net`. **Do not use `docker-compose.override.yml`** — the stack
   pins its file list with `COMPOSE_FILE=` in `.env`, so the auto-include never applies.
4. Starts the stack and waits until GoTrue reports healthy.
5. Creates the web UI tables (`web_roles`, `auth_settings`) and the **first administrator**
   (see [deployment.md](deployment.md#first-login)).

Manage it with `sh run.sh start|stop|status|logs` from `../supabase`. Supabase Studio is available
through Kong (`:8000`) — dashboard user `supabase`, password in `CREDENTIALS.md`.

The **service role key stays server-side** (Supabase env + the lab-only
`VITE_SUPABASE_SERVICE_ROLE_KEY`); never ship it to real clients outside a disposable lab.

## 2. OpenBao (secret storage) — core

Vault-compatible central secret store, container `openbao` on `soteria-net`, UI on `:8200`.

What `install.sh` does:

1. Deploys OpenBao with file storage (`../openbao`).
2. Initialises it (1 unseal key share) and unseals it. The **unseal key and root token are
   recorded in `CREDENTIALS.md`**.
3. Enables KV v2 engine `soteria-app` and seeds it with the stack's secrets:
   - `soteria-app/supabase` — postgres/JWT/API keys + Studio dashboard login
   - `soteria-app/frontend-admin` — the web UI administrator credentials
   - `soteria-app/tacacs` — TACACS key + seed user passwords

> **OpenBao starts sealed after every restart** (host reboot or container restart). Unseal it with
> `../openbao/unseal.sh` (reads the recorded key from `CREDENTIALS.md`).

## 3. Keycloak (OIDC / SSO) — optional

The installer asks `Deploy Keycloak (optional OIDC / SSO)?` (or force with
`--with-keycloak` / `--without-keycloak`). When enabled it:

1. Runs Keycloak 26 on `soteria-net` as `keycloak`, served under `/keycloak`
   (`KC_HTTP_RELATIVE_PATH`), admin `admin` with a generated password (in `CREDENTIALS.md`).
2. Bootstraps realm `soteria` and confidential client `soteria-frontend` (secret in
   `CREDENTIALS.md`) with the Supabase callback as redirect URI.
3. Wires GoTrue to it (`GOTRUE_EXTERNAL_KEYCLOAK_*`) via `docker-compose.soteria-keycloak.yml`
   in the Supabase stack.

The "Sign in with SSO" button appears once an admin enables the SSO method in the web UI
(Settings → Authentication). To add Keycloak later:
`sudo ./install.sh --with-keycloak --skip-prereqs --skip-build`.

## 4. Reverse proxy / TLS — recommended (installer asks)

The installer asks `Deploy the nginx TLS reverse proxy?` (default yes; force with
`--with-proxy` / `--without-proxy`). It generates a self-signed certificate for your public
hostname/IP (`../nginx/certs/soteria.lab.crt` — trust it on your machines) and fronts
`soteria-frontend:80` on `:443` with an HTTP→HTTPS redirect. The frontend already
same-origin-proxies `/agent`, `/supabase` and `/keycloak`, so this one origin is all you expose.
Replace with your own nginx/Caddy/Cloudflare tunnel for production. See
[deployment.md](deployment.md).

## Verifying

```bash
docker network inspect soteria-net           # kong / openbao (/ keycloak) attached
curl -fsS http://localhost:8081/ready        # agent up
curl -fsS http://localhost:8080/connect-info.json   # discovery doc (mobile onboarding)
docker exec openbao bao status               # Sealed: false after unseal
```

If login fails: confirm Supabase (Kong) is on `soteria-net`, the agent's JWT settings match
Supabase, and the anon key in `.env` matches — all of which `install.sh` sets from the same
recorded values in `CREDENTIALS.md`.
