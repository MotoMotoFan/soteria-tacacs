// soteria-agent - management sidecar for the Soteria TACACS+ server.
//
// Owns the tac_plus-ng config in the shared volume, validates and reloads
// it through the Docker API, and serves the HTTP API soteria-frontend uses.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	listen := env("AGENT_LISTEN", ":8081")
	configDir := env("CONFIG_DIR", "/etc/tac_plus-ng")
	logDir := env("LOG_DIR", "/var/log/tac_plus")
	dockerSock := env("DOCKER_SOCK", "/var/run/docker.sock")
	container := env("TACACS_CONTAINER", "soteria-tacacs")
	globalKey := os.Getenv("TACACS_KEY")
	devMode := os.Getenv("AGENT_DEV_MODE") == "true"

	if globalKey == "" && !devMode {
		log.Fatal("TACACS_KEY must be set (shared via the soteria .env file)")
	}

	docker := dockerNew(dockerSock, container)
	if !devMode {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := docker.Ping(ctx); err != nil {
			log.Printf("WARNING: %v (validate/reload will fail until the socket is available)", err)
		}
		cancel()
	} else {
		log.Print("WARNING: AGENT_DEV_MODE=true - config validation and reload are DISABLED")
	}

	srv := newServer(configDir, logDir, globalKey, docker, devMode)

	httpServer := &http.Server{
		Addr:              listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("soteria-agent listening on %s (config=%s, container=%s)", listen, configDir, container)
	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
