package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
)

// The public GET /api/v1/images route (v1images_serve.go). The fake compute answers v1ListBody, whose
// Next ETag (`"vi1v4hbjily"`, node, 2026-11-21) the model tests pin as v1ListETag.

const (
	publicCC  = "public, s-maxage=300, stale-while-revalidate=150"
	noStoreCC = "private, no-store"
)

// serveV1ImagesServer is a Server with the public images route: on per the argument, a V1ImagesFallback
// that counts, a tRPC Fallback that must never be used, and an images compute that counts its calls.
func serveV1ImagesServer(t *testing.T, reg *prometheus.Registry, on bool) (s *Server, up *v1Upstream, computes *int) {
	t.Helper()
	up, computes = &v1Upstream{}, new(int)
	s = &Server{
		Metrics:       NewMetrics(reg),
		Log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		ServeV1Images: on,
		// The route's one upstream; the /api/v1 one must never be used for it.
		V1ImagesFallback: up,
		V1Fallback: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Error("the images route fell back to the /api/v1 upstream (FEED_GO_V1_FALLBACK_URL)")
		}),
		Fallback: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Error("the images route fell back to the tRPC upstream (FEED_GO_FALLBACK_URL)")
		}),
	}
	s.computeFn = func(context.Context, *http.Request) (*computed, error) {
		panic("the gallery compute must not run on the images route")
	}
	s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
		panic("the model compute must not run on the images route")
	}
	s.computeV1Fn = func(context.Context, *http.Request) (*computed, error) {
		*computes++
		return &computed{payload: []byte(v1ListBody)}, nil
	}
	return s, up, computes
}

func imagesCount(t *testing.T, reg *prometheus.Registry, name string, labels map[string]string) float64 {
	t.Helper()
	return v1Count(t, reg, EndpointV1Images, name, labels)
}

// Off (the default: a zero Server, and FEED_GO_SERVE_V1_IMAGES unset in the config tests) every
// request is the `v1-images-off` fallback: proxied to the /api/v1 upstream as it came, nothing
// computed, no serve slot taken, X-Feed-Go-Served: node.
func TestServeV1ImagesOffProxiesWithoutComputing(t *testing.T) {
	if (&Server{}).ServeV1Images {
		t.Fatal("ServeV1Images is on in a zero Server")
	}
	for _, target := range []string{"/api/v1/images?limit=2", "/api/v1/images?imageId=5&token=k"} {
		reg := prometheus.NewRegistry()
		s, up, computes := serveV1ImagesServer(t, reg, false)
		w := httptest.NewRecorder()
		s.ServeV1ImagesHTTP(w, v1Request(target, map[string]string{"Cookie": "__Secure-civ-token=t"}))
		if w.Code != http.StatusTeapot || up.count() != 1 || *computes != 0 {
			t.Fatalf("%s off: code=%d proxied=%d computes=%d, want 418, 1, 0", target, w.Code, up.count(), *computes)
		}
		if up.paths[0] != target {
			t.Fatalf("%s off: proxied %q, want the request as it came", target, up.paths[0])
		}
		if got := w.Header().Get(ServedByHeader); got != ServedByNode {
			t.Fatalf("%s off: %s = %q, want node", target, ServedByHeader, got)
		}
		if n := imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "v1-images-off"}); n != 1 {
			t.Fatalf("%s off: v1-images-off = %v, want 1", target, n)
		}
		if s.InFlight() != 0 {
			t.Fatalf("%s off: a serve slot is held", target)
		}
	}
}

