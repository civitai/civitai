package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// serveModelsServer is a Server for the public model.getAll route: a fallback that counts what it
// proxies, and a model compute that counts its calls and answers modelsEnvelope with ttl.
func serveModelsServer(reg *prometheus.Registry, on bool, ttl *trpc.CacheTTL) (s *Server, proxied, computes *int) {
	proxied, computes = new(int), new(int)
	s = &Server{
		Metrics:          NewMetrics(reg),
		Log:              slog.New(slog.NewTextHandler(io.Discard, nil)),
		AllowedOrigins:   allowed,
		ServeModelGetAll: on,
		Fallback: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			*proxied++
			w.WriteHeader(http.StatusTeapot)
		}),
	}
	s.computeFn = func(context.Context, *http.Request) (*computed, error) {
		panic("the gallery compute must not run on the model.getAll route")
	}
	s.computeModelsFn = func(context.Context, *http.Request) (*computed, error) {
		*computes++
		return &computed{payload: []byte(modelsEnvelope), ttl: ttl}, nil
	}
	return s, proxied, computes
}

// modelsFallbacks reads feed_go_fallback_total{feed_endpoint="model-getall",mode="serve",reason}.
// Keyed on the endpoint: fallbackCount takes the first series with the reason, and the seeded
// as-posts bulkhead series (0) would shadow this route's.
func modelsFallbacks(t *testing.T, reg *prometheus.Registry, reason string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointModelGetAll, "mode": "serve", "reason": reason})
	return v
}

func modelsServeRequest(origin string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/model.getAll?input=%7B%22json%22%3A%7B%7D%7D", nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

func modelsServeCount(t *testing.T, reg *prometheus.Registry, outcome string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": EndpointModelGetAll, "mode": "serve", "outcome": outcome})
	return v
}

// Off (the default): every request is the `model-getall-off` fallback, proxied to the app, and the
// model compute never runs — even for a request that would otherwise be served.
func TestServeModelGetAllOffProxiesWithoutComputing(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, proxied, computes := serveModelsServer(reg, false, nil)
	w := httptest.NewRecorder()
	s.ServeModelGetAllHTTP(w, modelsServeRequest("https://site.example"))
	if w.Code != http.StatusTeapot || *proxied != 1 || *computes != 0 {
		t.Fatalf("off: code=%d proxied=%d computes=%d, want 418, 1, 0", w.Code, *proxied, *computes)
	}
	if n, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointModelGetAll, "mode": "serve", "reason": "model-getall-off"}); n != 1 {
		t.Fatalf("the off fallback is not counted under model-getall: %v", n)
	}
	if s.InFlight() != 0 {
		t.Fatalf("in flight after the off fallback: %d", s.InFlight())
	}
}

// On: an allowed origin is computed and answered here, as a tRPC success envelope with the compute's
// cache policy; nothing is proxied, and the series carry feed_endpoint="model-getall".
func TestServeModelGetAllOnServes(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, proxied, computes := serveModelsServer(reg, true, &trpc.SignedOutTTL)
	w := httptest.NewRecorder()
	s.ServeModelGetAllHTTP(w, modelsServeRequest("https://site.example"))
	if w.Code != http.StatusOK || *proxied != 0 || *computes != 1 {
		t.Fatalf("on: code=%d proxied=%d computes=%d, want 200, 0, 1", w.Code, *proxied, *computes)
	}
	const wantBody = `{"result":{"data":{"json":{"items":[{"id":5001,"name":"a"},{"id":5002,"name":"b"}],"nextCursor":"1|2|3"}}}}`
	if got := w.Body.String(); got != wantBody {
		t.Fatalf("body = %s, want %s", got, wantBody)
	}
	if got := w.Header().Get("Cache-Control"); got != "public, max-age=60, s-maxage=60, stale-while-revalidate=30" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if n := modelsServeCount(t, reg, "served"); n != 1 {
		t.Fatalf("served (model-getall) = %v, want 1", n)
	}
	if v, found := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": EndpointAsPosts, "mode": "serve", "outcome": "served"}); found && v != 0 {
		t.Fatalf("a model.getAll answer was counted under as-posts: %v", v)
	}
	if s.InFlight() != 0 {
		t.Fatalf("serve slot not released: %d", s.InFlight())
	}
}

