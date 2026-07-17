# Dependencies

The core stack (tac_plus-ng, agent, frontend, BIND9) is vendored here. Its runtime dependencies are
stood up **separately** on the shared `soteria-net` network. This keeps the repo free of large
third-party stacks and their secrets. `install.sh` detects them and warns if any is missing.

> Create the shared network first (install.sh does this): `docker network create soteria-net`

## 1. Supabase (authentication + MFA)  — required

Provides email+password login, mandatory TOTP MFA, and the JWT the agent trusts.

1. Get the official self-hosted stack:
   ```bash
   git clone --depth 1 https://github.com/supabase/supabase
   cp -r supabase/docker ~/supabase && cd ~/supabase
   cp .env.example .env
   ```
2. Edit `.env`: set strong `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`
   (generate the keys with the Supabase key tool), `SITE_URL`/`API_EXTERNAL_URL` to your public URL,
   and enable MFA (GoTrue TOTP is on by default). Keep signups disabled (admins create users).
3. Put Kong on `soteria-net` so the frontend can proxy to it as `kong:8000`:
   ```bash
   # in supabase docker-compose.yml, add to the kong service:
   #   networks: [default, soteria-net]
   # and at the bottom:
   #   networks: { soteria-net: { external: true } }
   docker compose up -d
   ```
4. Back in this repo's `.env`:
   - `VITE_SUPABASE_ANON_KEY=<the anon key>`
   - `AGENT_JWKS_URL=https://<your-host>/supabase/auth/v1/.well-known/jwks.json`
     (or set `AGENT_JWT_SECRET=<JWT_SECRET>` for HS256).
   Then `docker compose up -d --build` here.

The **service role key stays in Supabase's env only** - never put it in this repo's `.env` or in any
client.

## 2. Keycloak (OIDC / SSO)  — optional

For "Sign in with SSO". Run Keycloak on `soteria-net` as `keycloak`, served under `/keycloak`
(`KC_HTTP_RELATIVE_PATH=/keycloak`). Create a realm + a `soteria-frontend` client, and configure the
matching `GOTRUE_EXTERNAL_KEYCLOAK_*` in Supabase. The frontend proxies `/keycloak` to
`${KEYCLOAK_UPSTREAM}` (default `keycloak:8080`).

## 3. OpenBao (secrets)  — optional

Central secret storage (Vault-compatible). Run as `openbao` on `soteria-net`. Use it to hold the
Supabase keys, admin credentials, and LDAP bind password out of plain `.env` files. Reference:
enable a KV engine and store the Soteria app secrets there; retrieve them at deploy time.

## 4. Reverse proxy / TLS  — required for production

Terminate HTTPS (nginx, Caddy, or a Cloudflare tunnel) and forward to `soteria-frontend:80`. The
frontend already same-origin-proxies the backends, so the public proxy only needs to route the one
origin. See [deployment.md](deployment.md).

## Verifying

```bash
docker network inspect soteria-net           # kong / keycloak / openbao should be attached
curl -fsS http://localhost:8081/ready        # agent up
curl -fsS http://localhost:8080/connect-info.json   # discovery doc (mobile onboarding)
```

If login fails: confirm Supabase (Kong) is on `soteria-net`, `AGENT_JWKS_URL` resolves, and the anon
key in `.env` matches Supabase.
