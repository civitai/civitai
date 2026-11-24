package server

import (
	"context"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/config"
)

// regionBlockedGolden is Node's answer to a blocked region on every route this service answers,
// captured from the real Node routes and held to them by
// src/server/__tests__/feed-go-region-blocked-451.test.ts.
const regionBlockedGolden = "../../testdata/golden/region-blocked/responses.json"

type regionBlockedRoute struct {
	Endpoint       string            `json:"endpoint"`
	Path           string            `json:"path"`
	RequestHeaders map[string]string `json:"requestHeaders"`
	Status         int               `json:"status"`
	Headers        map[string]string `json:"headers"`
	Body           string            `json:"body"`
}

func loadRegionBlockedGolden(t *testing.T) []regionBlockedRoute {
	t.Helper()
	raw, err := os.ReadFile(regionBlockedGolden)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Routes []regionBlockedRoute `json:"routes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	// Every public route, each once: a route added to ServedEndpoints needs its Node capture too.
	got := make([]string, 0, len(doc.Routes))
	for _, r := range doc.Routes {
		got = append(got, r.Endpoint)
	}
	if want := slices.Sorted(slices.Values(ServedEndpoints)); !slices.Equal(slices.Sorted(slices.Values(got)), want) {
		t.Fatalf("golden endpoints = %v, want exactly %v", got, want)
	}
	return doc.Routes
}

// regionServer is a Server with every public route on and mounted, over the deployed default block
// list (REGION_BLOCK_CONFIG unset: GB is blocked), whose computes and upstreams count their calls.
// The upstreams answer 418, so a proxied answer cannot be mistaken for anything this service writes.
func regionServer(t *testing.T, reg *prometheus.Registry, answer bool) (*Server, *int, *proxyRecorder) {
	t.Helper()
	rules, err := config.RegionBlockRules("")
	if err != nil {
		t.Fatal(err)
	}
	computes, up := new(int), &proxyRecorder{}
	compute := func(context.Context, *http.Request) (*computed, error) {
		*computes++
		return nil, errBulkhead // any fallback: the control only needs to see the compute reached
	}
	s := &Server{
		Metrics:             NewMetrics(reg),
		Log:                 quietLog(),
		AllowedOrigins:      allowed,
		Fallback:            up,
		V1Fallback:          up,
		V1ImagesFallback:    up,
		ServeModelGetAll:    true,
		ServeInfinite:       true,
		ServeV1Models:       true,
		ServeV1Images:       true,
		RegionBlockRules:    rules,
		AnswerRegionBlocked: answer,
		computeFn:           compute,
		computeModelsFn:     compute,
		computeInfiniteFn:   compute,
		computeV1ModelsFn:   compute,
		computeV1Fn:         compute,
	}
	return s, computes, up
}

func regionRequest(path string, headers map[string]string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil)
	r.Host = "site.example.test"
	// The tRPC routes serve an allowed origin only; `[id]` falls back on any Origin (v1-models-origin).
	if strings.HasPrefix(path, "/api/trpc/") {
		r.Header.Set("Origin", "https://site.example")
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

// responseHeaders is every header of w lowercased, less the transport ones and X-Feed-Go-Served (the
// golden file's rule).
func responseHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for k, v := range h {
		switch k = strings.ToLower(k); k {
		case "date", "connection", "keep-alive", "content-length", "transfer-encoding", strings.ToLower(ServedByHeader):
			continue
		}
		out[k] = strings.Join(v, ", ")
	}
	return out
}

// With FEED_GO_ANSWER_REGION_BLOCKED on, a request from a blocked region gets Node's own 451 from
// this service on every public route (status, headers and body as the golden file captured them from
// Node), with X-Feed-Go-Served: go: nothing is computed, nothing proxied, and it is counted as the
// region_blocked outcome, never as served nor as a fallback.
func TestAnswerRegionBlockedWritesNodes451(t *testing.T) {
	for _, g := range loadRegionBlockedGolden(t) {
		reg := prometheus.NewRegistry()
		s, computes, up := regionServer(t, reg, true)
		w := httptest.NewRecorder()
		PublicMux(s).ServeHTTP(w, regionRequest(g.Path, g.RequestHeaders))
		if w.Code != g.Status {
			t.Errorf("%s: status %d, want Node's %d", g.Endpoint, w.Code, g.Status)
		}
		if body, _ := io.ReadAll(w.Body); string(body) != g.Body {
			t.Errorf("%s: body %q, want Node's %q", g.Endpoint, body, g.Body)
		}
		if got := responseHeaders(w.Header()); !maps.Equal(got, g.Headers) {
			t.Errorf("%s: headers %v, want Node's %v", g.Endpoint, got, g.Headers)
		}
		if got, want := w.Header().Get("Content-Length"), strconv.Itoa(len(g.Body)); got != want {
			t.Errorf("%s: Content-Length %q, want %s (the body's length)", g.Endpoint, got, want)
		}
		if got := w.Header().Get(ServedByHeader); got != ServedByGo {
			t.Errorf("%s: %s = %q, want %q", g.Endpoint, ServedByHeader, got, ServedByGo)
		}
		if up.calls != 0 || *computes != 0 {
			t.Errorf("%s: proxied=%d computed=%d, want 0 and 0", g.Endpoint, up.calls, *computes)
		}
		l := map[string]string{"feed_endpoint": g.Endpoint, "mode": "serve"}
		for outcome, want := range map[string]float64{"region_blocked": 1, "served": 0, "fallback": 0} {
			l["outcome"] = outcome
			if v, _ := metricValue(t, reg, "feed_go_requests_total", l); v != want {
				t.Errorf("%s: requests{outcome=%s} = %v, want %v", g.Endpoint, outcome, v, want)
			}
		}
		if v := fallbackCount(t, reg, "region-blocked"); v != 0 {
			t.Errorf("%s: region-blocked fallbacks = %v, want 0", g.Endpoint, v)
		}
	}
}

// Off (the default), the same request is handed back as before: the `region-blocked` fallback,
// proxied to the route's upstream, X-Feed-Go-Served: node, no region_blocked outcome.
func TestAnswerRegionBlockedOffHandsBack(t *testing.T) {
	if (&Server{}).AnswerRegionBlocked {
		t.Fatal("AnswerRegionBlocked is on in a zero Server")
	}
	for _, g := range loadRegionBlockedGolden(t) {
		reg := prometheus.NewRegistry()
		s, computes, up := regionServer(t, reg, false)
		w := httptest.NewRecorder()
		PublicMux(s).ServeHTTP(w, regionRequest(g.Path, g.RequestHeaders))
		if w.Code != http.StatusTeapot || up.calls != 1 || *computes != 0 {
			t.Errorf("%s off: code=%d proxied=%d computed=%d, want 418, 1, 0", g.Endpoint, w.Code, up.calls, *computes)
		}
		if got := w.Header().Get(ServedByHeader); got != ServedByNode {
			t.Errorf("%s off: %s = %q, want %q", g.Endpoint, ServedByHeader, got, ServedByNode)
		}
		if v := fallbackCount(t, reg, "region-blocked"); v != 1 {
			t.Errorf("%s off: region-blocked fallbacks = %v, want 1", g.Endpoint, v)
		}
		l := map[string]string{"feed_endpoint": g.Endpoint, "mode": "serve", "outcome": "region_blocked"}
		if v, _ := metricValue(t, reg, "feed_go_requests_total", l); v != 0 {
			t.Errorf("%s off: requests{outcome=region_blocked} = %v, want 0", g.Endpoint, v)
		}
	}
}

// Control, switch on: a request from a region that is not blocked (US, DE, a US state not on the
// list) is never answered 451 here; it reaches the route's compute as before.
func TestAnswerRegionBlockedLeavesOtherRegionsAlone(t *testing.T) {
	for _, g := range loadRegionBlockedGolden(t) {
		for _, h := range []map[string]string{
			{"cf-ipcountry": "US"},
			{"cf-ipcountry": "DE"},
			{"cf-ipcountry": "US", "cf-region-code": "NY"},
		} {
			reg := prometheus.NewRegistry()
			s, computes, _ := regionServer(t, reg, true)
			w := httptest.NewRecorder()
			PublicMux(s).ServeHTTP(w, regionRequest(g.Path, h))
			if w.Code == http.StatusUnavailableForLegalReasons || *computes != 1 {
				t.Errorf("%s %v: code=%d computed=%d, want not 451 and computed once", g.Endpoint, h, w.Code, *computes)
			}
			l := map[string]string{"feed_endpoint": g.Endpoint, "mode": "serve", "outcome": "region_blocked"}
			if v, _ := metricValue(t, reg, "feed_go_requests_total", l); v != 0 {
				t.Errorf("%s %v: requests{outcome=region_blocked} = %v, want 0", g.Endpoint, h, v)
			}
		}
	}
}

// Each header combination getRegion reads, switch on: x-isuk true|1 is GB whatever the country, and a
// US state is blocked only when it is on the list (tested over blockRules: GB and US:CA).
func TestAnswerRegionBlockedByEveryRegionHeader(t *testing.T) {
	for _, c := range []struct {
		headers map[string]string
		blocked bool
	}{
		{map[string]string{"cf-ipcountry": "GB"}, true},
		{map[string]string{"cf-ipcountry": "US", "x-isuk": "true"}, true},
		{map[string]string{"x-isuk": "1"}, true},
		{map[string]string{"cf-ipcountry": "US", "cf-region-code": "CA"}, true},
		{map[string]string{"cf-ipcountry": "US", "x-isuk": "yes"}, false},
		{map[string]string{"cf-ipcountry": "FR"}, false}, // its block date is not reached
		{nil, false},
	} {
		reg := prometheus.NewRegistry()
		s, _, _ := regionServer(t, reg, true)
		s.RegionBlockRules = blockRules(t)
		w := httptest.NewRecorder()
		PublicMux(s).ServeHTTP(w, regionRequest("/api/trpc/"+Procedure+"?input=%7B%7D", c.headers))
		if got := w.Code == http.StatusUnavailableForLegalReasons; got != c.blocked {
			t.Errorf("%v: answered 451 = %v (code %d), want %v", c.headers, got, w.Code, c.blocked)
		}
	}
}

// The route's own off switch still comes first: with model.getAll not served here, a blocked region
// on it is the `model-getall-off` fallback, proxied, exactly as with the switch off.
func TestAnswerRegionBlockedRespectsARouteThatIsOff(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, _, up := regionServer(t, reg, true)
	s.ServeModelGetAll = false
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, regionRequest("/api/trpc/"+ProcedureModelGetAll+"?input=%7B%7D", map[string]string{"cf-ipcountry": "GB"}))
	if w.Code != http.StatusTeapot || up.calls != 1 || fallbackCount(t, reg, "model-getall-off") != 1 {
		t.Fatalf("model.getAll off: code=%d proxied=%d, want 418 and 1 under model-getall-off", w.Code, up.calls)
	}
}