// Switch off, the route is byte for byte the Node app's answer: status, body and every header the
// upstream wrote, plus X-Feed-Go-Served: node; and the other public routes and the shadow are
// untouched by the switch (the models route still answers with its own switch on).
func TestServeV1ImagesSwitchOffIsUnchanged(t *testing.T) {
	const nodeBody = `{"items":[{"id":7}],"metadata":{}}`
	node := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Length", "34")
		w.Header().Set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=150")
		w.Header().Set("ETag", `"node-etag"`)
		w.Header().Set("X-Handled-By", "node-pod")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, nodeBody)
	})
	reg := prometheus.NewRegistry()
	s, _, computes := serveV1ImagesServer(t, reg, false)
	s.V1ImagesFallback = node
	s.ServeV1Models = true
	mux := PublicMux(s)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, v1Request("/api/v1/images?limit=2", map[string]string{"If-None-Match": v1ListETag}))
	want := map[string]string{
		"Cache-Control":  "public, s-maxage=300, stale-while-revalidate=150",
		"Etag":           `"node-etag"`,
		"X-Handled-By":   "node-pod",
		ServedByHeader:   ServedByNode,
		"Content-Type":   "application/json; charset=utf-8",
		"Content-Length": "34",
	}
	got := map[string]string{}
	for k, v := range w.Header() {
		got[k] = strings.Join(v, ",")
	}
	if w.Code != http.StatusOK || w.Body.String() != nodeBody || !reflect.DeepEqual(got, want) || *computes != 0 {
		t.Fatalf("off: code=%d body=%s computes=%d headers:\n got  %v\n want %v", w.Code, w.Body.String(), *computes, got, want)
	}
	// The models route keeps its own switch: on, it computes (the fake model compute panics, so
	// route it to a counting one).
	modelComputes := 0
	s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
		modelComputes++
		return &computed{payload: []byte(v1ListBody)}, nil
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, v1Request("/api/v1/models?limit=2", nil))
	if w.Code != http.StatusOK || modelComputes != 1 || *computes != 0 {
		t.Fatalf("models with images off: code=%d model computes=%d image computes=%d", w.Code, modelComputes, *computes)
	}
}

