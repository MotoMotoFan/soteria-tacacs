# =============================================================================
# Dockerfile - Soteria Frontend (production image)
# =============================================================================
# Company:    Pathfinder Insights
# Engineer:   MotoMotoFan
# Project:    Soteria AAA Infrastructure
# =============================================================================
# Multi-stage: build the Vite SPA, then serve it with nginx. The nginx layer
# replicates the dev-server same-origin proxy (/agent, /supabase, /keycloak) and
# serves /connect-info.json (emitted into the build), so a phone/browser reaches
# the lab-only backends over one origin with no CORS or mixed-content.
# =============================================================================

# ---- build stage ----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Build-time public config baked into the bundle + connect-info.json.
# These are RELATIVE proxy paths + the PUBLIC Supabase anon key (safe to embed).
ARG VITE_AGENT_URL=/agent
ARG VITE_SUPABASE_URL=/supabase
ARG VITE_SUPABASE_ANON_KEY=
# LAB ONLY: baking the service role key into the browser bundle enables the
# Settings admin sections (Web UI Users / Access Groups) without a backend.
# Leave EMPTY outside a test lab - it is a root credential for Supabase.
ARG VITE_SUPABASE_SERVICE_ROLE_KEY=
ENV VITE_AGENT_URL=$VITE_AGENT_URL \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_SUPABASE_SERVICE_ROLE_KEY=$VITE_SUPABASE_SERVICE_ROLE_KEY

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build     # emits dist/ incl. dist/connect-info.json (see vite.config.ts)

# ---- runtime stage --------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Upstreams are templated so the deployer points them at the running services.
# The nginx image runs envsubst over /etc/nginx/templates/*.template at start.
ENV AGENT_UPSTREAM=soteria-agent:8081 \
    SUPABASE_UPSTREAM=kong:8000 \
    KEYCLOAK_UPSTREAM=keycloak:8080

COPY deploy/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
# nginx entrypoint handles envsubst on the template then runs nginx -g 'daemon off;'
