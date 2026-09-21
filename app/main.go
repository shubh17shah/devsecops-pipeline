// Command app implements a small HTTP service used as the subject of the
// devsecops-pipeline CI/CD pipeline. It exposes liveness/readiness probes
// and a version endpoint so the pipeline has something concrete to build,
// scan, sign, and deploy.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"
)

// version is injected at build time via:
//
//	go build -ldflags "-X main.version=$(git rev-parse --short HEAD)"
//
// It defaults to "dev" for local, unversioned builds.
var version = "dev"

// server bundles the state needed by the HTTP handlers.
type server struct {
	version   string
	startedAt time.Time
	ready     atomic.Bool
}

func newServer(version string) *server {
	s := &server{
		version:   version,
		startedAt: time.Now(),
	}
	// The service has no external dependencies to warm up today, so it is
	// ready as soon as it is constructed. The atomic.Bool exists so a real
	// readiness check (DB ping, cache warm, downstream health, etc.) can
	// flip it later without changing the handler contract or the probes
	// that depend on it.
	s.ready.Store(true)
	return s
}

type statusResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

type versionResponse struct {
	Version string `json:"version"`
}

type indexResponse struct {
	Service string `json:"service"`
	Version string `json:"version"`
	Uptime  string `json:"uptime"`
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("write response: %v", err)
	}
}

func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, indexResponse{
		Service: "devsecops-pipeline",
		Version: s.version,
		Uptime:  time.Since(s.startedAt).Round(time.Second).String(),
	})
}

func (s *server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Liveness: the process is up and able to handle requests. This must
	// stay cheap and dependency-free so Kubernetes doesn't restart a pod
	// that is merely busy talking to a slow downstream.
	writeJSON(w, http.StatusOK, statusResponse{Status: "ok", Service: "devsecops-pipeline"})
}

func (s *server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.ready.Load() {
		writeJSON(w, http.StatusServiceUnavailable, statusResponse{Status: "not-ready", Service: "devsecops-pipeline"})
		return
	}
	writeJSON(w, http.StatusOK, statusResponse{Status: "ready", Service: "devsecops-pipeline"})
}

func (s *server) handleVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, versionResponse{Version: s.version})
}

func (s *server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/readyz", s.handleReadyz)
	mux.HandleFunc("/version", s.handleVersion)
	return mux
}

// listenAddr resolves the address the HTTP server binds to. LISTEN_ADDR
// overrides the default so the same binary works locally, in a container,
// and in CI without code changes.
func listenAddr() string {
	if addr := os.Getenv("LISTEN_ADDR"); addr != "" {
		return addr
	}
	return ":8080"
}

// healthcheckURL derives the URL the "healthcheck" subcommand probes. It is
// used by the Dockerfile's HEALTHCHECK instruction: the distroless base
// image has no shell and no curl/wget, so the same static binary doubles as
// its own healthcheck client (invoked as `/app healthcheck`).
func healthcheckURL() string {
	addr := listenAddr()
	host, port, err := net.SplitHostPort(addr)
	if err != nil || host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "8080"
	}
	return fmt.Sprintf("http://%s:%s/healthz", host, port)
}

// runHealthcheck performs the actual probe and returns a process exit code:
// 0 when /healthz responds 200, 1 otherwise.
func runHealthcheck() int {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(healthcheckURL())
	if err != nil {
		log.Printf("healthcheck: request failed: %v", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("healthcheck: unexpected status %d", resp.StatusCode)
		return 1
	}
	return 0
}

func runServer() {
	addr := listenAddr()
	srv := newServer(version)

	httpServer := &http.Server{
		Addr:         addr,
		Handler:      srv.routes(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("devsecops-pipeline app version=%s listening on %s", version, addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen and serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("shutdown signal received, draining connections")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Fatalf("graceful shutdown failed: %v", err)
	}
	log.Println("shutdown complete")
}

func main() {
	// `/app healthcheck` is the exec-form CMD run by the Dockerfile's
	// HEALTHCHECK instruction. It reuses this same binary since the
	// distroless final image ships no shell or HTTP client tools.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheck())
	}
	runServer()
}
