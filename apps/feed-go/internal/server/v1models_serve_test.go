package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// The bodies the fake compute answers, and the ETag Next's generateETag gives each (node, 2026-11-21).
const (
	v1ListBody   = `{"items":[{"id":1}],"metadata":{}}`
	v1ListETag   = `"vi1v4hbjily"`
	v1DetailBody = `{"id":42,"name":"a"}`
	v1DetailETag = `"ueot6baeh9k"`
)

// v1Upstream is the Node app behind V1Fallback: it counts what it is handed and answers 418.
type v1Upstream struct {
	mu    sync.Mutex
	calls int
	paths []string
}

func (u *v1Upstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u.mu.Lock()
	u.calls++
	u.paths = append(u.paths, r.URL.RequestURI())
	u.mu.Unlock()
	w.WriteHeader(http.StatusTeapot)
}

func (u *v1Upstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.calls
}

// serveV1Server is a Server with the public model routes: on per the argument, a V1Fallback that
// counts, a tRPC Fallback that must never be used, and a model compute that counts its calls and
// answers the list or `[id]` body by path.
func serveV1Server(t *testing.T, reg *prometheus.Registry, on bool) (s *Server, up *v1Upstream, computes *int) {
	t.Helper()
	up, computes = &v1Upstream{}, new(int)
	s = &Server{
		Metrics:       NewMetrics(reg),
		Log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		ServeV1Models: on,
		V1Fallback:    up,
		Fallback: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Error("a model route fell back to the tRPC upstream (FEED_GO_FALLBACK_URL)")
		}),
	}
	s.computeFn = func(context.Context, *http.Request) (*computed, error) {
		panic("the gallery compute must not run on a model route")
	}
	s.computeV1ModelsFn = func(_ context.Context, r *http.Request) (*computed, error) {
		*computes++
		if strings.HasPrefix(r.URL.Path, V1ModelsPath+"/") {
			return &computed{payload: []byte(v1DetailBody)}, nil
		}
		return &computed{payload: []byte(v1ListBody)}, nil
	}
	return s, up, computes
}

func v1Request(target string, headers map[string]string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, target, nil)
	r.Host = "site.example.test"
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func v1Handler(s *Server, target string) http.HandlerFunc {
	if strings.HasPrefix(target, V1ModelsPath+"/") {
		return s.ServeV1ModelsIDHTTP
	}
	return s.ServeV1ModelsHTTP
}

func v1Endpoint(target string) string {
	if strings.HasPrefix(target, V1ModelsPath+"/") {
		return EndpointV1ModelsID
	}
	return EndpointV1Models
}

func v1Count(t *testing.T, reg *prometheus.Registry, endpoint, name string, labels map[string]string) float64 {
	t.Helper()
	l := map[string]string{"feed_endpoint": endpoint, "mode": "serve"}
	for k, v := range labels {
		l[k] = v
	}
	v, _ := metricValue(t, reg, name, l)
	return v
}

// The switch is off unless set: a zero Server, and FEED_GO_SERVE_V1_MODELS unset (config tests).
// Off, every request is the `v1-models-off` fallback: proxied to the /api/v1 upstream as it came,
// nothing computed, no serve slot taken, X-Feed-Go-Served: node.
func TestServeV1ModelsOffProxiesWithoutComputing(t *testing.T) {
	if (&Server{}).ServeV1Models {
		t.Fatal("ServeV1Models is on in a zero Server")
	}
	for _, target := range []string{"/api/v1/models?limit=2", "/api/v1/models/42"} {
		reg := prometheus.NewRegistry()
		s, up, computes := serveV1Server(t, reg, false)
		w := httptest.NewRecorder()
		v1Handler(s, target)(w, v1Request(target, nil))
		if w.Code != http.StatusTeapot || up.count() != 1 || *computes != 0 {
			t.Fatalf("%s off: code=%d proxied=%d computes=%d, want 418, 1, 0", target, w.Code, up.count(), *computes)
		}
		if up.paths[0] != target {
			t.Fatalf("%s off: proxied %q, want the request as it came", target, up.paths[0])
		}
		if got := w.Header().Get(ServedByHeader); got != ServedByNode {
			t.Fatalf("%s off: %s = %q, want node", target, ServedByHeader, got)
		}
		if n := v1Count(t, reg, v1Endpoint(target), "feed_go_fallback_total", map[string]string{"reason": "v1-models-off"}); n != 1 {
			t.Fatalf("%s off: v1-models-off = %v, want 1", target, n)
		}
		if s.InFlight() != 0 {
			t.Fatalf("%s off: a serve slot is held", target)
		}
	}
}

// On, the list is answered here: the computed body, byte for byte, with the headers Node's route
// sends (literal: endpoint-helpers.ts, the config's X-Frame-Options, Next's ETag over the body),
// X-Feed-Go-Served: go, and counted `served` under v1-models. Nothing is proxied.
func TestServeV1ModelsOnServesTheList(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, up, computes := serveV1Server(t, reg, true)
	w := httptest.NewRecorder()
	s.ServeV1ModelsHTTP(w, v1Request("/api/v1/models?limit=2", map[string]string{"Origin": "https://elsewhere.example.test"}))
	if w.Code != http.StatusOK || up.count() != 0 || *computes != 1 {
		t.Fatalf("code=%d proxied=%d computes=%d, want 200, 0, 1", w.Code, up.count(), *computes)
	}
	if got := w.Body.String(); got != v1ListBody {
		t.Fatalf("body = %s, want %s", got, v1ListBody)
	}
	want := map[string]string{
		"X-Frame-Options":              "DENY",
		"Vary":                         "Authorization",
		"Access-Control-Allow-Origin":  "*",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, *",
		"Access-Control-Allow-Methods": "GET",
		"Cache-Control":                "public, s-maxage=300, stale-while-revalidate=150",
		"Etag":                         v1ListETag,
		"Content-Type":                 "application/json; charset=utf-8",
		"Content-Length":               "34",
		ServedByHeader:                 ServedByGo,
	}
	got := map[string]string{}
	for k, v := range w.Header() {
		if len(v) != 1 {
			t.Fatalf("%s written %d times: %q", k, len(v), v)
		}
		got[k] = v[0]
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("headers:\n got  %v\n want %v", got, want)
	}
	if n := v1Count(t, reg, EndpointV1Models, "feed_go_requests_total", map[string]string{"outcome": "served"}); n != 1 {
		t.Fatalf("served (v1-models) = %v, want 1", n)
	}
	if s.InFlight() != 0 {
		t.Fatalf("serve slot not released: %d", s.InFlight())
	}
}

