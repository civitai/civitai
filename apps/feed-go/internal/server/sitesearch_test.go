package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/sitesearch"
)

// fakeRate is an in-memory RateCounter: counts and expiries per key.
type fakeRate struct {
	mu       sync.Mutex
	counts   map[string]int64
	expires  map[string]time.Duration
	failIncr bool
}

func newFakeRate() *fakeRate {
	return &fakeRate{counts: map[string]int64{}, expires: map[string]time.Duration{}}
}

func (f *fakeRate) Incr(ctx context.Context, key string) *redis.IntCmd {
	f.mu.Lock()
	defer f.mu.Unlock()
	cmd := redis.NewIntCmd(ctx, "incr", key)
	if f.failIncr {
		cmd.SetErr(errors.New("down"))
		return cmd
	}
	f.counts[key]++
	cmd.SetVal(f.counts[key])
	return cmd
}

func (f *fakeRate) Decr(ctx context.Context, key string) *redis.IntCmd {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.counts[key]--
	cmd := redis.NewIntCmd(ctx, "decr", key)
	cmd.SetVal(f.counts[key])
	return cmd
}

// charged is the sum over every window: what this route has counted and not refunded.
func (f *fakeRate) charged() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	var n int64
	for _, c := range f.counts {
		n += c
	}
	return n
}

func (f *fakeRate) TTL(ctx context.Context, key string) *redis.DurationCmd {
	f.mu.Lock()
	defer f.mu.Unlock()
	cmd := redis.NewDurationCmd(ctx, time.Second, "ttl", key)
	if d, ok := f.expires[key]; ok {
		cmd.SetVal(d)
	} else {
		cmd.SetVal(-1)
	}
	return cmd
}

func (f *fakeRate) Expire(ctx context.Context, key string, d time.Duration) *redis.BoolCmd {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.expires[key] = d
	cmd := redis.NewBoolCmd(ctx, "expire", key)
	cmd.SetVal(true)
	return cmd
}

func (f *fakeRate) count(key string) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.counts[key]
}

// bodyRecorder is the Node app behind SearchFallback: it records the body it is handed and answers 418.
type bodyRecorder struct {
	mu     sync.Mutex
	calls  int
	bodies []string
}

func (b *bodyRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	b.mu.Lock()
	b.calls++
	b.bodies = append(b.bodies, string(body))
	b.mu.Unlock()
	w.WriteHeader(http.StatusTeapot)
}

const (
	searchToolsPath = "/api/search/indexes/tools_v2/search"
	searchToolsBody = `{"q":"t"}`
	searchToolsHits = `{"hits":[{"id":1,"name":"Tool"}],"query":"t","processingTimeMs":0,"limit":20,"offset":0,"estimatedTotalHits":1}`
)

// searchServer is a Server with the public search route mounted: on per the argument, a backend
// that answers searchToolsHits, a rate store, and a Node upstream that records what it is handed.
func searchServer(t *testing.T, reg *prometheus.Registry, on bool) (*Server, *recordingUpstream, *fakeRate, *bodyRecorder) {
	t.Helper()
	up := &recordingUpstream{res: &sitesearch.Response{Status: 200, Body: []byte(searchToolsHits)}}
	rate, node := newFakeRate(), &bodyRecorder{}
	s := &Server{
		Metrics:        NewMetrics(reg),
		Log:            quietLog(),
		Resolver:       &auth.Resolver{},
		Hosts:          siteSearchGoldenHosts,
		ServeSearch:    on,
		Search:         &SearchDeps{Upstream: up, Rate: rate},
		SearchFallback: node,
		Fallback: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Error("the search route fell back to the tRPC upstream")
		}),
	}
	return s, up, rate, node
}

func searchRequest(path, body string, headers map[string]string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, path, strings.NewReader(body))
	r.Host = "red.example.test"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Cf-Connecting-Ip", "192.0.2.7")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