// On, the list is answered here: the computed body, byte for byte, with the headers Node's route
// sends (literal: PublicEndpoint in endpoint-helpers.ts, the config's X-Frame-Options, Next's ETag
// over the body), X-Feed-Go-Served: go, counted `served` under v1-images. Nothing is proxied; any
// Origin is answered (PublicEndpoint's CORS is `*`, and the route has no block scope).
func TestServeV1ImagesOnServesThePage(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, up, computes := serveV1ImagesServer(t, reg, true)
	w := httptest.NewRecorder()
	s.ServeV1ImagesHTTP(w, v1Request("/api/v1/images?limit=2", map[string]string{"Origin": "https://elsewhere.example.test", "Cookie": "theme=dark"}))
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
		"Cache-Control":                publicCC,
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
	if n := imagesCount(t, reg, "feed_go_requests_total", map[string]string{"outcome": "served"}); n != 1 {
		t.Fatalf("served (v1-images) = %v, want 1", n)
	}
	if s.InFlight() != 0 {
		t.Fatalf("serve slot not released: %d", s.InFlight())
	}
	s.computeV1Fn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"items":[],"metadata":{}}`), trivial: true}, nil
	}
	s.ServeV1ImagesHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=0", nil))
	if n := imagesCount(t, reg, "feed_go_requests_total", map[string]string{"outcome": "served_empty"}); n != 1 {
		t.Fatalf("served_empty (v1-images) = %v, want 1", n)
	}
}

// The handler's own Cache-Control: `private, no-store` when the requested level (browsingLevel, else
// nsfw, else PG; before any region clamp) is not within SFW (an integer from 0 to PG|PG-13 whose
// bits are all SFW), the wrapper's public one otherwise. Literal, from handleImagesRequest's
// withinSfw.
func TestServeV1ImagesCacheControlByRequestedLevel(t *testing.T) {
	for query, want := range map[string]string{
		"limit=2":                    publicCC,
		"browsingLevel=0":            publicCC,
		"browsingLevel=1":            publicCC,
		"browsingLevel=2":            publicCC,
		"browsingLevel=3":            publicCC,
		"browsingLevel=4":            noStoreCC,
		"browsingLevel=7":            noStoreCC,
		"browsingLevel=31":           noStoreCC,
		"nsfw=false":                 publicCC,
		"nsfw=None":                  publicCC,
		"nsfw=Soft":                  publicCC,
		"nsfw=Mature":                noStoreCC,
		"nsfw=X":                     noStoreCC,
		"nsfw=true":                  noStoreCC,
		"browsingLevel=1&nsfw=true":  publicCC,
		"nsfw=Soft&browsingLevel=16": noStoreCC,
	} {
		s, _, _ := serveV1ImagesServer(t, prometheus.NewRegistry(), true)
		w := httptest.NewRecorder()
		s.ServeV1ImagesHTTP(w, v1Request("/api/v1/images?"+query, nil))
		if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != want {
			t.Errorf("%s: code=%d Cache-Control=%q, want 200 and %q", query, w.Code, w.Header().Get("Cache-Control"), want)
		}
	}
}

// Every request whose answer or headers depend on what this service does not serve is handed to the
// /api/v1 upstream before anything is computed, under its own reason: any credential (the
// credentialed hand-back: an API key, a `?token=`, a session cookie of any session name), a
// conditional header fresh would read differently, a method other than GET. Each has a positive
// control below it (the near miss is served), so each guard is the one deciding.
func TestServeV1ImagesFallsBackBeforeComputing(t *testing.T) {
	for _, c := range []struct {
		name, method, target string
		headers              map[string]string
		reason               string
	}{
		{"API key", http.MethodGet, "/api/v1/images?limit=2", map[string]string{"Authorization": "Bearer k"}, "bearer-token"},
		{"?token=", http.MethodGet, "/api/v1/images?limit=2&token=k", nil, "bearer-token"},
		{"?token= with an invalid escape", http.MethodGet, "/api/v1/images?limit=2&token=abc%zz", nil, "bearer-token"},
		{"session cookie", http.MethodGet, "/api/v1/images?limit=2", map[string]string{"Cookie": "a=1; __Secure-civ-token=t"}, "v1-images-session-cookie"},
		{"host session cookie", http.MethodGet, "/api/v1/images?limit=2", map[string]string{"Cookie": "__Host-civ-token=t"}, "v1-images-session-cookie"},
		{"legacy session cookie", http.MethodGet, "/api/v1/images?limit=2", map[string]string{"Cookie": "civitai-token=t"}, "v1-images-session-cookie"},
		{"empty session cookie", http.MethodGet, "/api/v1/images?limit=2", map[string]string{"Cookie": "civ-token="}, "v1-images-session-cookie"},
		{"non-ASCII If-None-Match", http.MethodGet, "/api/v1/images?limit=2", map[string]string{"If-None-Match": "\"\xc3\xa9\""}, "v1-images-conditional"},
		{"non-ASCII If-Modified-Since", http.MethodGet, "/api/v1/images?limit=2", map[string]string{"If-Modified-Since": "Sat, 21 Nov 2026 00:00:00 GMT\xa0"}, "v1-images-conditional"},
		{"POST", http.MethodPost, "/api/v1/images", nil, "method"},
		{"HEAD", http.MethodHead, "/api/v1/images?limit=2", nil, "method"},
		{"OPTIONS preflight", http.MethodOptions, "/api/v1/images", map[string]string{"Origin": "https://x.example.test"}, "method"},
	} {
		reg := prometheus.NewRegistry()
		s, up, computes := serveV1ImagesServer(t, reg, true)
		r := httptest.NewRequestWithContext(context.Background(), c.method, c.target, nil)
		for k, v := range c.headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		s.ServeV1ImagesHTTP(w, r)
		if w.Code != http.StatusTeapot || up.count() != 1 || *computes != 0 {
			t.Errorf("%s: code=%d proxied=%d computes=%d, want 418, 1, 0", c.name, w.Code, up.count(), *computes)
		}
		if n := imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": c.reason}); n != 1 {
			t.Errorf("%s: %s = %v, want 1", c.name, c.reason, n)
		}
		if got := w.Header().Get(ServedByHeader); got != ServedByNode {
			t.Errorf("%s: %s = %q, want node", c.name, ServedByHeader, got)
		}
	}
	// An empty Authorization header is held to the same fallback.
	reg := prometheus.NewRegistry()
	s, up, _ := serveV1ImagesServer(t, reg, true)
	r := v1Request("/api/v1/images?limit=2", nil)
	r.Header["Authorization"] = []string{""}
	s.ServeV1ImagesHTTP(httptest.NewRecorder(), r)
	if up.count() != 1 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "bearer-token"}) != 1 {
		t.Errorf("empty Authorization: proxied=%d", up.count())
	}
	// Positive controls: each trigger's near miss is served.
	for _, c := range []struct {
		name, target string
		headers      map[string]string
	}{
		{"no trigger", "/api/v1/images?limit=2", nil},
		{"an empty token", "/api/v1/images?limit=2&token=", nil},
		{"a non-session cookie", "/api/v1/images?limit=2", map[string]string{"Cookie": "theme=dark; civ-token-x=1"}},
		{"any Origin", "/api/v1/images?limit=2", map[string]string{"Origin": "https://block.example.test"}},
		{"an ASCII conditional request", "/api/v1/images?limit=2", map[string]string{"If-None-Match": `"other"`}},
	} {
		s, up, computes := serveV1ImagesServer(t, prometheus.NewRegistry(), true)
		w := httptest.NewRecorder()
		s.ServeV1ImagesHTTP(w, v1Request(c.target, c.headers))
		if w.Code != http.StatusOK || up.count() != 0 || *computes != 1 {
			t.Errorf("%s: code=%d proxied=%d computes=%d, want 200, 0, 1", c.name, w.Code, up.count(), *computes)
		}
	}
}

// A conditional request is answered as Next's res.json answers it (fresh over the answer's ETag): a
// matching If-None-Match (exact, weak, `*`, in a list) is a 304 with no body; a mismatch, any
// If-Modified-Since, or a request Cache-Control naming no-cache is the normal 200. Computed once and
// counted served either way; none is proxied.
func TestServeV1ImagesConditionalRequests(t *testing.T) {
	const ims = "Sat, 21 Nov 2026 00:00:00 GMT"
	for _, c := range []struct {
		name    string
		headers map[string]string
		code    int
	}{
		{"exact", map[string]string{"If-None-Match": v1ListETag}, http.StatusNotModified},
		{"weak", map[string]string{"If-None-Match": "W/" + v1ListETag}, http.StatusNotModified},
		{"star", map[string]string{"If-None-Match": "*"}, http.StatusNotModified},
		{"in a list", map[string]string{"If-None-Match": `"x", ` + v1ListETag}, http.StatusNotModified},
		{"mismatch", map[string]string{"If-None-Match": v1DetailETag}, http.StatusOK},
		{"If-Modified-Since", map[string]string{"If-Modified-Since": ims}, http.StatusOK},
		{"both headers", map[string]string{"If-None-Match": v1ListETag, "If-Modified-Since": ims}, http.StatusOK},
		{"no-cache", map[string]string{"If-None-Match": v1ListETag, "Cache-Control": "no-cache"}, http.StatusOK},
	} {
		reg := prometheus.NewRegistry()
		s, up, computes := serveV1ImagesServer(t, reg, true)
		w := httptest.NewRecorder()
		s.ServeV1ImagesHTTP(w, v1Request("/api/v1/images?limit=2", c.headers))
		if w.Code != c.code || up.count() != 0 || *computes != 1 {
			t.Errorf("%s: code=%d proxied=%d computes=%d, want %d, 0, 1", c.name, w.Code, up.count(), *computes, c.code)
			continue
		}
		wantBody := v1ListBody
		if c.code == http.StatusNotModified {
			wantBody = ""
		}
		if got := w.Body.String(); got != wantBody {
			t.Errorf("%s: body %q, want %q", c.name, got, wantBody)
		}
		if w.Header().Get("ETag") != v1ListETag {
			t.Errorf("%s: ETag %q, want %s", c.name, w.Header().Get("ETag"), v1ListETag)
		}
		if n := imagesCount(t, reg, "feed_go_requests_total", map[string]string{"outcome": "served"}); n != 1 {
			t.Errorf("%s: served = %v, want 1", c.name, n)
		}
	}
	// Repeated lines of a header fresh reads: handed to the app.
	reg := prometheus.NewRegistry()
	s, up, computes := serveV1ImagesServer(t, reg, true)
	r := v1Request("/api/v1/images?limit=2", nil)
	r.Header["If-None-Match"] = []string{`"x"`, v1ListETag}
	s.ServeV1ImagesHTTP(httptest.NewRecorder(), r)
	if up.count() != 1 || *computes != 0 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "v1-images-conditional"}) != 1 {
		t.Errorf("repeated If-None-Match: proxied=%d computes=%d, want a v1-images-conditional fallback", up.count(), *computes)
	}
}

// The 304 on the wire (a real server): every header the 200 carries except Content-Type and
// Content-Length, which net/http drops from a 304 (the one divergence, DESIGN.md §16.8), plus Date.
func TestServeV1ImagesNotModifiedHeaderSet(t *testing.T) {
	s, _, _ := serveV1ImagesServer(t, prometheus.NewRegistry(), true)
	srv := httptest.NewServer(http.HandlerFunc(s.ServeV1ImagesHTTP))
	defer srv.Close()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL+"/api/v1/images?browsingLevel=31", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("If-None-Match", v1ListETag)
	req.Header.Set("User-Agent", "")
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if res.StatusCode != http.StatusNotModified || len(body) != 0 {
		t.Fatalf("%d with %d body bytes, want 304 with none", res.StatusCode, len(body))
	}
	got := map[string]string{}
	for k, v := range res.Header {
		got[k] = strings.Join(v, ",")
	}
	if got["Date"] == "" {
		t.Error("no Date")
	}
	delete(got, "Date")
	want := map[string]string{
		"X-Frame-Options":              "DENY",
		"Vary":                         "Authorization",
		"Access-Control-Allow-Origin":  "*",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, *",
		"Access-Control-Allow-Methods": "GET",
		"Cache-Control":                noStoreCC,
		"Etag":                         v1ListETag,
		"X-Feed-Go-Served":             "go",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("304 headers:\n got  %v\n want %v", got, want)
	}
}

// The API request policy runs first: a blocked region is handed to the app (its own 451), and a
// crawler's user agent to the app, which alone can verify it.
func TestServeV1ImagesAPIRequestPolicy(t *testing.T) {
	for _, c := range []struct {
		name    string
		headers map[string]string
		reason  string
	}{
		{"blocked region", map[string]string{"cf-ipcountry": "GB"}, "region-blocked"},
		{"crawler user agent", map[string]string{"User-Agent": crawlerUA}, "crawler-user-agent"},
	} {
		reg := prometheus.NewRegistry()
		s, up, computes := serveV1ImagesServer(t, reg, true)
		s.RegionBlockRules = blockRules(t)
		s.ServeV1ImagesHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=2", c.headers))
		if up.count() != 1 || *computes != 0 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": c.reason}) != 1 {
			t.Errorf("%s: proxied=%d computes=%d, want 1 and 0 under %s", c.name, up.count(), *computes, c.reason)
		}
	}
	s, up, _ := serveV1ImagesServer(t, prometheus.NewRegistry(), true)
	s.RegionBlockRules = blockRules(t)
	s.ServeV1ImagesHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=2", map[string]string{"cf-ipcountry": "DE", "User-Agent": "curl/8"}))
	if up.count() != 0 {
		t.Fatal("an unblocked request was proxied")
	}
}

// Fallbacks decided by the compute (a serve slot is taken and released): a full pod, the request
// budget, a body JSON.stringify would write differently, and a client that left (not proxied).
func TestServeV1ImagesComputeFallbacks(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, up, computes := serveV1ImagesServer(t, reg, true)
	s.MaxInFlight = 1
	if !s.acquireServe() {
		t.Fatal("could not take the only serve slot")
	}
	s.ServeV1ImagesHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=2", nil))
	s.releaseServe()
	if up.count() != 1 || *computes != 0 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "bulkhead"}) != 1 {
		t.Fatalf("full pod: proxied=%d computes=%d", up.count(), *computes)
	}

	s.RequestBudget = 20 * time.Millisecond
	s.computeV1Fn = func(ctx context.Context, _ *http.Request) (*computed, error) {
		<-ctx.Done()
		return &computed{payload: []byte(v1ListBody)}, nil
	}
	s.ServeV1ImagesHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=2", nil))
	if up.count() != 2 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "deadline"}) != 1 {
		t.Fatalf("past the budget: proxied=%d", up.count())
	}
	s.RequestBudget = 0

	s.computeV1Fn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"items":[{"id":1,"name":"a\ufffdb"}],"metadata":{}}`)}, nil
	}
	s.ServeV1ImagesHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=2", nil))
	if imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "v1-images-invalid-utf8"}) != 1 {
		t.Fatal("an escaped U+FFFD was served")
	}
	// Control: an escaped U+2028 is served, written raw as JSON.stringify writes it, with the ETag
	// Next gives that text (node, 2026-11-21; TestServeV1ModelsComputeFallbacks pins the same).
	s.computeV1Fn = func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`{"id":42,"name":"a\u2028b"}`)}, nil
	}
	w := httptest.NewRecorder()
	s.ServeV1ImagesHTTP(w, v1Request("/api/v1/images?limit=2", nil))
	if w.Code != http.StatusOK || w.Body.String() != "{\"id\":42,\"name\":\"a\u2028b\"}" || w.Header().Get("ETag") != `"ea5y3kfvagm"` {
		t.Fatalf("U+2028: code=%d body=%q ETag=%s", w.Code, w.Body.String(), w.Header().Get("ETag"))
	}

	before := up.count()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.ServeV1ImagesHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=2", nil).WithContext(ctx))
	if up.count() != before || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "canceled"}) != 1 {
		t.Fatalf("client gone: proxied %d more", up.count()-before)
	}
	if s.InFlight() != 0 {
		t.Fatalf("a serve slot is held after every exit: %d", s.InFlight())
	}
}