// `[id]`: Node's handler answers every 200 `private, no-store`; a session cookie changes only the
// Vary (the route reads no session, so the answer is served); an answer from the origin cache is
// counted served_cached, as in the shadow.
func TestServeV1ModelsOnServesOneModel(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, up, _ := serveV1Server(t, reg, true)
	w := httptest.NewRecorder()
	s.ServeV1ModelsIDHTTP(w, v1Request("/api/v1/models/42", nil))
	if w.Code != http.StatusOK || up.count() != 0 || w.Body.String() != v1DetailBody {
		t.Fatalf("code=%d proxied=%d body=%s", w.Code, up.count(), w.Body.String())
	}
	if cc, vary, etag := w.Header().Get("Cache-Control"), w.Header().Get("Vary"), w.Header().Get("ETag"); cc != "private, no-store" || vary != "Authorization" || etag != v1DetailETag {
		t.Fatalf("Cache-Control=%q Vary=%q ETag=%q", cc, vary, etag)
	}
	w = httptest.NewRecorder()
	s.ServeV1ModelsIDHTTP(w, v1Request("/api/v1/models/42", map[string]string{"Cookie": "__Secure-civ-token=t"}))
	if w.Code != http.StatusOK || w.Header().Get("Vary") != "Authorization, Cookie" || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("with a session cookie: code=%d Vary=%q Cache-Control=%q", w.Code, w.Header().Get("Vary"), w.Header().Get("Cache-Control"))
	}
	s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(v1DetailBody), cached: true}, nil
	}
	s.ServeV1ModelsIDHTTP(httptest.NewRecorder(), v1Request("/api/v1/models/42", nil))
	if n := v1Count(t, reg, EndpointV1ModelsID, "feed_go_requests_total", map[string]string{"outcome": "served_cached"}); n != 1 {
		t.Fatalf("served_cached (v1-models-id) = %v, want 1", n)
	}
	if n := v1Count(t, reg, EndpointV1ModelsID, "feed_go_requests_total", map[string]string{"outcome": "served"}); n != 2 {
		t.Fatalf("served (v1-models-id) = %v, want 2", n)
	}
}

// Every request whose answer or headers depend on what this service does not read is handed to the
// /api/v1 upstream before anything is computed, under its own reason. Each has a positive control
// below it (the same request without the trigger is served), so each guard is the one deciding.
func TestServeV1ModelsFallsBackBeforeComputing(t *testing.T) {
	for _, c := range []struct {
		name, method, target string
		headers              map[string]string
		reason               string
	}{
		{"list API key", http.MethodGet, "/api/v1/models?limit=2", map[string]string{"Authorization": "Bearer k"}, "bearer-token"},
		{"[id] API key", http.MethodGet, "/api/v1/models/42", map[string]string{"Authorization": "Bearer k"}, "bearer-token"},
		{"list ?token=", http.MethodGet, "/api/v1/models?limit=2&token=k", nil, "bearer-token"},
		{"[id] ?token=", http.MethodGet, "/api/v1/models/42?token=k", nil, "bearer-token"},
		// Node's wrappers read any non-empty `token` (URLSearchParams); Go's url.ParseQuery drops the
		// first two pairs, and the first value of the third is empty.
		{"list ?token= with an invalid escape", http.MethodGet, "/api/v1/models?limit=2&token=abc%zz", nil, "bearer-token"},
		{"list ?token= holding a semicolon", http.MethodGet, "/api/v1/models?limit=2&token=a;b", nil, "bearer-token"},
		{"list ?token= empty, then a value", http.MethodGet, "/api/v1/models?limit=2&token=&token=x", nil, "bearer-token"},
		{"[id] ?token= with an invalid escape", http.MethodGet, "/api/v1/models/42?token=abc%zz", nil, "bearer-token"},
		{"list session cookie", http.MethodGet, "/api/v1/models?limit=2", map[string]string{"Cookie": "a=1; __Secure-civ-token=t"}, "v1-models-session-cookie"},
		{"list legacy session cookie", http.MethodGet, "/api/v1/models?limit=2", map[string]string{"Cookie": "civitai-token=t"}, "v1-models-session-cookie"},
		{"list etag value", http.MethodGet, "/api/v1/models?limit=2&etag=abc", nil, "v1-models-etag"},
		{"list etag repeated", http.MethodGet, "/api/v1/models?etag=&etag=", nil, "v1-models-etag"},
		{"list If-None-Match", http.MethodGet, "/api/v1/models?limit=2", map[string]string{"If-None-Match": `"x"`}, "v1-models-conditional"},
		{"[id] If-Modified-Since", http.MethodGet, "/api/v1/models/42", map[string]string{"If-Modified-Since": "Sat, 21 Nov 2026 00:00:00 GMT"}, "v1-models-conditional"},
		{"[id] Origin", http.MethodGet, "/api/v1/models/42", map[string]string{"Origin": "https://block.example.test"}, "v1-models-origin"},
		{"list POST", http.MethodPost, "/api/v1/models", nil, "method"},
		{"[id] HEAD", http.MethodHead, "/api/v1/models/42", nil, "method"},
	} {
		reg := prometheus.NewRegistry()
		s, up, computes := serveV1Server(t, reg, true)
		r := httptest.NewRequestWithContext(context.Background(), c.method, c.target, nil)
		for k, v := range c.headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		v1Handler(s, c.target)(w, r)
		if w.Code != http.StatusTeapot || up.count() != 1 || *computes != 0 {
			t.Errorf("%s: code=%d proxied=%d computes=%d, want 418, 1, 0", c.name, w.Code, up.count(), *computes)
		}
		if n := v1Count(t, reg, v1Endpoint(c.target), "feed_go_fallback_total", map[string]string{"reason": c.reason}); n != 1 {
			t.Errorf("%s: %s = %v, want 1", c.name, c.reason, n)
		}
		if got := w.Header().Get(ServedByHeader); got != ServedByNode {
			t.Errorf("%s: %s = %q, want node", c.name, ServedByHeader, got)
		}
	}
	// An empty Authorization header is held to the same fallback (Node reads it as absent, a proxy in
	// between may not).
	reg := prometheus.NewRegistry()
	s, up, _ := serveV1Server(t, reg, true)
	r := v1Request("/api/v1/models?limit=2", nil)
	r.Header["Authorization"] = []string{""}
	s.ServeV1ModelsHTTP(httptest.NewRecorder(), r)
	if up.count() != 1 || v1Count(t, reg, EndpointV1Models, "feed_go_fallback_total", map[string]string{"reason": "bearer-token"}) != 1 {
		t.Errorf("empty Authorization: proxied=%d", up.count())
	}
	// Positive controls: each trigger's near miss is served.
	for _, c := range []struct {
		name, target string
		headers      map[string]string
	}{
		{"list, no trigger", "/api/v1/models?limit=2", nil},
		{"list, one empty etag (no database check)", "/api/v1/models?limit=2&etag=", nil},
		{"list, an empty token", "/api/v1/models?limit=2&token=", nil},
		{"list, a non-session cookie", "/api/v1/models?limit=2", map[string]string{"Cookie": "theme=dark"}},
		{"list, any Origin", "/api/v1/models?limit=2", map[string]string{"Origin": "https://block.example.test"}},
		{"[id], no trigger", "/api/v1/models/42", nil},
		{"[id], a session cookie", "/api/v1/models/42", map[string]string{"Cookie": "__Secure-civ-token=t"}},
	} {
		s, up, computes := serveV1Server(t, prometheus.NewRegistry(), true)
		w := httptest.NewRecorder()
		v1Handler(s, c.target)(w, v1Request(c.target, c.headers))
		if w.Code != http.StatusOK || up.count() != 0 || *computes != 1 {
			t.Errorf("%s: code=%d proxied=%d computes=%d, want 200, 0, 1", c.name, w.Code, up.count(), *computes)
		}
	}
}

