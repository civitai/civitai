package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-data-go/internal/config"
	"github.com/civitai/civitai/apps/app-data-go/internal/metrics"
)

// THE SERVICE TOKEN as main wires it (serviceSource): minted as the service client, never the relay
// client; at the relay's endpoint and resource; one self-check fetch at start, logged without the
// token; every fetch counted by outcome.

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestTheServiceTokenIsMintedAsTheServiceClient(t *testing.T) {
	for _, c := range []struct {
		name, answer, outcome, logged string
		status                        int
	}{
		{"minted", `{"access_token":"SVC-JWT-c3a9","expires_in":900}`, "ok", "service token self-check passed", 200},
		{"refused", `{"error":"unauthorized_client"}`, "refused", "service token self-check failed", 400},
	} {
		t.Run(c.name, func(t *testing.T) {
			var mu sync.Mutex
			var users, resources, scopes []string
			hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm()
				u, _, _ := r.BasicAuth()
				mu.Lock()
				users, resources, scopes = append(users, u), append(resources, r.PostForm.Get("resource")), append(scopes, r.PostForm.Get("scope"))
				mu.Unlock()
				w.WriteHeader(c.status)
				_, _ = io.WriteString(w, c.answer)
			}))
			defer hub.Close()
			cfg := &config.Config{
				Relay: &config.Relay{TokenURL: hub.URL, ClientID: "relay-client", ClientSecret: "RELAY-SECRET", Resource: "https://apps.invalid"},
				//nolint:gosec // G101: a synthetic test fixture, not a credential
				Service: &config.ServiceClient{ClientID: "svc-client-7a", ClientSecret: "SVC-SECRET-e05b"},
			}
			reg := prometheus.NewRegistry()
			m := metrics.New(reg, func() (int, int, int, int) { return 0, 0, 0, 0 })
			logs := &syncBuf{}
			tok, refused := serviceSource(t.Context(), cfg, m, slog.New(slog.NewJSONHandler(logs, nil)))
			if tok == nil || refused == nil {
				t.Fatal("no token source with a service client")
			}
			deadline := time.Now().Add(2 * time.Second)
			for !strings.Contains(logs.String(), c.logged) {
				if time.Now().After(deadline) {
					t.Fatalf("no self-check line %q; logs: %s", c.logged, logs)
				}
				time.Sleep(5 * time.Millisecond)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(users) != 1 || users[0] != "svc-client-7a" || resources[0] != "https://apps.invalid" || scopes[0] != "AppsRead" {
				t.Fatalf("🔴 the self-check asked as %v for %v %v; want once, as svc-client-7a for https://apps.invalid AppsRead", users, resources, scopes)
			}
			if got := testutil.ToFloat64(m.ServiceTokenFetches.WithLabelValues(c.outcome)); got != 1 {
				t.Fatalf("app_data_service_token_fetch_total{outcome=%q} = %v; want 1", c.outcome, got)
			}
			if strings.Contains(logs.String(), "SVC-JWT") || strings.Contains(logs.String(), "SECRET") {
				t.Fatalf("🔴 the log carries a token or secret: %s", logs)
			}
		})
	}
}

func TestNoServiceClientIsNoTokenSource(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := metrics.New(reg, func() (int, int, int, int) { return 0, 0, 0, 0 })
	cfg := &config.Config{Relay: &config.Relay{TokenURL: "http://127.0.0.1:1/token", ClientID: "relay-client", ClientSecret: "x"}} //nolint:gosec // G101: a synthetic test fixture, not a credential
	tok, refused := serviceSource(context.Background(), cfg, m, slog.New(slog.DiscardHandler))
	if tok != nil || refused != nil {
		t.Fatal("🔴 a token source without a service client (it would be the relay client's)")
	}
}
