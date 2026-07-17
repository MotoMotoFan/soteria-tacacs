# =============================================================================
# Soteria Agent - Dockerfile
# =============================================================================
# Company:    Pathfinder Insights
# Project:    Soteria AAA Infrastructure
# =============================================================================
# Multi-stage: static Go build, minimal alpine runtime (busybox wget serves
# the compose health check).
# =============================================================================
FROM golang:1.24-alpine AS build

WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/soteria-agent ./cmd/agent

FROM alpine:3.21

LABEL org.opencontainers.image.vendor="Pathfinder Insights"
LABEL org.opencontainers.image.title="Soteria Agent"
LABEL org.opencontainers.image.description="Management sidecar for the Soteria TACACS+ server"

COPY --from=build /out/soteria-agent /usr/local/bin/soteria-agent

EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/soteria-agent"]