// Off (the default), every request is handed to the search upstream as it came, body included:
// nothing read, nothing computed, no backend call, no count.
func TestServeSearchOffProxiesWithoutComputing(t *testing.T) {
	if (&Server{}).ServeSearch || config.LoadSiteSearch().Serve {
		t.Fatal("FEED_GO_SERVE_SEARCH is on by default")
	}
	reg := prometheus.NewRegistry()
	s, up, rate, node := searchServer(t, reg, false)
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, nil))
	if w.Code != http.StatusTeapot || node.calls != 1 || node.bodies[0] != searchToolsBody {
		t.Fatalf("off: code %d, node calls %d bodies %q, want 418, 1 and the body as sent", w.Code, node.calls, node.bodies)
	}
	if len(up.calls) != 0 || len(rate.counts) != 0 {
		t.Fatalf("off: %d backend calls, %d counted windows, want none", len(up.calls), len(rate.counts))
	}
	if w.Header().Get(ServedByHeader) != ServedByNode || fallbackCount(t, reg, "search-off") != 1 {
		t.Fatalf("off: served-by %q, search-off %v", w.Header().Get(ServedByHeader), fallbackCount(t, reg, "search-off"))
	}
}

// On, a request the port answers is written here with Node's headers, counted once in its window
// (the signed-out address's bucket), and its backend call carries the viewer's clauses.
func TestServeSearchOnAnswers(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, up, rate, node := searchServer(t, reg, true)
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, nil))
	if w.Code != http.StatusOK || node.calls != 0 {
		t.Fatalf("on: code %d, node calls %d", w.Code, node.calls)
	}
	if got := w.Body.String(); got != searchToolsHits {
		t.Errorf("body %s, want the backend's", got)
	}
	want := map[string]string{
		"X-Frame-Options":              "DENY",
		"Vary":                         "Authorization",
		"Access-Control-Allow-Origin":  "*",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, *",
		"Access-Control-Allow-Methods": "POST",
		"Cache-Control":                "private, no-store",
		"Content-Type":                 "application/json; charset=utf-8",
		ServedByHeader:                 ServedByGo,
	}
	for k, v := range want {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s: %q, want %q", k, got, v)
		}
	}
	if len(up.calls) != 1 || up.calls[0].Path != "/indexes/tools_v2/search" {
		t.Fatalf("backend calls %+v", up.calls)
	}
	key := "site-search:rate-limit:ip:192.0.2.7"
	if rate.count(key) != 1 || rate.expires[key] != 60*time.Second {
		t.Errorf("window %q: count %d expiry %v, want 1 and 60s", key, rate.count(key), rate.expires[key])
	}
	// A session cookie (valid or not) is the credentialed Vary.
	w = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, map[string]string{"Cookie": "__Secure-civ-token=x"}))
	if got := w.Header().Get("Vary"); w.Code != http.StatusOK || got != "Authorization, Cookie" {
		t.Errorf("with a session cookie: code %d Vary %q", w.Code, got)
	}
}

// A signed-in viewer is counted in the user's bucket; a request past the ceiling is handed back (Node
// answers the 429 and counts it) without a backend call, and its charge refunded. The count is INCR
// first, as Node's: each request reads its own count, so concurrent requests cannot all pass.
func TestServeSearchRateLimit(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, up, rate, node := searchServer(t, reg, true)
	user, err := auth.SessionUserFrom(7, map[string]any{"id": int64(7)})
	if err != nil {
		t.Fatal(err)
	}
	r := searchRequest(searchToolsPath, searchToolsBody, nil)
	r = r.WithContext(auth.WithResolved(r.Context(), user, nil))
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, r)
	if w.Code != http.StatusOK || rate.count("site-search:rate-limit:user:7") != 1 {
		t.Fatalf("signed in: code %d, user window %d", w.Code, rate.count("site-search:rate-limit:user:7"))
	}

	rate.counts["site-search:rate-limit:ip:192.0.2.7"] = searchRateIPMax
	w = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, nil))
	if w.Code != http.StatusTeapot || node.calls != 1 || node.bodies[0] != searchToolsBody || len(up.calls) != 1 {
		t.Fatalf("spent window: code %d node %d backend %d", w.Code, node.calls, len(up.calls))
	}
	if fallbackCount(t, reg, "search-rate-limited") != 1 || rate.count("site-search:rate-limit:ip:192.0.2.7") != searchRateIPMax {
		t.Fatalf("a handed-back request left a charge: window %d, want %d (Node counts it)", rate.count("site-search:rate-limit:ip:192.0.2.7"), searchRateIPMax)
	}

	// One under the ceiling is answered; a store that cannot be read fails open.
	rate.counts["site-search:rate-limit:ip:192.0.2.7"] = searchRateIPMax - 1
	// The last slot is answered (INCR reads exactly the ceiling).
	w = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("one under the ceiling: %d", w.Code)
	}
	rate.failIncr = true
	w = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("store down: %d, want answered (fail open)", w.Code)
	}

	// No usable edge address: Node keys the window by another derivation.
	w = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, map[string]string{"Cf-Connecting-Ip": "fe80::1%eth0"}))
	if w.Code != http.StatusTeapot || fallbackCount(t, reg, "search-rate-limit-ip") != 1 {
		t.Fatalf("scoped address: %d", w.Code)
	}
}

