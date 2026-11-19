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

// infiniteServeEnvelope is what the stubbed image.getInfinite compute answers. Its ids are distinct
// from the gallery and model fixtures', so a body from the wrong compute cannot pass for it.
const infiniteServeEnvelope = `{"json":{"items":[{"id":7101},{"id":7102}],"nextCursor":"7103"}}`

// serveInfiniteServer is a Server for the public image.getInfinite route: a fallback that counts what
// it proxies, and an infinite compute that counts its calls and answers infiniteServeEnvelope with
// ttl. The gallery and model computes panic: neither may run on this route.
func serveInfiniteServer(reg *prometheus.Registry, on bool, ttl *trpc.CacheTTL) (s *Server, proxied, computes *int) {
	proxied, computes = new(int), new(int)
	s = &Server{
		Metrics:        NewMetrics(reg),
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		AllowedOrigins: allowed,
		ServeInfinite:  on,
		Fallback: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			*proxied++
			w.WriteHeader(http.StatusTeapot)
		}),
	}
	s.computeFn = func(context.Context, *http.Request) (*computed, error) {
		panic("the gallery compute must not run on the image.getInfinite route")
	}
	s.computeModelsFn = func(context.Context, *http.Request) (*computed, error) {
		panic("the model.getAll compute must not run on the image.getInfinite route")
	}
	s.computeInfiniteFn = func(context.Context, *http.Request) (*computed, error) {
		*computes++
		return &computed{payload: []byte(infiniteServeEnvelope), ttl: ttl}, nil
	}
	return s, proxied, computes
}

func infiniteServeRequest(origin string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/image.getInfinite?input=%7B%22json%22%3A%7B%7D%7D", nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

// infiniteServeFallbacks reads feed_go_fallback_total{feed_endpoint="infinite",mode="serve",reason}.
func infiniteServeFallbacks(t *testing.T, reg *prometheus.Registry, reason string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": "infinite", "mode": "serve", "reason": reason})
	return v
}

func infiniteServeCount(t *testing.T, reg *prometheus.Registry, outcome string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": "infinite", "mode": "serve", "outcome": outcome})
	return v
}

// Off (the default): every request is the `infinite-off` fallback, proxied to the app, and the
// infinite compute never runs — even for a request that would otherwise be served.
func TestServeInfiniteOffProxiesWithoutComputing(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, proxied, computes := serveInfiniteServer(reg, false, &trpc.SignedOutTTL)
	w := httptest.NewRecorder()
	s.ServeInfiniteHTTP(w, infiniteServeRequest("https://site.example"))
	if w.Code != http.StatusTeapot || *proxied != 1 || *computes != 0 {
		t.Fatalf("off: code=%d proxied=%d computes=%d, want 418, 1, 0", w.Code, *proxied, *computes)
	}
	if n := infiniteServeFallbacks(t, reg, "infinite-off"); n != 1 {
		t.Fatalf(`feed_go_fallback_total{feed_endpoint="infinite",reason="infinite-off"} = %v, want 1`, n)
	}
	if n := infiniteServeCount(t, reg, "fallback"); n != 1 {
		t.Fatalf(`feed_go_requests_total{feed_endpoint="infinite",outcome="fallback"} = %v, want 1`, n)
	}
	if n := infiniteServeCount(t, reg, "served"); n != 0 {
		t.Fatalf("off: served = %v, want 0", n)
	}
}

// Off, no serve slot is taken: the off fallback is decided before the slot. With the pod full a
// request that reached the slot would be the `bulkhead` fallback; off it is `infinite-off`, and the
// in-flight gauge never moves. The positive control (switch on, same full pod) reads `bulkhead`.
func TestServeInfiniteOffTakesNoServeSlot(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, proxied, computes := serveInfiniteServer(reg, false, nil)
	s.MaxInFlight = 1
	if !s.acquireServe() {
		t.Fatal("could not take the only serve slot")
	}
	s.ServeInfiniteHTTP(httptest.NewRecorder(), infiniteServeRequest("https://site.example"))
	if off, bulk := infiniteServeFallbacks(t, reg, "infinite-off"), infiniteServeFallbacks(t, reg, "bulkhead"); off != 1 || bulk != 0 {
		t.Fatalf("off, full pod: infinite-off=%v bulkhead=%v, want 1 and 0 (the off check must precede the slot)", off, bulk)
	}
	if s.InFlight() != 1 {
		t.Fatalf("off: slots in flight = %d, want only the one this test holds", s.InFlight())
	}
	// Positive control: the same request with the switch on reaches the slot and sheds.
	s.ServeInfinite = true
	s.ServeInfiniteHTTP(httptest.NewRecorder(), infiniteServeRequest("https://site.example"))
	s.releaseServe()
	if bulk := infiniteServeFallbacks(t, reg, "bulkhead"); bulk != 1 {
		t.Fatalf("on, full pod: bulkhead=%v, want 1", bulk)
	}
	if *proxied != 2 || *computes != 0 {
		t.Fatalf("proxied=%d computes=%d, want 2, 0", *proxied, *computes)
	}
}

// On: an allowed origin is computed and answered here, as a tRPC success envelope with the compute's
// cache policy; nothing is proxied, and the series carry feed_endpoint="infinite".
func TestServeInfiniteOnServes(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, proxied, computes := serveInfiniteServer(reg, true, &trpc.SignedOutTTL)
	w := httptest.NewRecorder()
	s.ServeInfiniteHTTP(w, infiniteServeRequest("https://site.example"))
	if w.Code != http.StatusOK || *proxied != 0 || *computes != 1 {
		t.Fatalf("on: code=%d proxied=%d computes=%d, want 200, 0, 1", w.Code, *proxied, *computes)
	}
	const wantBody = `{"result":{"data":{"json":{"items":[{"id":7101},{"id":7102}],"nextCursor":"7103"}}}}`
	if got := w.Body.String(); got != wantBody {
		t.Fatalf("body = %s, want %s", got, wantBody)
	}
	if got := w.Header().Get("Cache-Control"); got != "public, max-age=60, s-maxage=60, stale-while-revalidate=30" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if n := infiniteServeCount(t, reg, "served"); n != 1 {
		t.Fatalf("served (infinite) = %v, want 1", n)
	}
	for _, e := range []string{"as-posts", "model-getall"} {
		if v, found := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": e, "mode": "serve", "outcome": "served"}); found && v != 0 {
			t.Fatalf("an image.getInfinite answer was counted under %s: %v", e, v)
		}
	}
	if s.InFlight() != 0 {
		t.Fatalf("serve slot not released: %d", s.InFlight())
	}
}