// Through the real compute (no test hook): query keys and shapes the port does not answer, a session
// the resolver resolves whatever cookie carried it (the route serves signed-out callers only), and an
// absolute-form request line (the Host header Node reads for nextPage is gone).
func TestServeV1ImagesUnsupportedInputs(t *testing.T) {
	newServer := func(reg *prometheus.Registry, up *v1Upstream) *Server {
		return &Server{
			Metrics: NewMetrics(reg), Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
			ServeV1Images: true, V1ImagesFallback: up, Resolver: &auth.Resolver{}, V1: &feed.V1Deps{},
		}
	}
	for _, c := range []struct{ target, reason string }{
		{"/api/v1/images?foo=bar&limit=2", "input-unknown-key"},
		{"/api/v1/images?imageId=5", "v1-image-id"},
		{"/api/v1/images?tags=1", "v1-tags"},
		{"/api/v1/images?baseModels=SDXL", "v1-base-models"},
		{"/api/v1/images?modelId=5", "v1-model-only"},
		{"/api/v1/images?limit=500", "v1-input-number"},
		{"/api/v1/images?sort=Random", "v1-sort"},
		{"/api/v1/images?limit=1&limit=2", "v1-input-duplicate"},
		{"/api/v1/images?withTags=true", "v1-with-tags"},
		{"/api/v1/images?q=%zz", "v1-query-encoding"},
	} {
		reg := prometheus.NewRegistry()
		up := &v1Upstream{}
		w := httptest.NewRecorder()
		newServer(reg, up).ServeV1ImagesHTTP(w, v1Request(c.target, nil))
		if w.Code != http.StatusTeapot || up.count() != 1 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": c.reason}) != 1 {
			t.Errorf("%s: code=%d proxied=%d, want a %s fallback", c.target, w.Code, up.count(), c.reason)
		}
	}
	// A session resolved for the request (here pre-resolved on its context, as bearerOrigin does).
	reg := prometheus.NewRegistry()
	up := &v1Upstream{}
	r := v1Request("/api/v1/images?limit=2", nil)
	r = r.WithContext(auth.WithResolved(r.Context(), &auth.SessionUser{ID: 5}, nil))
	newServer(reg, up).ServeV1ImagesHTTP(httptest.NewRecorder(), r)
	if up.count() != 1 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "v1-images-session"}) != 1 {
		t.Errorf("resolved session: proxied=%d, want a v1-images-session fallback", up.count())
	}
	// An absolute-form request line.
	reg = prometheus.NewRegistry()
	up = &v1Upstream{}
	r = httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://elsewhere.example.test/api/v1/images?limit=2", nil)
	newServer(reg, up).ServeV1ImagesHTTP(httptest.NewRecorder(), r)
	if up.count() != 1 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "v1-host"}) != 1 {
		t.Errorf("absolute-form: proxied=%d, want a v1-host fallback", up.count())
	}
	// Control: the same server, signed out in origin form, gets past both to the port's own
	// configuration check (no feed service configured: index-feed-unconfigured).
	reg = prometheus.NewRegistry()
	up = &v1Upstream{}
	newServer(reg, up).ServeV1ImagesHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=2", nil))
	if imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": "index-feed-unconfigured"}) != 1 {
		t.Errorf("signed out, origin form: want the index-feed-unconfigured fallback")
	}
}