func TestEdgeClientIP(t *testing.T) {
	for v, want := range map[string]bool{
		"192.0.2.7": true, " 192.0.2.7 ": true, "2001:db8::1": true, "::ffff:192.0.2.7": true,
		"": false, "unknown": false, "192.0.2.7, 198.51.100.1": false, "fe80::1%eth0": false,
		"01.2.3.4": false, "192.0.2.7 ": false, strings.Repeat("1", 46): false,
	} {
		h := http.Header{}
		if v != "" {
			h.Set("Cf-Connecting-Ip", v)
		}
		if _, ok := edgeClientIP(h); ok != want {
			t.Errorf("%q: %v, want %v", v, ok, want)
		}
	}
}

// Every request the port does not answer exactly is handed to Node with its body intact, under its
// reason: before anything is computed where the request alone decides.
func TestServeSearchFallbacks(t *testing.T) {
	banned, _ := auth.SessionUserFrom(8, map[string]any{"id": int64(8), "bannedAt": "2026-01-01"})
	oddPrefs, _ := auth.SessionUserFrom(9, map[string]any{"id": int64(9), "browsingLevel": "31"})
	for _, c := range []struct {
		name, path, body, reason string
		headers                  map[string]string
		user                     *auth.SessionUser
		host                     string
	}{
		{name: "the SFW host with text", path: searchToolsPath, body: `{"q":"cat"}`, reason: "search-profanity", host: "green.example.test"},
		{name: "the SFW host, any query's text", path: "/api/search/multi-search", body: `{"queries":[{"indexUid":"tools_v2"},{"indexUid":"tools_v2","q":" "}]}`, reason: "search-profanity", host: "green.example.test"},
		{name: "an API key", path: searchToolsPath, body: searchToolsBody, reason: "bearer-token", headers: map[string]string{"Authorization": "Bearer k"}},
		{name: "a query token", path: searchToolsPath + "?token=k", body: searchToolsBody, reason: "bearer-token"},
		{name: "an etag query", path: searchToolsPath + "?etag=1", body: searchToolsBody, reason: "search-etag"},
		{name: "not JSON", path: searchToolsPath, body: searchToolsBody, reason: "search-content-type", headers: map[string]string{"Content-Type": "text/plain"}},
		{name: "another charset", path: searchToolsPath, body: searchToolsBody, reason: "search-content-type", headers: map[string]string{"Content-Type": "application/json; charset=latin1"}},
		{name: "the token route", path: "/api/search/token", body: `{}`, reason: "search-path"},
		{name: "an escaped segment", path: "/api/search/indexes/tools%5Fv2/search", body: searchToolsBody, reason: "search-path"},
		{name: "a banned session", path: searchToolsPath, body: searchToolsBody, reason: "search-banned", user: banned},
		{name: "unread preferences", path: searchToolsPath, body: searchToolsBody, reason: "search-session-shape", user: oddPrefs},
		{name: "a retired index", path: "/api/search/indexes/images_v6/search", body: searchToolsBody, reason: "search-index"},
	} {
		reg := prometheus.NewRegistry()
		s, up, rate, node := searchServer(t, reg, true)
		r := searchRequest(c.path, c.body, c.headers)
		if c.host != "" {
			r.Host = c.host
		}
		if c.user != nil {
			r = r.WithContext(auth.WithResolved(r.Context(), c.user, nil))
		}
		w := httptest.NewRecorder()
		PublicMux(s).ServeHTTP(w, r)
		if w.Code != http.StatusTeapot || node.calls != 1 || node.bodies[0] != c.body {
			t.Errorf("%s: code %d node %d bodies %q, want handed back with its body", c.name, w.Code, node.calls, node.bodies)
		}
		if got := fallbackCount(t, reg, c.reason); got != 1 {
			t.Errorf("%s: %s = %v, want 1", c.name, c.reason, got)
		}
		if len(up.calls) != 0 || rate.charged() != 0 {
			t.Errorf("%s: backend %d, charged %d, want none (a charge taken is refunded)", c.name, len(up.calls), rate.charged())
		}
	}
}