// The API request policy runs first, as on the tRPC routes: a blocked region is handed to the app,
// which answers its own 451, and a crawler's user agent to the app, which alone can verify it.
func TestServeV1ModelsAPIRequestPolicy(t *testing.T) {
	for _, c := range []struct {
		name    string
		headers map[string]string
		reason  string
	}{
		{"blocked region", map[string]string{"cf-ipcountry": "GB"}, "region-blocked"},
		{"crawler user agent", map[string]string{"User-Agent": crawlerUA}, "crawler-user-agent"},
	} {
		for _, target := range []string{"/api/v1/models?limit=2", "/api/v1/models/42"} {
			reg := prometheus.NewRegistry()
			s, up, computes := serveV1Server(t, reg, true)
			s.RegionBlockRules = blockRules(t)
			v1Handler(s, target)(httptest.NewRecorder(), v1Request(target, c.headers))
			if up.count() != 1 || *computes != 0 || v1Count(t, reg, v1Endpoint(target), "feed_go_fallback_total", map[string]string{"reason": c.reason}) != 1 {
				t.Errorf("%s %s: proxied=%d computes=%d, want 1 and 0 under %s", c.name, target, up.count(), *computes, c.reason)
			}
		}
	}
	// Control: an unblocked region with an ordinary user agent is served.
	s, up, _ := serveV1Server(t, prometheus.NewRegistry(), true)
	s.RegionBlockRules = blockRules(t)
	s.ServeV1ModelsHTTP(httptest.NewRecorder(), v1Request("/api/v1/models?limit=2", map[string]string{"cf-ipcountry": "DE", "User-Agent": "curl/8"}))
	if up.count() != 0 {
		t.Fatal("an unblocked request was proxied")
	}
}

