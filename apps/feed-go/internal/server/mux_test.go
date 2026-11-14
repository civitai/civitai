package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

var pprofPaths = []string{"/debug/pprof/", "/debug/pprof/cmdline", "/debug/pprof/heap", "/debug/pprof/symbol"}

func statusOf(h http.Handler, path string) int {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w.Code
}

func muxServer() *Server {
	return &Server{
		Metrics:     NewMetrics(prometheus.NewRegistry()),
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		ShadowQueue: make(chan struct{}, 1),
	}
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
}

func TestPprofAbsentWhenToggleOff(t *testing.T) {
	internal := InternalMux(muxServer(), okHandler(), false)
	for _, p := range pprofPaths {
		if code := statusOf(internal, p); code != http.StatusNotFound {
			t.Errorf("internal %s with pprof off: %d, want 404", p, code)
		}
	}
	// Positive control: the mux does serve its other routes.
	if code := statusOf(internal, "/healthz"); code != http.StatusOK {
		t.Fatalf("/healthz: %d, want 200", code)
	}
}

func TestPprofOnInternalMuxOnlyWhenToggleOn(t *testing.T) {
	s := muxServer()
	internal := InternalMux(s, okHandler(), true)
	for _, p := range pprofPaths {
		if code := statusOf(internal, p); code != http.StatusOK {
			t.Errorf("internal %s with pprof on: %d, want 200", p, code)
		}
	}
	if code := statusOf(internal, "/metrics"); code != http.StatusOK {
		t.Errorf("/metrics with pprof on: %d, want 200", code)
	}
	// The public listener never carries pprof (it takes no toggle at all).
	public := PublicMux(s)
	for _, p := range pprofPaths {
		if code := statusOf(public, p); code != http.StatusNotFound {
			t.Errorf("public %s: %d, want 404", p, code)
		}
	}
	for _, p := range []string{"/metrics", "/healthz", "/internal/shadow/" + Procedure} {
		if code := statusOf(public, p); code != http.StatusNotFound {
			t.Errorf("public %s: %d, want 404 (internal routes stay internal)", p, code)
		}
	}
}