// The profanity hand-back is the public route's alone: a shadow sample on the SFW site with text is
// computed and compared, since Node samples a request only after its own check passed it — and that
// is the PG-capped traffic where a missed clause would leak.
func TestSearchShadowComputesTextOnTheSFWSite(t *testing.T) {
	s := &Server{Resolver: &auth.Resolver{}, Hosts: siteSearchGoldenHosts}
	up := &recordingUpstream{res: &sitesearch.Response{Status: 200, Body: []byte(searchToolsHits)}}
	ctx := context.WithValue(withSearchBody(context.Background(), []byte(`{"q":"cat"}`)), searchRecordedKey{}, sitesearch.Upstream(up))
	r := httptest.NewRequestWithContext(ctx, http.MethodPost, searchToolsPath, strings.NewReader(`{"q":"cat"}`))
	r.Host = "green.example.test"
	r.Header.Set("Content-Type", "application/json")
	if _, err := s.searchCompute(false)(context.Background(), r); err != nil {
		t.Fatalf("shadow, SFW site, text: %v, want computed", err)
	}
	if _, err := s.searchCompute(true)(context.Background(), r); fallback.Reason(err) != "search-profanity" {
		t.Fatalf("serving, SFW site, text: %v, want search-profanity", err)
	}
}

// A GET (or a preflight) is Node's 405 or CORS answer: handed back. So is a body past Next's limit,
// replayed whole.
func TestServeSearchMethodAndBodySize(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, _, _, node := searchServer(t, reg, true)
	r := httptest.NewRequestWithContext(context.Background(), http.MethodOptions, searchToolsPath, nil)
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, r)
	if w.Code != http.StatusTeapot || fallbackCount(t, reg, "method") != 1 {
		t.Fatalf("OPTIONS: %d", w.Code)
	}
	big := `{"q":"` + strings.Repeat("a", maxSearchBody) + `"}`
	w = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, big, nil))
	if w.Code != http.StatusTeapot || fallbackCount(t, reg, "search-body-size") != 1 || node.bodies[len(node.bodies)-1] != big {
		t.Fatalf("oversized body: code %d, replayed %d bytes of %d", w.Code, len(node.bodies[len(node.bodies)-1]), len(big))
	}
}

// A blocked region is always handed back, even with FEED_GO_ANSWER_REGION_BLOCKED on: Node's 451 on
// this route carries MixedAuthEndpoint's headers, which writeRegionBlocked does not.
func TestSearchHandsBlockedRegionBack(t *testing.T) {
	rules, err := config.RegionBlockRules("")
	if err != nil {
		t.Fatal(err)
	}
	reg := prometheus.NewRegistry()
	s, up, _, node := searchServer(t, reg, true)
	s.RegionBlockRules, s.AnswerRegionBlocked = rules, true
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, map[string]string{"cf-ipcountry": "GB"}))
	if w.Code != http.StatusTeapot || node.calls != 1 || len(up.calls) != 0 {
		t.Fatalf("blocked region: code %d node %d backend %d, want handed back", w.Code, node.calls, len(up.calls))
	}
	if fallbackCount(t, reg, "region-blocked") != 1 {
		t.Fatal("not counted as region-blocked")
	}
}

// The route is mounted only with its upstream, under /api/search/ only.
func TestPublicMuxMountsSearchWithItsUpstream(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, _, _, node := searchServer(t, reg, false)
	if code := statusOf(PublicMux(s), searchToolsPath); code != http.StatusTeapot || node.calls != 1 {
		t.Fatalf("mounted: %d", code)
	}
	s.SearchFallback = nil
	if code := statusOf(PublicMux(s), searchToolsPath); code != http.StatusNotFound {
		t.Fatalf("no upstream: %d, want 404 (not mounted)", code)
	}
	if code := statusOf(InternalMux(s, http.NotFoundHandler(), false), "/internal/shadow"+SearchPath); code == http.StatusNotFound {
		t.Fatal("the shadow endpoint is not on the internal listener")
	}
	if code := statusOf(PublicMux(s), "/internal/shadow"+SearchPath); code != http.StatusNotFound {
		t.Fatalf("the shadow endpoint is on the public listener: %d", code)
	}
}