// Fallbacks decided by the compute (a serve slot is taken and released): a full pod, the request
// budget, a not-found `[id]` (Node's 404), a body JSON.stringify would write differently, and a
// client that left (not proxied: nobody would read it).
func TestServeV1ModelsComputeFallbacks(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, up, computes := serveV1Server(t, reg, true)
	s.MaxInFlight = 1
	if !s.acquireServe() {
		t.Fatal("could not take the only serve slot")
	}
	s.ServeV1ModelsHTTP(httptest.NewRecorder(), v1Request("/api/v1/models?limit=2", nil))
	s.releaseServe()
	if up.count() != 1 || *computes != 0 || v1Count(t, reg, EndpointV1Models, "feed_go_fallback_total", map[string]string{"reason": "bulkhead"}) != 1 {
		t.Fatalf("full pod: proxied=%d computes=%d", up.count(), *computes)
	}

	s.RequestBudget = 20 * time.Millisecond
	s.computeV1ModelsFn = func(ctx context.Context, _ *http.Request) (*computed, error) {
		<-ctx.Done()
		return &computed{payload: []byte(v1ListBody)}, nil
	}
	s.ServeV1ModelsHTTP(httptest.NewRecorder(), v1Request("/api/v1/models?limit=2", nil))
	if up.count() != 2 || v1Count(t, reg, EndpointV1Models, "feed_go_fallback_total", map[string]string{"reason": "deadline"}) != 1 {
		t.Fatalf("past the budget: proxied=%d", up.count())
	}
	s.RequestBudget = 0

	s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"error":"No model with id 42"}`), trivial: true, notFound: true}, nil
	}
	w := httptest.NewRecorder()
	s.ServeV1ModelsIDHTTP(w, v1Request("/api/v1/models/42", nil))
	if w.Code != http.StatusTeapot || v1Count(t, reg, EndpointV1ModelsID, "feed_go_fallback_total", map[string]string{"reason": "v1-models-not-found"}) != 1 {
		t.Fatalf("not found: code=%d", w.Code)
	}

	s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"id":42,"name":"a\ufffdb"}`)}, nil
	}
	s.ServeV1ModelsIDHTTP(httptest.NewRecorder(), v1Request("/api/v1/models/42", nil))
	if v1Count(t, reg, EndpointV1ModelsID, "feed_go_fallback_total", map[string]string{"reason": "v1-models-invalid-utf8"}) != 1 {
		t.Fatal("an escaped U+FFFD was served")
	}
	// Control: an escaped U+2028 is served, written raw as JSON.stringify writes it, with its ETag.
	s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"id":42,"name":"a\u2028b"}`)}, nil
	}
	w = httptest.NewRecorder()
	s.ServeV1ModelsIDHTTP(w, v1Request("/api/v1/models/42", nil))
	if w.Code != http.StatusOK || w.Body.String() != "{\"id\":42,\"name\":\"a\u2028b\"}" || w.Header().Get("ETag") != `"ea5y3kfvagm"` {
		t.Fatalf("U+2028: code=%d body=%q ETag=%s", w.Code, w.Body.String(), w.Header().Get("ETag"))
	}

	before := up.count()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := v1Request("/api/v1/models/42", nil).WithContext(ctx)
	s.ServeV1ModelsIDHTTP(httptest.NewRecorder(), r)
	if up.count() != before || v1Count(t, reg, EndpointV1ModelsID, "feed_go_fallback_total", map[string]string{"reason": "canceled"}) != 1 {
		t.Fatalf("client gone: proxied %d more", up.count()-before)
	}
	if s.InFlight() != 0 {
		t.Fatalf("a serve slot is held after every exit: %d", s.InFlight())
	}
}

// Inputs the port does not answer fall back through the real compute (no test hook): the text
// search, a limit Node answers 400, an `[id]` that is not one.
func TestServeV1ModelsUnsupportedInputs(t *testing.T) {
	for _, c := range []struct{ target, reason string }{
		{"/api/v1/models?query=x", "v1-models-query"},
		{"/api/v1/models?limit=500", "v1-models-limit"},
		{"/api/v1/models?tagname=x", "v1-models-tagname"},
		{"/api/v1/models/abc", "v1-models-id"},
		{"/api/v1/models/42/versions", "v1-models-path"},
	} {
		reg := prometheus.NewRegistry()
		up := &v1Upstream{}
		s := &Server{
			Metrics: NewMetrics(reg), Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
			ServeV1Models: true, V1Fallback: up, Resolver: &auth.Resolver{},
			V1Models: &V1ModelsDeps{Deps: &v1models.Deps{Config: v1models.Config{BaseURL: "https://s.example", ImageLocation: "https://i.example"}}},
		}
		v1Handler(s, c.target)(httptest.NewRecorder(), v1Request(c.target, nil))
		if up.count() != 1 || v1Count(t, reg, v1Endpoint(c.target), "feed_go_fallback_total", map[string]string{"reason": c.reason}) != 1 {
			t.Errorf("%s: proxied=%d, want 1 under %s", c.target, up.count(), c.reason)
		}
	}
}

// The serve slots are the one shared pool, and the gauge names the model route holding one; both
// model series exist at 0 before any request.
func TestServeV1ModelsInFlightGauge(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, _, _ := serveV1Server(t, reg, true)
	for _, e := range []string{EndpointV1Models, EndpointV1ModelsID} {
		if g, ok := inFlightOf(t, reg, e); !ok || g != 0 {
			t.Fatalf("%s in-flight before any request = %v (exported %v), want an exported 0", e, g, ok)
		}
		if v, ok := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": e, "mode": "serve", "reason": "bulkhead"}); !ok || v != 0 {
			t.Fatalf("%s bulkhead before any request = %v (exported %v), want an exported 0", e, v, ok)
		}
	}
	started, release := make(chan struct{}), make(chan struct{})
	s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
		close(started)
		<-release
		return &computed{payload: []byte(v1DetailBody)}, nil
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.ServeV1ModelsIDHTTP(httptest.NewRecorder(), v1Request("/api/v1/models/42", nil))
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the compute never started")
	}
	id, _ := inFlightOf(t, reg, EndpointV1ModelsID)
	list, _ := inFlightOf(t, reg, EndpointV1Models)
	held := s.InFlight()
	close(release)
	<-done
	if id != 1 || list != 0 || held != 1 {
		t.Fatalf("during an [id] compute: v1-models-id=%v v1-models=%v slots=%d, want 1, 0, 1", id, list, held)
	}
}

// PublicMux mounts the model routes only with the /api/v1 upstream configured: without it the paths
// are not routed here at all.
func TestPublicMuxMountsTheModelRoutesWithTheirUpstream(t *testing.T) {
	s, up, _ := serveV1Server(t, prometheus.NewRegistry(), false)
	mux := PublicMux(s)
	for _, path := range []string{"/api/v1/models", "/api/v1/models?limit=1", "/api/v1/models/42", "/api/v1/models/42/x"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, v1Request(path, nil))
		if w.Code != http.StatusTeapot {
			t.Errorf("%s: %d, want the upstream's 418", path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, v1Request("/api/v1/modelsx", nil))
	if w.Code != http.StatusNotFound {
		t.Errorf("/api/v1/modelsx: %d, want 404 (not a model route)", w.Code)
	}
	if up.count() != 4 {
		t.Fatalf("upstream calls = %d, want 4", up.count())
	}
	s.V1Fallback = nil
	w = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, v1Request("/api/v1/models", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("without V1Fallback: %d, want 404", w.Code)
	}
}

func TestPublicEndpointNamesTheModelRoutes(t *testing.T) {
	for path, want := range map[string]string{
		"/api/v1/models":      EndpointV1Models,
		"/api/v1/models/42":   EndpointV1ModelsID,
		"/api/v1/models/42/x": EndpointV1ModelsID,
		"/api/v1/modelsx":     "",
		"/api/v1/images":      "",
	} {
		if got := PublicEndpoint(path); got != want {
			t.Errorf("PublicEndpoint(%q) = %q, want %q", path, got, want)
		}
	}
}

// v1ModelsResponse is the header set the public list route writes for v1ListBody, as the Node sampler
// sends it (lowercased): what a matching sample carries.
func v1ModelsResponse(cacheControl string) map[string]string {
	return map[string]string{
		"x-frame-options":              "DENY",
		"vary":                         "Authorization",
		"access-control-allow-origin":  "*",
		"access-control-allow-headers": "Authorization, Content-Type, *",
		"access-control-allow-methods": "GET",
		"cache-control":                cacheControl,
		"etag":                         v1ListETag,
	}
}

func postV1ModelsSample(t *testing.T, s *Server, req ShadowRequest) {
	t.Helper()
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.ShadowV1ModelsHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/api/v1/models", strings.NewReader(string(b))))
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
}

// responseResult reads feed_go_shadow_response_total{feed_endpoint="v1-models",result}.
func responseResult(t *testing.T, reg *prometheus.Registry, result string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": EndpointV1Models, "result": result})
	return v
}

// The shadow compares the model routes' response headers as the tRPC ports' are: the headers the
// public route writes against Node's, over the REST list when the sampler marks it, else over the
// base list (a sampler that predates the REST list). A difference counts its header category.
func TestV1ModelsShadowComparesResponseHeaders(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil)
	s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(v1ListBody)}, nil
	}
	const public = "public, s-maxage=300, stale-while-revalidate=150"
	sample := func(headers map[string]string, set string, reqHeaders map[string]string) ShadowRequest {
		h := map[string]string{"host": "site.example.test"}
		for k, v := range reqHeaders {
			h[k] = v
		}
		return ShadowRequest{Input: "limit=2", Path: V1ModelsPath, Headers: h, Node: json.RawMessage(v1ListBody), ResponseHeaders: headers, ResponseHeaderSet: set}
	}
	settled := func(what string, cond func() bool) {
		t.Helper()
		waitFor(t, what, func() bool { return cond() && len(s.ShadowQueue) == 0 })
	}

	postV1ModelsSample(t, s, sample(v1ModelsResponse(public), ResponseHeaderSetREST, nil))
	settled("the REST match", func() bool { return responseResult(t, reg, "match") == 1 })

	differing := v1ModelsResponse(public)
	differing["etag"] = `"other"`
	differing["x-expires"] = "2026-11-21T00:01:00.000Z"
	postV1ModelsSample(t, s, sample(differing, ResponseHeaderSetREST, nil))
	settled("the REST mismatch", func() bool { return responseResult(t, reg, "mismatch") == 1 })
	for _, d := range []struct{ category, kind string }{{"header:etag", "value"}, {"header:x-expires", "missing-in-go"}} {
		if v, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointV1Models, "category": d.category, "kind": d.kind}); v != 1 {
			t.Errorf("%s/%s = %v, want 1", d.category, d.kind, v)
		}
	}

	// A sampler without the REST list: only the base headers are compared, so the extra ones it never
	// sent are not counted missing.
	postV1ModelsSample(t, s, sample(map[string]string{"cache-control": public, "vary": "Authorization"}, "", nil))
	settled("the base-list match", func() bool { return responseResult(t, reg, "match") == 2 })

	// A verified crawler's sample: the sample's header is the app's decision (the request is marked a
	// sample), so Go writes the private default as Node did.
	crawler := v1ModelsResponse("max-age=0, private, no-cache")
	postV1ModelsSample(t, s, sample(crawler, ResponseHeaderSetREST, map[string]string{verifiedBotHeader: "googlebot"}))
	settled("the crawler match", func() bool { return responseResult(t, reg, "match") == 3 })

	if n := responseResult(t, reg, "uncompared"); n != 0 {
		t.Fatalf("uncompared = %v, want 0", n)
	}
	// No responseHeaders at all: uncompared.
	postV1ModelsSample(t, s, sample(nil, "", nil))
	settled("the uncompared sample", func() bool { return responseResult(t, reg, "uncompared") == 1 })
}

// `[id]` reads the origin cache as Node's handler does when serving (any entry within the TTL), and as
// a sample when the request is one (an entry younger than NodeBuiltWindow is the one Node built for
// the sample, so it is not read). Through the real compute.
func TestComputeV1ModelsIDCacheWindowByMode(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	cache := testkit.NewRedis()
	cache.SetString(v1models.KeyPublicModelResponse+":v2:42:31", jspack.Pack(jspack.Obj{
		{K: "data", V: jspack.Obj{{K: "id", V: int64(42)}, {K: "name", V: "cached"}}},
		{K: "cachedAt", V: float64(now.Add(-time.Second).UnixMilli())},
	}))
	db := &testkit.DB{Routes: []testkit.Route{{Match: `as "cursorId"`, Rows: func([]any) (*testkit.Rows, error) {
		return testkit.NewRows([]string{"id"}), nil
	}}}}
	packed := &hydrate.PackedReader{Redis: cache, Now: func() time.Time { return now }}
	s := &Server{V1Models: &V1ModelsDeps{Deps: &v1models.Deps{
		DB: db, Packed: packed, Sources: &hydrate.Sources{Packed: packed, Cache: cache, Replica: db},
		Gallery: &feed.GalleryStore{Cache: cache, DB: db},
		Addons:  (&feed.AddonSource{Sys: testkit.NewRedis()}).Addons,
		Config:  v1models.Config{ImageLocation: "https://i.example", BaseURL: "https://s.example", ResponseCacheTTL: 180 * time.Second},
		Now:     func() time.Time { return now },
	}}}
	ctx := context.Background()
	c, err := s.computeV1ModelsID(ctx, v1Request("/api/v1/models/42", nil))
	// The cached body, through the Training Data listing (no versions: none listed).
	if err != nil || !c.cached || string(c.payload) != `{"id":42,"name":"cached","modelVersions":[]}` {
		t.Fatalf("public request: %+v %v, want the cached entry", c, err)
	}
	c, err = s.computeV1ModelsID(ctx, v1Request("/api/v1/models/42", nil).WithContext(withSampled(ctx)))
	if err != nil || c.cached || !c.notFound {
		t.Fatalf("sample: %+v %v, want a build (no row: not found)", c, err)
	}
	r, err := SyntheticV1ModelsRequest(ctx, ShadowRequest{Path: "/api/v1/models/42"})
	if err != nil || !isSampled(r.Context()) {
		t.Fatalf("a synthetic model request is not marked a sample: %v", err)
	}
}

// Go never serves a Training Data file by its own rules unless the Node app vouched for them. On a
// public request the statement-hash header is a client's, so it is not read: the vouch is the rule
// sets the Node builds now answering published (V1ModelsDeps.Rules), and only exactly this build's
// lets the listing go on; none, another build's, or a client's header falls back
// (`v1-models-training-data-drift`). A sample's header is Node's: with this build's hash the listing
// goes on. Going on reads the replica (here one with no rows route: `v1-models-training-data-unread`).
func TestV1ModelsTrainingDataHashOnlyFromASample(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	cache := testkit.NewRedis()
	cache.SetString(v1models.KeyPublicModelResponse+":v2:42:31", jspack.Pack(jspack.Obj{
		{K: "data", V: jspack.Obj{{K: "id", V: int64(42)}, {K: "modelVersions", V: []any{jspack.Obj{
			{K: "id", V: int64(7)},
			{K: "files", V: []any{jspack.Obj{{K: "id", V: int64(1)}, {K: "type", V: "Training Data"}}}},
		}}}}},
		{K: "cachedAt", V: float64(now.Add(-time.Minute).UnixMilli())},
	}))
	db := &testkit.DB{}
	packed := &hydrate.PackedReader{Redis: cache, Now: func() time.Time { return now }}
	s := &Server{V1Models: &V1ModelsDeps{Deps: &v1models.Deps{
		DB: db, Packed: packed, Sources: &hydrate.Sources{Packed: packed, Cache: cache, Replica: db},
		Gallery: &feed.GalleryStore{Cache: cache, DB: db},
		Addons:  (&feed.AddonSource{Sys: testkit.NewRedis()}).Addons,
		Config:  v1models.Config{ImageLocation: "https://i.example", BaseURL: "https://s.example", ResponseCacheTTL: 180 * time.Second},
		Now:     func() time.Time { return now },
	}}}
	ctx := context.Background()
	hash := map[string]string{v1models.TrainingDataSQLHeader: v1models.TrainingDataSQLHash}
	this := map[string]string{v1models.TrainingDataSQLHash: "1"}
	another := map[string]string{"0000000000000000000000000000000000000000000000000000000000000000;rules=1": "1"}
	for _, c := range []struct {
		name    string
		sampled bool
		headers map[string]string
		live    map[string]string // the Node builds' published rule sets (nil: none)
		reason  string
	}{
		{"public, no header", false, nil, nil, "v1-models-training-data-drift"},
		{"public, a client sending the hash", false, hash, nil, "v1-models-training-data-drift"},
		{"public, the Node builds publish this build's rules", false, nil, this, "v1-models-training-data-unread"},
		{"public, the Node builds publish another build's rules", false, hash, another, "v1-models-training-data-drift"},
		{"sample, no header", true, nil, this, "v1-models-training-data-drift"},
		{"sample, Node's hash", true, hash, nil, "v1-models-training-data-unread"},
	} {
		live := testkit.NewRedis()
		if c.live != nil {
			live.SetHash(v1models.KeyTrainingDataRulesLive, c.live)
		}
		s.V1Models.Rules = &v1models.TrainingDataRules{Redis: live}
		r := v1Request("/api/v1/models/42", c.headers)
		if c.sampled {
			r = r.WithContext(withSampled(ctx))
		}
		_, err := s.computeV1ModelsID(ctx, r)
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, got, err, c.reason)
		}
	}
}

// The published rule sets are read on a public request only for a body with a Training Data
// candidate, once per such request, and never kept: a body with no Training Data file reads
// nothing; each request with one reads the hash again, so a rule set published between two requests
// decides the second (here another build's starts a rollout: the second falls back as drift).
func TestV1ModelsTrainingDataRulesReadPerRequestThatNeedsThem(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	cache := testkit.NewRedis()
	entry := func(id int64, fileType string) []byte {
		return jspack.Pack(jspack.Obj{
			{K: "data", V: jspack.Obj{{K: "id", V: id}, {K: "modelVersions", V: []any{jspack.Obj{
				{K: "id", V: int64(7)},
				{K: "files", V: []any{jspack.Obj{{K: "id", V: int64(1)}, {K: "type", V: fileType}}}},
			}}}}},
			{K: "cachedAt", V: float64(now.Add(-time.Minute).UnixMilli())},
		})
	}
	cache.SetString(v1models.KeyPublicModelResponse+":v2:42:31", entry(42, "Training Data"))
	cache.SetString(v1models.KeyPublicModelResponse+":v2:43:31", entry(43, "Model"))
	db := &testkit.DB{}
	packed := &hydrate.PackedReader{Redis: cache, Now: func() time.Time { return now }}
	live := testkit.NewRedis()
	live.SetHash(v1models.KeyTrainingDataRulesLive, map[string]string{v1models.TrainingDataSQLHash: "1"})
	s := &Server{V1Models: &V1ModelsDeps{Deps: &v1models.Deps{
		DB: db, Packed: packed, Sources: &hydrate.Sources{Packed: packed, Cache: cache, Replica: db},
		Gallery: &feed.GalleryStore{Cache: cache, DB: db},
		Addons:  (&feed.AddonSource{Sys: testkit.NewRedis()}).Addons,
		Config:  v1models.Config{ImageLocation: "https://i.example", BaseURL: "https://s.example", ResponseCacheTTL: 180 * time.Second},
		Now:     func() time.Time { return now },
	}, Rules: &v1models.TrainingDataRules{Redis: live}}}
	ctx := context.Background()

	if _, err := s.computeV1ModelsID(ctx, v1Request("/api/v1/models/43", nil)); err != nil {
		t.Fatalf("no Training Data file: %v", err)
	}
	if live.Calls != 0 {
		t.Fatalf("no Training Data file: %d reads of the published rules, want 0", live.Calls)
	}
	// Vouched: the listing goes on to the replica (no rows route here).
	_, err := s.computeV1ModelsID(ctx, v1Request("/api/v1/models/42", nil))
	if got := fallback.Reason(err); got != "v1-models-training-data-unread" || live.Calls != 1 {
		t.Fatalf("first Training Data request: %q after %d reads, want %q after 1", got, live.Calls, "v1-models-training-data-unread")
	}
	live.SetHash(v1models.KeyTrainingDataRulesLive, map[string]string{
		v1models.TrainingDataSQLHash: "1",
		"0000000000000000000000000000000000000000000000000000000000000000;rules=2": "1",
	})
	_, err = s.computeV1ModelsID(ctx, v1Request("/api/v1/models/42", nil))
	if got := fallback.Reason(err); got != "v1-models-training-data-drift" || live.Calls != 2 {
		t.Fatalf("second Training Data request: %q after %d reads, want %q after 2", got, live.Calls, "v1-models-training-data-drift")
	}
	// A sample is vouched for by its own header: the published rules are not read.
	r := v1Request("/api/v1/models/42", map[string]string{v1models.TrainingDataSQLHeader: v1models.TrainingDataSQLHash})
	_, err = s.computeV1ModelsID(ctx, r.WithContext(withSampled(ctx)))
	if got := fallback.Reason(err); got != "v1-models-training-data-unread" || live.Calls != 2 {
		t.Fatalf("sample: %q after %d reads, want %q after 2", got, live.Calls, "v1-models-training-data-unread")
	}
}

// The list route is vouched for as `[id]` is: on a public request the published rule sets
// (V1ModelsDeps.Rules) decide a page with a Training Data candidate, so only exactly this build's
// lets the listing go on to the replica (`v1-models-training-data-unread`: its rows route fails
// here); none, or another build's, falls back before the read (`v1-models-training-data-drift`).
// One model, one version with a Training Data file: the cases differ only in the live hash.
func TestV1ModelsListTrainingDataVouchedByPublishedRules(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	at := now.Add(-time.Minute)
	cache := testkit.NewRedis()
	for k, v := range map[string]jspack.Obj{
		v1models.KeyDataForModel + ":5001": {{K: "modelId", V: int64(5001)}, {K: "hashes", V: []any{}}, {K: "tags", V: []any{}}, {K: "versions", V: []any{jspack.Obj{
			{K: "id", V: int64(6001)}, {K: "index", V: int64(0)}, {K: "name", V: "v1"}, {K: "earlyAccessTimeFrame", V: int64(0)},
			{K: "baseModel", V: "SDXL 1.0"}, {K: "status", V: "Published"}, {K: "flags", V: int64(0)}, {K: "availability", V: "Public"},
			{K: "nsfwLevel", V: int64(1)}, {K: "description", V: "d"}, {K: "trainedWords", V: []any{}}, {K: "covered", V: true}, {K: "coveredNext", V: false},
		}}}, {K: "cachedAt", V: at}},
		v1models.KeyModelTags + ":5001":         {{K: "modelId", V: int64(5001)}, {K: "tagIds", V: []any{int64(11)}}, {K: "cachedAt", V: at}},
		v1models.KeyBasicTags + ":11":           {{K: "id", V: int64(11)}, {K: "name", V: "style"}, {K: "cachedAt", V: at}},
		hydrate.KeyBasicUsers + ":1001":         {{K: "id", V: int64(1001)}, {K: "username", V: "artist_one"}, {K: "deletedAt", V: nil}, {K: "image", V: nil}, {K: "cachedAt", V: at}},
		hydrate.KeyProfilePictures + ":1001":    {{K: "notFound", V: true}},
		v1models.KeyPaidAccessVersion + ":6001": {{K: "entityId", V: int64(6001)}, {K: "endsAtMs", V: nil}, {K: "timeframeDays", V: nil}, {K: "cachedAt", V: at}},
		v1models.KeyImagesForVersion + ":6001": {{K: "modelVersionId", V: int64(6001)}, {K: "images", V: []any{jspack.Obj{
			{K: "id", V: int64(8001)}, {K: "url", V: "u1"}, {K: "nsfwLevel", V: int64(1)}, {K: "type", V: "image"}, {K: "poi", V: false}, {K: "minor", V: false},
		}}}, {K: "cachedAt", V: at}},
		v1models.KeyFilesForVersion + ":6001": {{K: "modelVersionId", V: int64(6001)}, {K: "files", V: []any{
			jspack.Obj{{K: "id", V: int64(7001)}, {K: "name", V: "a.safetensors"}, {K: "type", V: "Model"}, {K: "visibility", V: "Public"},
				{K: "modelVersionId", V: int64(6001)}, {K: "hashes", V: []any{}}, {K: "metadata", V: jspack.Obj{{K: "format", V: "SafeTensor"}}}},
			jspack.Obj{{K: "id", V: int64(7002)}, {K: "name", V: "d.zip"}, {K: "type", V: "Training Data"}, {K: "visibility", V: "Public"},
				{K: "modelVersionId", V: int64(6001)}, {K: "hashes", V: []any{}}, {K: "metadata", V: jspack.Obj{}}},
		}}, {K: "cachedAt", V: at}},
		// The default addons exclude tags at every level, so the image's tag ids are read.
		v1models.KeyTagIDsForImages + ":8001": {{K: "imageId", V: int64(8001)}, {K: "tags", V: []any{int64(1)}}, {K: "cachedAt", V: at}},
		v1models.KeyMetricPrivacy + ":1001":   {{K: "hideModelBuzz", V: false}, {K: "hideModelDownloads", V: false}, {K: "hideModelGenerations", V: false}},
	} {
		cache.SetString(k, jspack.Pack(v))
	}
	rows := testkit.NewRows
	none := func(cols ...string) func([]any) (*testkit.Rows, error) {
		return func([]any) (*testkit.Rows, error) { return rows(cols), nil }
	}
	var reads [][]int // the candidates each Training Data read bound
	db := &testkit.DB{Routes: []testkit.Route{
		{Match: `as "cursorId"`, Rows: func([]any) (*testkit.Rows, error) {
			return rows([]string{"id", "name", "allowCommercialUse", "type", "nsfwLevel", "status", "availability", "userId", "cursorId", "meta", "minor", "sfwOnly"},
				[]any{int32(5001), "M", "{Image}", "Checkpoint", int32(1), "Published", "Public", int32(1001), "1|1|5001", map[string]any{}, false, false}), nil
		}},
		{Match: `AS deadline`, Rows: none("modelId")},
		{Match: `FROM "RecommendedResource"`, Rows: none("sourceId", "resourceId", "settings")},
		{Match: `FROM "ModelVersionMetric"`, Rows: none("modelVersionId", "downloadCount", "thumbsUpCount", "thumbsDownCount")},
		{Match: `SELECT id, meta FROM "ModelVersion"`, Rows: none("id", "meta")},
		{Match: `FROM "ModelMetric" WHERE`, Rows: none("modelId", "downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount", "tippedAmountCount")},
		{Match: `AS restricted`, Rows: func(args []any) (*testkit.Rows, error) {
			ids, _ := args[0].([]int)
			reads = append(reads, ids)
			return nil, errors.New("no Training Data rows here")
		}},
	}}
	packed := &hydrate.PackedReader{Redis: cache, Now: func() time.Time { return now }}
	s := &Server{Resolver: &auth.Resolver{}, V1Models: &V1ModelsDeps{Deps: &v1models.Deps{
		DB: db, Packed: packed, Sources: &hydrate.Sources{Packed: packed, Cache: cache, Replica: db},
		Gallery: &feed.GalleryStore{Cache: cache, DB: db},
		Addons:  (&feed.AddonSource{Sys: testkit.NewRedis()}).Addons,
		Config:  v1models.Config{ImageLocation: "https://i.example", BaseURL: "https://s.example", ResponseCacheTTL: 180 * time.Second},
		Now:     func() time.Time { return now },
	}}}
	ctx := context.Background()
	for _, c := range []struct {
		name   string
		live   map[string]string // the Node builds' published rule sets (nil: none)
		reason string
		reads  int
	}{
		{"the Node builds publish this build's rules", map[string]string{v1models.TrainingDataSQLHash: "1"}, "v1-models-training-data-unread", 1},
		{"no Node build has published", nil, "v1-models-training-data-drift", 0},
		{"the Node builds publish another build's rules", map[string]string{"0000000000000000000000000000000000000000000000000000000000000000;rules=1": "1"}, "v1-models-training-data-drift", 0},
	} {
		live := testkit.NewRedis()
		if c.live != nil {
			live.SetHash(v1models.KeyTrainingDataRulesLive, c.live)
		}
		s.V1Models.Rules = &v1models.TrainingDataRules{Redis: live}
		reads = nil
		_, err := s.computeV1Models(ctx, v1Request("/api/v1/models?limit=2", nil))
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, got, err, c.reason)
		}
		// The published rules are read once, for the page's one candidate; the replica only when vouched.
		if live.Calls != 1 || len(reads) != c.reads || (c.reads == 1 && !reflect.DeepEqual(reads[0], []int{6001})) {
			t.Errorf("%s: %d reads of the published rules, Training Data reads %v; want 1 and %d", c.name, live.Calls, reads, c.reads)
		}
	}
}

// The serve-only checks (v1ModelsServeOnly) do not drop the shadow samples the sampler can send: a
// list sample with a session cookie or an `etag` query is still computed and its body compared; an
// `etag` query's response compare is `uncompared` (Node may add X-Expires from its database). The
// same requests on the public route fall back (TestServeV1ModelsFallsBackBeforeComputing).
func TestV1ModelsShadowComparesTheServeOnlyShapes(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, nil)
	computes := 0
	s.computeV1ModelsFn = func(_ context.Context, r *http.Request) (*computed, error) {
		computes++
		if strings.HasPrefix(r.URL.Path, V1ModelsPath+"/") {
			return &computed{payload: []byte(v1DetailBody)}, nil
		}
		return &computed{payload: []byte(v1ListBody)}, nil
	}
	const public = "public, s-maxage=300, stale-while-revalidate=150"
	count := func(endpoint, metric, result string) float64 {
		v, _ := metricValue(t, reg, metric, map[string]string{"feed_endpoint": endpoint, "result": result})
		return v
	}
	post := func(handler http.HandlerFunc, req ShadowRequest) {
		t.Helper()
		b, err := json.Marshal(req)
		if err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		handler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow", strings.NewReader(string(b))))
		if w.Code != http.StatusAccepted {
			t.Fatalf("code %d, want 202", w.Code)
		}
	}
	for i, c := range []struct {
		name, endpoint, path, query string
		handler                     http.HandlerFunc
		reqHeaders, nodeHeaders     map[string]string
		node, response              string
	}{
		{"list with a session cookie", EndpointV1Models, V1ModelsPath, "limit=2", s.ShadowV1ModelsHandler,
			map[string]string{"cookie": "__Secure-civ-token=t"}, nil, v1ListBody, ""},
		{"list with an etag query", EndpointV1Models, V1ModelsPath, "limit=2&etag=abc", s.ShadowV1ModelsHandler,
			nil, map[string]string{"cache-control": public, "x-expires": "2026-11-21T00:01:00.000Z"}, v1ListBody, "uncompared"},
	} {
		h := map[string]string{"host": "site.example.test"}
		for k, v := range c.reqHeaders {
			h[k] = v
		}
		set := ""
		if c.nodeHeaders != nil {
			set = ResponseHeaderSetREST
		}
		before := count(c.endpoint, "feed_go_shadow_compare_total", "match")
		beforeResp := count(c.endpoint, "feed_go_shadow_response_total", c.response)
		post(c.handler, ShadowRequest{Input: c.query, Path: c.path, Headers: h, Node: json.RawMessage(c.node), ResponseHeaders: c.nodeHeaders, ResponseHeaderSet: set})
		waitFor(t, c.name, func() bool {
			return count(c.endpoint, "feed_go_shadow_compare_total", "match") == before+1 && len(s.ShadowQueue) == 0
		})
		if computes != i+1 {
			t.Fatalf("%s: computes = %d, want %d (the sample fell back)", c.name, computes, i+1)
		}
		if c.response != "" {
			if got := count(c.endpoint, "feed_go_shadow_response_total", c.response); got != beforeResp+1 {
				t.Errorf("%s: response %s = %v, want %v", c.name, c.response, got, beforeResp+1)
			}
		}
	}
	for _, e := range []string{EndpointV1Models, EndpointV1ModelsID} {
		if v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": e, "result": "unsupported"}); v != 0 {
			t.Errorf("%s: %v samples fell back", e, v)
		}
	}
}