// PublicMux mounts the images route only with the /api/v1 upstream configured, on its exact path:
// a deeper path is not this route (Node's are other pages) and not routed here.
func TestPublicMuxMountsTheImagesRoute(t *testing.T) {
	s, up, _ := serveV1ImagesServer(t, prometheus.NewRegistry(), false)
	mux := PublicMux(s)
	for _, path := range []string{"/api/v1/images", "/api/v1/images?limit=1"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, v1Request(path, nil))
		if w.Code != http.StatusTeapot {
			t.Errorf("%s: %d, want the upstream's 418", path, w.Code)
		}
	}
	for _, path := range []string{"/api/v1/images/", "/api/v1/images/42", "/api/v1/imagesx"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, v1Request(path, nil))
		if w.Code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404 (not the images route)", path, w.Code)
		}
	}
	if up.count() != 2 {
		t.Fatalf("upstream calls = %d, want 2", up.count())
	}
	// Without its own upstream the path is not routed here, the /api/v1 upstream notwithstanding.
	s.V1ImagesFallback = nil
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, v1Request("/api/v1/images", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("without V1ImagesFallback (V1Fallback set): %d, want 404", w.Code)
	}
}

// FEED_GO_V1_IMAGES_FALLBACK_URL is the images route's ONLY upstream: every fallback goes there and
// never to the /api/v1 upstream (FEED_GO_V1_FALLBACK_URL), which the model routes keep; with only the
// /api/v1 upstream the images route is not mounted at all, and with only its own the model routes are
// not.
func TestServeV1ImagesNeverUsesTheV1Upstream(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, own, computes := serveV1ImagesServer(t, reg, false)
	apiV1 := &v1Upstream{}
	s.V1Fallback = apiV1
	mux := PublicMux(s)
	mux.ServeHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=2", nil))
	if own.count() != 1 || apiV1.count() != 0 || *computes != 0 {
		t.Fatalf("off: images upstream %d, /api/v1 upstream %d, computes %d; want 1, 0, 0", own.count(), apiV1.count(), *computes)
	}
	s.ServeV1Images = true
	mux.ServeHTTP(httptest.NewRecorder(), v1Request("/api/v1/images?limit=2", map[string]string{"Authorization": "Bearer k"}))
	if own.count() != 2 || apiV1.count() != 0 {
		t.Fatalf("a fallback: images upstream %d, /api/v1 upstream %d; want 2, 0", own.count(), apiV1.count())
	}
	mux.ServeHTTP(httptest.NewRecorder(), v1Request("/api/v1/models?limit=2", nil))
	if apiV1.count() != 1 || own.count() != 2 {
		t.Fatalf("the models route: /api/v1 upstream %d, images upstream %d; want 1, 2", apiV1.count(), own.count())
	}
	// Only the /api/v1 upstream: the images path is not routed here (a 404), never proxied there.
	s.V1ImagesFallback = nil
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, v1Request("/api/v1/images?limit=2", nil))
	if w.Code != http.StatusNotFound || apiV1.count() != 1 {
		t.Fatalf("images with only the /api/v1 upstream: %d, /api/v1 upstream %d; want 404, 1", w.Code, apiV1.count())
	}
	// Only its own: served; the model routes are not mounted.
	s.V1ImagesFallback, s.V1Fallback = own, nil
	mux = PublicMux(s)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, v1Request("/api/v1/models?limit=2", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("models without the /api/v1 upstream: %d, want 404", w.Code)
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, v1Request("/api/v1/images?limit=2", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("images with only its own upstream: %d, want 200 (served)", w.Code)
	}
}