// postSearchSample posts a sample to the shadow endpoint and waits for its comparison.
func postSearchSample(t *testing.T, s *Server, sample ShadowRequest) {
	t.Helper()
	b, err := json.Marshal(sample)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.ShadowSearchHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow"+SearchPath, bytes.NewReader(b)))
	if w.Code != http.StatusAccepted {
		t.Fatalf("shadow post: %d", w.Code)
	}
	waitFor(t, "the sample to finish", func() bool { return len(s.ShadowQueue) == 0 })
}

// The shadow reshapes the backend response Node recorded and compares the call and the answer: the
// same document is `match`; a call whose filter differs (a clause Node added and Go did not, or the
// reverse) is `membership`; the same call with a different answer is `fields`; the headers compare
// apart. Never a backend call.
func TestSearchShadowCompares(t *testing.T) {
	const hits = `{"hits":[{"id":1,"name":"R","sfwName":"S","user":{"id":2,"profilePicture":{"nsfwLevel":4}}}],"query":"x"}`
	const goBody = `{"hits":[{"id":1,"name":"S","user":{"id":2,"profilePicture":null,"image":null}}],"query":"x"}`
	const call = `{"q":"x","filter":["poi != true","availability != Private","nsfwLevel=1"]}`
	nodeDoc := func(call, body string) json.RawMessage {
		return json.RawMessage(`{"upstream":{"path":"/indexes/models_v9/search","body":` + call + `},"body":` + body + `}`)
	}
	headers := map[string]string{
		"x-frame-options": "DENY", "vary": "Authorization", "access-control-allow-origin": "*",
		"access-control-allow-headers": "Authorization, Content-Type, *", "access-control-allow-methods": "POST",
		"cache-control": "private, no-store", "etag": `"abc"`,
	}
	for _, c := range []struct {
		name, result string
		node         json.RawMessage
	}{
		{"same", "match", nodeDoc(call, goBody)},
		{"a clause Go did not add", "membership", nodeDoc(`{"q":"x","filter":["poi != true","availability != Private","nsfwLevel=1","extra"]}`, goBody)},
		{"a clause Node did not add", "membership", nodeDoc(`{"q":"x","filter":["poi != true","availability != Private"]}`, goBody)},
		{"a different answer", "fields", nodeDoc(call, hits)},
	} {
		reg := prometheus.NewRegistry()
		s, up, _, _ := searchServer(t, reg, false)
		s.ShadowQueue = make(chan struct{}, 1)
		postSearchSample(t, s, ShadowRequest{
			Input: `{"q":"x"}`, Path: "/api/search/indexes/models_v9/search",
			Headers:  map[string]string{"host": "red.example.test"},
			Node:     c.node,
			Upstream: json.RawMessage(hits), ResponseHeaders: headers, ResponseHeaderSet: ResponseHeaderSetREST,
		})
		if v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointSearch, "result": c.result}); v != 1 {
			t.Errorf("%s: result %s = %v, want 1", c.name, c.result, v)
		}
		if v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": EndpointSearch, "result": "match"}); v != 1 {
			t.Errorf("%s: headers did not match (the ETag is not compared)", c.name)
		}
		if len(up.calls) != 0 {
			t.Errorf("%s: the shadow called the backend", c.name)
		}
	}
}

