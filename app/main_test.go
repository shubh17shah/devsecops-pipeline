package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestHandlers(t *testing.T) {
	s := newServer("test-version")
	mux := s.routes()

	tests := []struct {
		name       string
		method     string
		path       string
		wantStatus int
		wantBody   string // substring expected in the response body, "" to skip
	}{
		{"index ok", http.MethodGet, "/", http.StatusOK, `"service":"devsecops-pipeline"`},
		{"index method not allowed", http.MethodPost, "/", http.StatusMethodNotAllowed, ""},
		{"index unknown path is 404", http.MethodGet, "/nope", http.StatusNotFound, ""},
		{"healthz ok", http.MethodGet, "/healthz", http.StatusOK, `"status":"ok"`},
		{"healthz method not allowed", http.MethodPost, "/healthz", http.StatusMethodNotAllowed, ""},
		{"readyz ok", http.MethodGet, "/readyz", http.StatusOK, `"status":"ready"`},
		{"readyz method not allowed", http.MethodDelete, "/readyz", http.StatusMethodNotAllowed, ""},
		{"version ok", http.MethodGet, "/version", http.StatusOK, `"version":"test-version"`},
		{"version method not allowed", http.MethodPost, "/version", http.StatusMethodNotAllowed, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			rec := httptest.NewRecorder()

			mux.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d (body=%s)", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantBody != "" && !strings.Contains(rec.Body.String(), tt.wantBody) {
				t.Fatalf("body = %q, want substring %q", rec.Body.String(), tt.wantBody)
			}
		})
	}
}

func TestReadyzReflectsReadyState(t *testing.T) {
	s := newServer("test-version")
	s.ready.Store(false)

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()

	s.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}

	var got statusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Status != "not-ready" {
		t.Fatalf("status field = %q, want %q", got.Status, "not-ready")
	}
}

func TestVersionResponseIsValidJSON(t *testing.T) {
	s := newServer("v1.2.3")
	req := httptest.NewRequest(http.MethodGet, "/version", nil)
	rec := httptest.NewRecorder()

	s.routes().ServeHTTP(rec, req)

	var got versionResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Version != "v1.2.3" {
		t.Fatalf("version = %q, want %q", got.Version, "v1.2.3")
	}
}

func TestContentTypeIsJSON(t *testing.T) {
	s := newServer("test-version")
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	s.routes().ServeHTTP(rec, req)

	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json prefix", ct)
	}
}

// TestRunHealthcheck exercises the same code path the Dockerfile's
// HEALTHCHECK instruction relies on: `/app healthcheck` making a real HTTP
// call against a running instance and translating the result into a
// process exit code.
func TestRunHealthcheck(t *testing.T) {
	s := newServer("test-version")
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	u, err := url.Parse(ts.URL)
	if err != nil {
		t.Fatalf("parse test server url: %v", err)
	}

	t.Run("healthy service exits 0", func(t *testing.T) {
		t.Setenv("LISTEN_ADDR", u.Host)
		if got := runHealthcheck(); got != 0 {
			t.Fatalf("runHealthcheck() = %d, want 0", got)
		}
	})

	t.Run("unreachable service exits 1", func(t *testing.T) {
		t.Setenv("LISTEN_ADDR", "127.0.0.1:1")
		if got := runHealthcheck(); got != 1 {
			t.Fatalf("runHealthcheck() = %d, want 1", got)
		}
	})
}

func TestHealthcheckURLDefaultsLoopback(t *testing.T) {
	tests := []struct {
		name    string
		envAddr string
		want    string
	}{
		{"empty env uses default port", "", "http://127.0.0.1:8080/healthz"},
		{"bare port", ":9090", "http://127.0.0.1:9090/healthz"},
		{"wildcard host rewritten to loopback", "0.0.0.0:8080", "http://127.0.0.1:8080/healthz"},
		{"explicit host preserved", "localhost:8080", "http://localhost:8080/healthz"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("LISTEN_ADDR", tt.envAddr)
			if got := healthcheckURL(); got != tt.want {
				t.Fatalf("healthcheckURL() = %q, want %q", got, tt.want)
			}
		})
	}
}