// goldenV1NoStore are the served signed-out v1-images golden fixtures whose requested level is not
// within SFW (their queries: browsingLevel 7 or 31, nsfw=X, nsfw=true), so Node's handler answers
// `private, no-store`; every other served fixture carries the public Cache-Control.
var goldenV1NoStore = map[string]bool{
	"held-images-on-page": true, "held-model-version": true, "ids-model-version-held": true,
	"ids-with-meta-wrapped": true, "nsfw-deprecated-name-x": true, "nsfw-true": true,
}

// Every v1-images golden fixture (Node's own answer to a real request over the same world) through
// the PUBLIC route: a signed-out request the shadow answers is served, its body Node's, with the
// route's headers, and its ETag answers a conditional request with a 304; a signed-in one is
// handed back to Node (`v1-images-session-cookie`) before anything is computed; one the shadow falls
// back on falls back with the same reason. Proxied answers are the upstream's.
func TestServeV1ImagesGolden(t *testing.T) {
	served, handed, fellBack, noStore := 0, 0, 0, 0
	for _, path := range goldenFiles(t, "v1-images", goldenMinV1) {
		fx := goldenLoad(t, path)
		t.Run(fx.Name, func(t *testing.T) {
			env := goldenSetup(t, fx)
			reg := prometheus.NewRegistry()
			up := &v1Upstream{}
			s := env.server
			s.Metrics, s.Log, s.V1ImagesFallback, s.ServeV1Images = NewMetrics(reg), slog.New(slog.NewTextHandler(io.Discard, nil)), up, true
			request := func(extra map[string]string) *http.Request {
				r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, fx.Request.Path+"?"+fx.Request.Query, nil)
				for k, v := range env.headers {
					r.Header.Set(k, v)
				}
				for k, v := range extra {
					r.Header.Set(k, v)
				}
				r.Host = env.headers["host"]
				return r
			}
			w := httptest.NewRecorder()
			s.ServeV1ImagesHTTP(w, request(nil))
			want := fx.Expect.Fallback
			if fx.Request.Session != nil {
				want = "v1-images-session-cookie"
			}
			if want != "" {
				if w.Code != http.StatusTeapot || up.count() != 1 || imagesCount(t, reg, "feed_go_fallback_total", map[string]string{"reason": want}) != 1 {
					t.Fatalf("code=%d proxied=%d, want a %s fallback", w.Code, up.count(), want)
				}
				if fx.Request.Session != nil {
					handed++
				} else {
					fellBack++
				}
				return
			}
			if w.Code != http.StatusOK || up.count() != 0 {
				t.Fatalf("code=%d proxied=%d, want 200 served here", w.Code, up.count())
			}
			rep, err := shadow.CompareJSON(w.Body.Bytes(), fx.Expect.Body)
			if err != nil {
				t.Fatalf("compare: %v", err)
			}
			goldenReport(t, rep, w.Body.Bytes())
			env.feed.check(t, true)
			wantCC := publicCC
			if goldenV1NoStore[fx.Name] {
				wantCC = noStoreCC
				noStore++
			}
			etag := w.Header().Get("ETag")
			if cc := w.Header().Get("Cache-Control"); cc != wantCC || etag == "" || w.Header().Get("Vary") != "Authorization" ||
				w.Header().Get(ServedByHeader) != ServedByGo || w.Header().Get("Content-Type") != "application/json; charset=utf-8" {
				t.Fatalf("headers %v, want Cache-Control %q, an ETag, Vary Authorization, served by go", w.Header(), wantCC)
			}
			var anyBody map[string]json.RawMessage
			if err := json.Unmarshal(w.Body.Bytes(), &anyBody); err != nil {
				t.Fatalf("the served body is not JSON: %v", err)
			}
			w = httptest.NewRecorder()
			s.ServeV1ImagesHTTP(w, request(map[string]string{"If-None-Match": etag}))
			if w.Code != http.StatusNotModified || w.Body.Len() != 0 || w.Header().Get("ETag") != etag || up.count() != 0 {
				t.Fatalf("revalidating with its ETag: code=%d body=%d bytes ETag=%q proxied=%d, want a 304", w.Code, w.Body.Len(), w.Header().Get("ETag"), up.count())
			}
			served++
		})
	}
	// Positive control: each arm was reached, the no-store arm on every fixture that names it.
	if served < 25 || handed != 3 || fellBack < 5 || noStore != len(goldenV1NoStore) {
		t.Fatalf("served %d, handed back %d, fell back %d, no-store %d; want >= 25, 3, >= 5, %d", served, handed, fellBack, noStore, len(goldenV1NoStore))
	}
}