// Every shadow sample is counted once in feed_go_shadow_servable_total under what the public route
// would have done with it: servable, else the first hand-back serving reaches, in serving's order (the
// body size and the region before the compute; in the compute, a credential before the etag query,
// the etag query before the body, the profanity refusal after it). The sample is computed either way.
func TestSearchShadowCountsServable(t *testing.T) {
	rules, err := config.RegionBlockRules("")
	if err != nil {
		t.Fatal(err)
	}
	big := `{"q":"` + strings.Repeat("a", maxSearchBody) + `"}`
	for _, c := range []struct {
		name, path, input, host, country, reason string
		computed                                 bool
	}{
		{name: "the other site, text", path: searchToolsPath, input: `{"q":"cat"}`, host: "red.example.test", reason: "servable", computed: true},
		{name: "the SFW site, no text", path: searchToolsPath, input: `{"limit":5}`, host: "green.example.test", reason: "servable", computed: true},
		{name: "the SFW site, text", path: searchToolsPath, input: `{"q":"cat"}`, host: "green.example.test", reason: "search-profanity", computed: true},
		{name: "an etag query", path: searchToolsPath + "?etag=1", input: `{"q":"cat"}`, host: "red.example.test", reason: "search-etag", computed: true},
		{name: "an etag query before the SFW site's text", path: searchToolsPath + "?etag=1", input: `{"q":"cat"}`, host: "green.example.test", reason: "search-etag", computed: true},
		{name: "an etag query before an unknown key", path: searchToolsPath + "?etag=1", input: `{"q":"cat","vector":[1]}`, host: "red.example.test", reason: "search-etag"},
		{name: "a query token before the etag query", path: searchToolsPath + "?token=k&etag=1", input: `{"q":"cat"}`, host: "red.example.test", reason: "bearer-token"},
		{name: "an unknown key", path: searchToolsPath, input: `{"q":"cat","vector":[1]}`, host: "red.example.test", reason: "input-unknown-key"},
		{name: "the SFW site's text after an unknown key", path: searchToolsPath, input: `{"q":"cat","vector":[1]}`, host: "green.example.test", reason: "input-unknown-key"},
		{name: "a blocked region", path: searchToolsPath, input: `{"q":"cat"}`, host: "red.example.test", country: "GB", reason: "region-blocked", computed: true},
		{name: "a blocked region before an unknown key", path: searchToolsPath, input: `{"q":"cat","vector":[1]}`, host: "red.example.test", country: "GB", reason: "region-blocked"},
		{name: "a body past the limit before the region", path: searchToolsPath, input: big, host: "red.example.test", country: "GB", reason: "search-body-size"},
	} {
		reg := prometheus.NewRegistry()
		s, up, _, _ := searchServer(t, reg, false)
		s.RegionBlockRules = rules
		s.ShadowQueue = make(chan struct{}, 1)
		headers := map[string]string{"host": c.host}
		if c.country != "" {
			headers["cf-ipcountry"] = c.country
		}
		postSearchSample(t, s, ShadowRequest{
			Input: c.input, Path: c.path, Headers: headers,
			Node:     json.RawMessage(`{"upstream":{},"body":{}}`),
			Upstream: json.RawMessage(searchToolsHits),
		})
		total := 0.0
		for _, r := range []string{"servable", "search-profanity", "search-etag", "region-blocked", "search-body-size", "bearer-token", "input-unknown-key"} {
			v, _ := metricValue(t, reg, "feed_go_shadow_servable_total", map[string]string{"feed_endpoint": EndpointSearch, "reason": r})
			total += v
			if want := map[bool]float64{true: 1}[r == c.reason]; v != want {
				t.Errorf("%s: servable{reason=%q} = %v, want %v", c.name, r, v, want)
			}
		}
		if total != 1 {
			t.Errorf("%s: counted %v times, want once", c.name, total)
		}
		served, _ := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": EndpointSearch, "mode": "shadow", "outcome": "served"})
		if want := map[bool]float64{true: 1}[c.computed]; served != want {
			t.Errorf("%s: shadow computes = %v, want %v", c.name, served, want)
		}
		if len(up.calls) != 0 {
			t.Errorf("%s: the shadow called the backend", c.name)
		}
	}
}

// The servable series exist from the start, reading 0: the share is a ratio of rates, and a reason
// born inside the window would lose its first sample to increase().
func TestShadowServableIsSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	for _, r := range []string{"servable", "search-body-size", "region-blocked", "search-etag", "search-profanity"} {
		v, found := metricValue(t, reg, "feed_go_shadow_servable_total", map[string]string{"feed_endpoint": EndpointSearch, "reason": r})
		if !found || v != 0 {
			t.Errorf("servable{reason=%q} = %v (found %v), want an exported 0", r, v, found)
		}
	}
}

// A sample without the recorded backend response cannot be reshaped: unsupported, never a call.
func TestSearchShadowWithoutUpstream(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, up, _, _ := searchServer(t, reg, false)
	s.ShadowQueue = make(chan struct{}, 1)
	postSearchSample(t, s, ShadowRequest{
		Input: `{"q":"x"}`, Path: searchToolsPath, Headers: map[string]string{"host": "red.example.test"},
		Node: json.RawMessage(`{"upstream":{},"body":{}}`),
	})
	if v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointSearch, "result": "unsupported"}); v != 1 || len(up.calls) != 0 {
		t.Fatalf("unsupported = %v, backend calls %d", v, len(up.calls))
	}
	if v, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointSearch, "mode": "shadow", "reason": "search-no-upstream"}); v != 1 {
		t.Fatalf("search-no-upstream = %v", v)
	}
}