// On, the public route keeps the gallery route's gates: an origin the app would refuse and a full pod
// are handed to the app without computing.
func TestServeModelGetAllOnKeepsTheGates(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, proxied, computes := serveModelsServer(reg, true, nil)
	s.ServeModelGetAllHTTP(httptest.NewRecorder(), modelsServeRequest(""))
	if *proxied != 1 || *computes != 0 || modelsFallbacks(t, reg, "origin") != 1 {
		t.Fatalf("no origin: proxied=%d computes=%d origin=%v, want 1, 0, 1", *proxied, *computes, modelsFallbacks(t, reg, "origin"))
	}
	s.MaxInFlight = 1
	if !s.acquireServe() {
		t.Fatal("could not take the only serve slot")
	}
	s.ServeModelGetAllHTTP(httptest.NewRecorder(), modelsServeRequest("https://site.example"))
	s.releaseServe()
	if *proxied != 2 || *computes != 0 || modelsFallbacks(t, reg, "bulkhead") != 1 {
		t.Fatalf("full pod: proxied=%d computes=%d bulkhead=%v, want 2, 0, 1", *proxied, *computes, modelsFallbacks(t, reg, "bulkhead"))
	}
	// Positive control: with a slot free the same request is computed.
	w := httptest.NewRecorder()
	s.ServeModelGetAllHTTP(w, modelsServeRequest("https://site.example"))
	if w.Code != http.StatusOK || *computes != 1 {
		t.Fatalf("slot free: code=%d computes=%d, want 200, 1", w.Code, *computes)
	}
	if got := w.Header().Get("Cache-Control"); got == "" || got == "public, max-age=60, s-maxage=60, stale-while-revalidate=30" {
		t.Fatalf("a session answer (no ttl) carried Cache-Control %q, want the private default", got)
	}
	if got := w.Header().Values("Vary"); len(got) != 1 || got[0] != "trpc-accept, accept" {
		t.Fatalf("served model.getAll Vary = %q, want [\"trpc-accept, accept\"]", got)
	}
}

func inFlightOf(t *testing.T, reg *prometheus.Registry, endpoint string) (float64, bool) {
	t.Helper()
	return metricValue(t, reg, "feed_go_serve_in_flight", map[string]string{"feed_endpoint": endpoint})
}

// The serve slots are shared by both public routes, and feed_go_serve_in_flight says which route holds
// them: a model.getAll compute in flight reads under feed_endpoint="model-getall", not "as-posts".
func TestServeModelGetAllInFlightGaugeByEndpoint(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, _, _ := serveModelsServer(reg, true, nil)
	if g, ok := inFlightOf(t, reg, EndpointModelGetAll); !ok || g != 0 {
		t.Fatalf("model-getall in-flight before any request = %v (exported %v), want an exported 0", g, ok)
	}
	started, release := make(chan struct{}), make(chan struct{})
	s.computeModelsFn = func(context.Context, *http.Request) (*computed, error) {
		close(started)
		<-release
		return &computed{payload: []byte(modelsEnvelope)}, nil
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.ServeModelGetAllHTTP(httptest.NewRecorder(), modelsServeRequest("https://site.example"))
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the model.getAll compute never started")
	}
	m, _ := inFlightOf(t, reg, EndpointModelGetAll)
	a, _ := inFlightOf(t, reg, EndpointAsPosts)
	close(release)
	<-done
	if m != 1 || a != 0 {
		t.Fatalf("in flight during a model.getAll compute: model-getall=%v as-posts=%v, want 1 and 0", m, a)
	}
	if g, _ := inFlightOf(t, reg, EndpointModelGetAll); g != 0 || s.InFlight() != 0 {
		t.Fatalf("after the compute: model-getall gauge=%v slots=%d, want 0 and 0", g, s.InFlight())
	}
}

// An answer that loaded no model row (computed.trivial) is still written, but counted as
// `served_empty`, as the shadow path counts it, so the per-served-call figures cover only real work.
func TestServeModelGetAllTrivialIsServedEmpty(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, proxied, _ := serveModelsServer(reg, true, nil)
	s.computeModelsFn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"json":{"items":[],"nextCursor":null}}`), trivial: true}, nil
	}
	w := httptest.NewRecorder()
	s.ServeModelGetAllHTTP(w, modelsServeRequest("https://site.example"))
	if w.Code != http.StatusOK || *proxied != 0 {
		t.Fatalf("trivial answer: code=%d proxied=%d, want 200 and 0", w.Code, *proxied)
	}
	if got := w.Body.String(); got != `{"result":{"data":{"json":{"items":[],"nextCursor":null}}}}` {
		t.Fatalf("body = %s", got)
	}
	if empty, served := modelsServeCount(t, reg, "served_empty"), modelsServeCount(t, reg, "served"); empty != 1 || served != 0 {
		t.Fatalf("served_empty=%v served=%v, want 1 and 0", empty, served)
	}
}
