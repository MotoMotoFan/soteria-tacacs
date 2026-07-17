package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Pathfinder-Insights/soteria-agent/internal/api"
	"github.com/Pathfinder-Insights/soteria-agent/internal/dns"
	"github.com/Pathfinder-Insights/soteria-agent/internal/dockerctl"
	"github.com/Pathfinder-Insights/soteria-agent/internal/netbox"
	"github.com/Pathfinder-Insights/soteria-agent/internal/store"
	"github.com/Pathfinder-Insights/soteria-agent/internal/token"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// dnsProvider builds the local BIND9 DNS backend, or returns nil when the
// bind9 project isn't mounted into the agent (DNS management then reports
// unavailable rather than erroring).
func dnsProvider(docker *dockerctl.Client) dns.Provider {
	container := envOr("AGENT_DNS_CONTAINER", "bind9")
	b := &dns.BindProvider{
		ZonesDir:     envOr("AGENT_DNS_ZONES_DIR", "/bind9/zones"),
		BindZonesDir: envOr("AGENT_DNS_BIND_ZONES_DIR", "/var/lib/bind"),
		NamedLocal:   envOr("AGENT_DNS_NAMED_LOCAL", "/bind9/config/named.conf.local"),
		Reload: func(ctx context.Context) error {
			return docker.ReloadContainer(ctx, container)
		},
	}
	if !b.Available() {
		return nil
	}
	return b
}

func dockerNew(sock, container string) *dockerctl.Client {
	return dockerctl.New(sock, container)
}

func newServer(configDir, logDir, globalKey string, docker *dockerctl.Client, devMode bool) *api.Server {
	retain, _ := strconv.Atoi(os.Getenv("AGENT_BACKUP_RETAIN"))
	st := &store.Store{
		Dir:           configDir,
		Validate:      docker,
		Reload:        docker,
		Restart:       docker,
		DevMode:       devMode,
		DefaultRetain: retain,
	}
	return &api.Server{
		Store:     st,
		Docker:    docker,
		LogDir:    logDir,
		GlobalKey: globalKey,
		JWTSecret: []byte(os.Getenv("AGENT_JWT_SECRET")),
		JWKS:      api.NewJWKS(os.Getenv("AGENT_JWKS_URL")),
		Tokens:    &token.Store{Path: filepath.Join(configDir, ".agent-tokens.json")},
		DNS:       dnsProvider(docker),
		NB: netbox.New(
			os.Getenv("AGENT_NETBOX_URL"),
			os.Getenv("AGENT_NETBOX_HOST"),
			os.Getenv("AGENT_NETBOX_TOKEN"),
			strings.EqualFold(os.Getenv("AGENT_NETBOX_INSECURE"), "true"),
		),
	}
}