func TestSiteSearchConfig(t *testing.T) {
	// SEARCH_TOKEN_API_KEY unset for the first reads (restored after).
	t.Setenv("SEARCH_TOKEN_API_KEY", "")
	if err := os.Unsetenv("SEARCH_TOKEN_API_KEY"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FEED_GO_SERVE_SEARCH", "true")
	t.Setenv("NEXT_PUBLIC_SEARCH_HOST", "")
	t.Setenv("FEED_GO_SEARCH_FALLBACK_URL", "")
	if err := config.LoadSiteSearch().Validate(); err == nil {
		t.Fatal("serving without an upstream validated")
	}
	t.Setenv("FEED_GO_SEARCH_FALLBACK_URL", "http://node.example.test")
	if err := config.LoadSiteSearch().Validate(); err == nil {
		t.Fatal("serving without a search host validated")
	}
	t.Setenv("NEXT_PUBLIC_SEARCH_HOST", "https://search.example.test")
	t.Setenv("SEARCH_API_KEY", "fallback-key")
	c := config.LoadSiteSearch()
	if err := c.Validate(); err != nil || !c.Serve || c.APIKey != "fallback-key" {
		t.Fatalf("%+v %v", c, err)
	}
	// SEARCH_TOKEN_API_KEY wins when set, even empty (`??`).
	t.Setenv("SEARCH_TOKEN_API_KEY", "")
	if got := config.LoadSiteSearch().APIKey; got != "" {
		t.Fatalf("key %q, want the empty SEARCH_TOKEN_API_KEY", got)
	}
}

// The compute ends in a fallback (never an answer) when nothing could answer it.
func TestSearchComputeUnconfigured(t *testing.T) {
	s := &Server{Resolver: &auth.Resolver{}, Hosts: siteSearchGoldenHosts}
	r := searchRequest(searchToolsPath, searchToolsBody, nil)
	r = r.WithContext(withSearchBody(r.Context(), []byte(searchToolsBody)))
	if _, err := s.searchCompute(true)(context.Background(), r); fallback.Reason(err) != "search-unconfigured" {
		t.Fatalf("serving without a backend: %v", err)
	}
}

// A restricted region holds a signed-in viewer on the mature site to the SFW levels (canViewNsfw is
// off there for a non-moderator), so the call carries the SFW clause and images above it are dropped;
// a moderator skips the region rule. Read from REGION_RESTRICTION_CONFIG's rules, not the block list.
func TestSearchRegionRestrictionCapsTheViewer(t *testing.T) {
	const hits = `{"hits":[{"id":1,"images":[{"id":2,"nsfwLevel":1},{"id":3,"nsfwLevel":8}]}]}`
	for _, c := range []struct {
		name, country string
		moderator     bool
		capped        bool
	}{
		{"restricted", "GB", false, true},
		{"not restricted", "US", false, false},
		{"restricted moderator", "GB", true, false},
	} {
		s := &Server{Resolver: &auth.Resolver{}, Hosts: siteSearchGoldenHosts,
			RegionRules: []browsing.RegionRule{{Region: "GB", Effective: time.Unix(0, 0)}}}
		up := &recordingUpstream{res: &sitesearch.Response{Status: 200, Body: []byte(hits)}}
		user, err := auth.SessionUserFrom(7, map[string]any{"id": int64(7), "isModerator": c.moderator, "browsingLevel": int64(31), "showNsfw": true})
		if err != nil {
			t.Fatal(err)
		}
		rctx := context.WithValue(withSearchBody(context.Background(), []byte(`{"q":"x"}`)), searchRecordedKey{}, sitesearch.Upstream(up))
		r := httptest.NewRequestWithContext(rctx, http.MethodPost, "/api/search/indexes/models_v9/search", strings.NewReader(`{"q":"x"}`))
		r.Host = "red.example.test"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("cf-ipcountry", c.country)
		comp, err := s.searchCompute(false)(auth.WithResolved(context.Background(), user, nil), r)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		call := string(up.calls[0].Body)
		hasCap := strings.Contains(call, `"nsfwLevel=1 OR nsfwLevel=2"`)
		keptMature := strings.Contains(string(comp.payload), `"nsfwLevel":8`)
		if hasCap != c.capped || keptMature == c.capped {
			t.Errorf("%s: SFW clause %v, mature image kept %v; want capped=%v\ncall %s", c.name, hasCap, keptMature, c.capped, call)
		}
	}
}
