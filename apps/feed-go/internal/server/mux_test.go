package server

import (
	"context"
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
	h.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil))
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
	for _, p := range []string{"/metrics", "/healthz", "/internal/shadow/" + Procedure, "/internal/shadow/api/v1/images", "/internal/shadow/model.getAll", ProbePathPrefix + Procedure} {
		if code := statusOf(public, p); code != http.StatusNotFound {
			t.Errorf("public %s: %d, want 404 (internal routes stay internal)", p, code)
		}
	}
}

// The v1-images shadow is routed on the internal listener: a GET is refused by the handler itself
// (405), not by the mux (404).
func TestV1ImagesShadowRouteOnInternalMux(t *testing.T) {
	internal := InternalMux(muxServer(), okHandler(), false)
	if code := statusOf(internal, "/internal/shadow/api/v1/images"); code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /internal/shadow/api/v1/images: %d, want 405", code)
	}
	if code := statusOf(internal, "/internal/shadow/api/v1/nope"); code != http.StatusNotFound {
		t.Fatalf("unknown shadow path: %d, want 404", code)
	}
}

// The model.getAll shadow is routed on the internal listener (a GET reaches the handler: 405).
func TestModelGetAllShadowRouteOnInternalMux(t *testing.T) {
	internal := InternalMux(muxServer(), okHandler(), false)
	if code := statusOf(internal, "/internal/shadow/model.getAll"); code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /internal/shadow/model.getAll: %d, want 405", code)
	}
}

// The public listener routes /api/trpc/model.getAll to ServeModelGetAllHTTP: with the serve switch
// off (the default) the request reaches the handler and is proxied to the app, never a 404; every
// other procedure stays unrouted.
func TestPublicMuxRoutesModelGetAll(t *testing.T) {
	s := muxServer()
	proxied := 0
	s.Fallback = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied++
		w.WriteHeader(http.StatusTeapot)
	})
	public := PublicMux(s)
	if code := statusOf(public, "/api/trpc/model.getAll"); code != http.StatusTeapot || proxied != 1 {
		t.Fatalf("public /api/trpc/model.getAll (switch off): %d proxied=%d, want 418 from the fallback and 1", code, proxied)
	}
	for _, p := range []string{"/api/trpc/model.getById", "/api/trpc/model.getAll,model.getById", "/api/trpc-go/model.getAll"} {
		if code := statusOf(public, p); code != http.StatusNotFound {
			t.Errorf("public %s: %d, want 404", p, code)
		}
	}
	if proxied != 1 {
		t.Fatalf("an unrouted path reached the fallback: proxied=%d, want 1", proxied)
	}
}

// The public listener routes /api/trpc/image.getInfinite to ServeInfiniteHTTP: with the serve switch
// off (the default) the request reaches the handler and is proxied to the app, never a 404, and is
// counted as the infinite-off fallback; look-alikes and every other procedure stay unrouted.
func TestPublicMuxRoutesInfinite(t *testing.T) {
	s := muxServer()
	reg := prometheus.NewRegistry()
	s.Metrics = NewMetrics(reg)
	proxied := 0
	s.Fallback = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied++
		w.WriteHeader(http.StatusTeapot)
	})
	s.computeInfiniteFn = func(context.Context, *http.Request) (*computed, error) {
		t.Fatal("the switch is off: nothing may be computed")
		return nil, nil
	}
	public := PublicMux(s)
	if code := statusOf(public, "/api/trpc/image.getInfinite"); code != http.StatusTeapot || proxied != 1 {
		t.Fatalf("public /api/trpc/image.getInfinite (switch off): %d proxied=%d, want 418 from the fallback and 1", code, proxied)
	}
	if v, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": "infinite", "mode": "serve", "reason": "infinite-off"}); v != 1 {
		t.Fatalf("infinite-off fallbacks = %v, want 1", v)
	}
	for _, p := range []string{"/api/trpc/image.getInfinite,model.getAll", "/api/trpc/image.getInfiniteX", "/api/trpc-go/image.getInfinite", "/api/trpc/image.get"} {
		if code := statusOf(public, p); code != http.StatusNotFound {
			t.Errorf("public %s: %d, want 404", p, code)
		}
	}
	if proxied != 1 {
		t.Fatalf("an unrouted path reached the fallback: proxied=%d, want 1", proxied)
	}
}