// The serve and shadow computes share v1ImagesCompute: in the shadow a session cookie or a
// conditional header (which the sampler never sends) does not drop the sample, and a signed-in
// sample is computed for its viewer, its headers the credentialed arm.
func TestV1ImagesShadowComputesWhatServingHandsBack(t *testing.T) {
	s, _, computes := serveV1ImagesServer(t, prometheus.NewRegistry(), true)
	r, err := SyntheticV1Request(context.Background(), ShadowRequest{Input: "limit=2", Path: V1ImagesPath,
		Headers: map[string]string{"host": "h.example.test", "cookie": "__Secure-civ-token=t"}})
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.v1ImagesCompute(false)(r.Context(), r)
	if err != nil || *computes != 1 {
		t.Fatalf("shadow compute: %v, computes %d; want an answer", err, *computes)
	}
	h := map[string]string{}
	for _, x := range c.headers {
		h[x.Name] = x.Value
	}
	if h["Vary"] != "Authorization, Cookie" || h["Cache-Control"] != "max-age=0, private, no-cache" {
		t.Fatalf("credentialed sample headers %v, want Vary Authorization, Cookie and the private default", h)
	}
	if _, err := s.v1ImagesCompute(true)(r.Context(), r); err == nil {
		t.Fatal("serving computed a session-cookie request")
	}
	// A verified crawler's sample: the app's decision, read off a sample only.
	r, _ = SyntheticV1Request(context.Background(), ShadowRequest{Input: "limit=2", Headers: map[string]string{verifiedBotHeader: "googlebot"}})
	c, err = s.v1ImagesCompute(false)(r.Context(), r)
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range c.headers {
		if x.Name == "Cache-Control" && x.Value != "max-age=0, private, no-cache" {
			t.Fatalf("verified crawler sample: Cache-Control %q, want the private default", x.Value)
		}
	}
	pub := v1Request("/api/v1/images?limit=2", map[string]string{verifiedBotHeader: "googlebot"})
	c, err = s.v1ImagesCompute(true)(pub.Context(), pub)
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range c.headers {
		if x.Name == "Cache-Control" && x.Value != publicCC {
			t.Fatalf("a public request's verified-bot header is not read: Cache-Control %q, want public", x.Value)
		}
	}
}

// The probe registry's v1-images key is the images path, so the probe endpoint is
// /internal/probe/api/v1/images.
func TestProbeV1ImagesPath(t *testing.T) {
	if got := ProbePathPrefix + ProbeV1Images; got != "/internal/probe/api/v1/images" {
		t.Fatalf("probe path %q", got)
	}
	if probes[ProbeV1Images].endpoint != EndpointV1Images {
		t.Fatalf("probe endpoint %q, want v1-images", probes[ProbeV1Images].endpoint)
	}
}