// On, the public route keeps the gallery route's gates: an origin the app would refuse is handed to
// the app without computing.
func TestServeInfiniteOnKeepsTheOriginGate(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, proxied, computes := serveInfiniteServer(reg, true, nil)
	s.ServeInfiniteHTTP(httptest.NewRecorder(), infiniteServeRequest(""))
	if *proxied != 1 || *computes != 0 || infiniteServeFallbacks(t, reg, "origin") != 1 {
		t.Fatalf("no origin: proxied=%d computes=%d origin=%v, want 1, 0, 1", *proxied, *computes, infiniteServeFallbacks(t, reg, "origin"))
	}
}

// Each public route has its own switch: FEED_GO_SERVE_MODEL_GETALL on does not serve image.getInfinite,
// and FEED_GO_SERVE_INFINITE on does not serve model.getAll.
func TestServeInfiniteSwitchIsItsOwn(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, proxied, computes := serveInfiniteServer(reg, false, nil)
	s.ServeModelGetAll = true
	s.ServeInfiniteHTTP(httptest.NewRecorder(), infiniteServeRequest("https://site.example"))
	if *proxied != 1 || *computes != 0 || infiniteServeFallbacks(t, reg, "infinite-off") != 1 {
		t.Fatalf("model switch on, infinite off: proxied=%d computes=%d, want 1, 0 and one infinite-off", *proxied, *computes)
	}

	reg2 := prometheus.NewRegistry()
	s2, proxied2, _ := serveInfiniteServer(reg2, true, nil)
	s2.ServeModelGetAll = false
	s2.ServeModelGetAllHTTP(httptest.NewRecorder(), modelsServeRequest("https://site.example"))
	if *proxied2 != 1 {
		t.Fatalf("infinite switch on, model off: model.getAll proxied=%d, want 1", *proxied2)
	}
	if v, _ := metricValue(t, reg2, "feed_go_fallback_total", map[string]string{"feed_endpoint": "model-getall", "mode": "serve", "reason": "model-getall-off"}); v != 1 {
		t.Fatalf("infinite switch on, model off: model-getall-off = %v, want 1", v)
	}
}

// The serve slots are shared by every public route, and feed_go_serve_in_flight says which route holds
// them: an image.getInfinite compute in flight reads under feed_endpoint="infinite", which is exported
// at 0 before any request.
func TestServeInfiniteInFlightGaugeByEndpoint(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, _, _ := serveInfiniteServer(reg, true, nil)
	if g, ok := inFlightOf(t, reg, "infinite"); !ok || g != 0 {
		t.Fatalf("infinite in-flight before any request = %v (exported %v), want an exported 0", g, ok)
	}
	if v, ok := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": "infinite", "mode": "serve", "reason": "bulkhead"}); !ok || v != 0 {
		t.Fatalf("infinite bulkhead fallbacks before any request = %v (exported %v), want an exported 0", v, ok)
	}
	started, release := make(chan struct{}), make(chan struct{})
	s.computeInfiniteFn = func(context.Context, *http.Request) (*computed, error) {
		close(started)
		<-release
		return &computed{payload: []byte(infiniteServeEnvelope)}, nil
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.ServeInfiniteHTTP(httptest.NewRecorder(), infiniteServeRequest("https://site.example"))
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the image.getInfinite compute never started")
	}
	i, _ := inFlightOf(t, reg, "infinite")
	a, _ := inFlightOf(t, reg, "as-posts")
	m, _ := inFlightOf(t, reg, "model-getall")
	close(release)
	<-done
	if i != 1 || a != 0 || m != 0 {
		t.Fatalf("in flight during an image.getInfinite compute: infinite=%v as-posts=%v model-getall=%v, want 1, 0, 0", i, a, m)
	}
	if g, _ := inFlightOf(t, reg, "infinite"); g != 0 || s.InFlight() != 0 {
		t.Fatalf("after the compute: infinite gauge=%v slots=%d, want 0 and 0", g, s.InFlight())
	}
}

// A fallback proxy error on the public image.getInfinite path is attributed to its endpoint
// (PublicEndpoint), as the other two public routes' are; any other path stays unattributed.
func TestPublicEndpointCoversEveryPublicRoute(t *testing.T) {
	for path, want := range map[string]string{
		"/api/trpc/image.getImagesAsPostsInfinite": "as-posts",
		"/api/trpc/model.getAll":                   "model-getall",
		"/api/trpc/image.getInfinite":              "infinite",
		"/api/trpc/image.getInfinite,model.getAll": "",
		"/api/trpc/model.getById":                  "",
		"/api/trpc-go/image.getInfinite":           "",
	} {
		if got := PublicEndpoint(path); got != want {
			t.Errorf("PublicEndpoint(%q) = %q, want %q", path, got, want)
		}
	}
}
