package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/sitesearch"
)

// The serve-side parity sampler on `POST /api/search/*` (DESIGN.md §7.2, §18.6): a sampled search this
// service served is replayed, POST with its path, body and headers, to the /api/search Node app
// (SearchUpstream, never the tRPC or /api/v1 one), Node's answer body and REST headers are compared
// with what was served under source="serve-parity" (CompareSearch, ClassifySearch), and the replay
// leaves the viewer's rate-limit window counted once.

// searchNode is the /api/search Node app a replay reaches: it records each request, counts it in the
// rate-limit window first when rate is set (checkSiteSearchRateLimit: INCR on the viewer's key before
// any answer, a 429 included), then answers status, body and the route's response headers.
type searchNode struct {
	mu      sync.Mutex
	methods []string
	urls    []string
	hosts   []string
	bodies  []string
	headers []http.Header
	gate    chan struct{}

	rate    *fakeRate
	rateKey string
	// beforeCharge runs before the count (a test flips the store's failure there).
	beforeCharge func()

	status  int
	body    string
	respHdr map[string]string
}

func (n *searchNode) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	n.mu.Lock()
	n.methods = append(n.methods, r.Method)
	n.urls = append(n.urls, r.URL.String())
	n.hosts = append(n.hosts, r.Host)
	n.bodies = append(n.bodies, string(body))
	n.headers = append(n.headers, r.Header.Clone())
	n.mu.Unlock()
	if n.gate != nil {
		<-n.gate
	}
	if n.beforeCharge != nil {
		n.beforeCharge()
	}
	if n.rate != nil {
		n.rate.Incr(r.Context(), n.rateKey)
	}
	for k, v := range n.respHdr {
		w.Header().Set(k, v)
	}
	if n.status != 0 {
		w.WriteHeader(n.status)
	}
	_, _ = io.WriteString(w, n.body)
}

func (n *searchNode) calls() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.urls)
}

// searchNodeAnswering is Node's 200 with body and the headers the public route writes for a signed-out
// request (literals: TestServeSearchOnAnswers pins the same values on Go's side).
func searchNodeAnswering(body string) *searchNode {
	return &searchNode{status: http.StatusOK, body: body, respHdr: map[string]string{
		"X-Frame-Options":              "DENY",
		"Vary":                         "Authorization",
		"Access-Control-Allow-Origin":  "*",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, *",
		"Access-Control-Allow-Methods": "POST",
		"Cache-Control":                "private, no-store",
		"Content-Type":                 "application/json; charset=utf-8",
	}}
}

// tripwire is a Node app no site-search replay may reach.
type tripwire struct {
	mu sync.Mutex
	n  int
}

func (tw *tripwire) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	tw.mu.Lock()
	tw.n++
	tw.mu.Unlock()
	w.WriteHeader(http.StatusTeapot)
}

func (tw *tripwire) count() int {
	tw.mu.Lock()
	defer tw.mu.Unlock()
	return tw.n
}

// searchParitySrv is searchServer with the sampler on at rate 1: a site-search replay goes to node;
// trpc and v1 are the other routes' Node apps.
func searchParitySrv(t *testing.T, reg *prometheus.Registry, node http.Handler) (s *Server, up *recordingUpstream, rate *fakeRate, trpcApp, v1App *tripwire) {
	t.Helper()
	s, up, rate, _ = searchServer(t, reg, true)
	trpcApp, v1App = &tripwire{}, &tripwire{}
	s.Parity = &ServeParity{Rate: 1, Upstream: trpcApp, V1Upstream: v1App, SearchUpstream: node, Queue: make(chan struct{}, 4),
		Timeout: 2 * time.Second, Random: func() float64 { return 0 }}
	return s, up, rate, trpcApp, v1App
}

func searchParityTotal(t *testing.T, reg *prometheus.Registry) float64 {
	t.Helper()
	sum := 0.0
	for _, o := range ServeParityOutcomes {
		sum += v1ParityOutcome(t, reg, EndpointSearch, o)
	}
	return sum
}

const searchIPKey = "site-search:rate-limit:ip:192.0.2.7"

// A served search is replayed exactly once, after the answer is written, to the /api/search Node app
// only: POST, the request's own path, body, Host, session cookie and edge headers, Content-Type, the
// replay marker, no client Accept-Encoding or trace context. Node's identical body and headers are a
// match under source="serve-parity" (body and headers), never a shadow sample.
func TestServeParitySearchReplaysToTheSearchApp(t *testing.T) {
	reg := prometheus.NewRegistry()
	node := searchNodeAnswering(searchToolsHits)
	node.gate = make(chan struct{})
	s, _, _, trpcApp, v1App := searchParitySrv(t, reg, node)
	r := searchRequest(searchToolsPath, searchToolsBody, map[string]string{
		"Cookie": "theme=dark", "Cf-Ipcountry": "GB", "Cf-Region-Code": "ENG", "Accept-Encoding": "br",
		"Traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
	})
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Body.String() != searchToolsHits || w.Header().Get(ServedByHeader) != ServedByGo {
		t.Fatalf("served code=%d body=%q served-by=%q, want Go's 200", w.Code, w.Body.String(), w.Header().Get(ServedByHeader))
	}
	if v := v1ParityOutcome(t, reg, EndpointSearch, ParityCompared); v != 0 {
		t.Fatal("compared before Node answered")
	}
	close(node.gate)
	s.shadows.Wait()
	if node.calls() != 1 || trpcApp.count() != 0 || v1App.count() != 0 {
		t.Fatalf("replays: search app %d, tRPC app %d, v1 app %d, want 1, 0, 0", node.calls(), trpcApp.count(), v1App.count())
	}
	if node.methods[0] != http.MethodPost || node.urls[0] != "/api/search/indexes/tools_v2/search" || node.hosts[0] != "red.example.test" ||
		node.bodies[0] != `{"q":"t"}` {
		t.Fatalf("replay %s %s host=%q body=%q, want POST /api/search/indexes/tools_v2/search red.example.test {\"q\":\"t\"}",
			node.methods[0], node.urls[0], node.hosts[0], node.bodies[0])
	}
	h := node.headers[0]
	for k, want := range map[string]string{
		ParityReplayHeader: "1", "Cookie": "theme=dark", "Cf-Connecting-Ip": "192.0.2.7", "Cf-Ipcountry": "GB",
		"Cf-Region-Code": "ENG", "Content-Type": "application/json", "Accept-Encoding": "", "Traceparent": "",
	} {
		if got := h.Get(k); got != want {
			t.Errorf("replay header %s = %q, want %q", k, got, want)
		}
	}
	if v := v1ParityOutcome(t, reg, EndpointSearch, ParityCompared); v != 1 {
		t.Fatalf("serve_parity{site-search,compared} = %v, want 1 (total %v)", v, searchParityTotal(t, reg))
	}
	if v := compareCount(t, reg, EndpointSearch, "match", SourceServeParity); v != 1 {
		t.Fatalf("compare{site-search,match,serve-parity} = %v, want 1", v)
	}
	if v := compareCount(t, reg, EndpointSearch, "match", SourceShadow); v != 0 {
		t.Fatalf("compare{site-search,match,shadow} = %v, want 0: a replay is not a shadow sample", v)
	}
	if v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": EndpointSearch, "result": "match", SourceLabel: SourceServeParity}); v != 1 {
		t.Fatalf("response{site-search,match,serve-parity} = %v, want 1", v)
	}
}

// A served search stays counted ONCE in the viewer's rate-limit window, however the replay ends. Node
// counts the replay in the same window before it answers (searchNode with rate set); Go refunds one
// count when Node answered it itself (its 200, or its 429 at the window's last slot, which Node also
// counted; its own 502, which has a body), and nothing when the proxy could not reach Node (its
// empty 502: Node counted nothing).
// A request Go could not count (its store failed open) is refunded nothing: Node's count is its one.
func TestServeParitySearchCountsTheRequestOnce(t *testing.T) {
	signedIn, err := auth.SessionUserFrom(7, map[string]any{"id": int64(7)})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name      string
		user      *auth.SessionUser
		key       string
		status    int
		body      string
		start     int64
		goFails   bool
		nodeCount bool
		outcome   string
		want      int64
	}{
		{"Node answers", nil, searchIPKey, http.StatusOK, searchToolsHits, 0, false, true, ParityCompared, 1},
		{"Node answers a signed-in viewer", signedIn, "site-search:rate-limit:user:7", http.StatusOK, searchToolsHits, 0, false, true, ParityCompared, 1},
		{"Node's 429 at the last slot", nil, searchIPKey, http.StatusTooManyRequests, `{"code":"too_many_requests"}`, searchRateIPMax - 1, false, true, ParityUpstreamStatus, searchRateIPMax},
		{"Node unreachable", nil, searchIPKey, http.StatusBadGateway, "", 0, false, false, ParityUpstreamError, 1},
		// Node's own 502 carries a body: Node answered (and counted it), so it is refunded.
		{"Node's own 502", nil, searchIPKey, http.StatusBadGateway, `{"error":"x"}`, 0, false, true, ParityUpstreamStatus, 1},
		{"Go's store failed open", nil, searchIPKey, http.StatusOK, searchToolsHits, 0, true, true, ParityCompared, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			node := searchNodeAnswering(tc.body)
			node.status = tc.status
			s, _, rate, _, _ := searchParitySrv(t, reg, node)
			if tc.nodeCount {
				node.rate, node.rateKey = rate, tc.key
			}
			rate.counts[tc.key] = tc.start
			rate.failIncr = tc.goFails
			node.beforeCharge = func() {
				rate.mu.Lock()
				rate.failIncr = false
				rate.mu.Unlock()
			}
			r := searchRequest(searchToolsPath, searchToolsBody, nil)
			if tc.user != nil {
				r = r.WithContext(auth.WithResolved(r.Context(), tc.user, nil))
			}
			w := httptest.NewRecorder()
			PublicMux(s).ServeHTTP(w, r)
			s.shadows.Wait()
			if w.Code != http.StatusOK || w.Header().Get(ServedByHeader) != ServedByGo {
				t.Fatalf("precondition: served code=%d served-by=%q, want Go's 200", w.Code, w.Header().Get(ServedByHeader))
			}
			if node.calls() != 1 {
				t.Fatalf("replays = %d, want 1", node.calls())
			}
			if v := v1ParityOutcome(t, reg, EndpointSearch, tc.outcome); v != 1 {
				t.Fatalf("serve_parity{%s} = %v, want 1 (total %v)", tc.outcome, v, searchParityTotal(t, reg))
			}
			if got := rate.count(tc.key); got != tc.want {
				t.Fatalf("window %q = %d after the serve and its replay, want %d (counted once)", tc.key, got, tc.want)
			}
		})
	}
}

// Each replay is classified by site-search's selection over the two answer BODIES (CompareSearch,
// ClassifySearch → classifySearchBodies): the backend's own timing is not compared; a different hit
// set, or a different count over the same hits, is membership; the same hits re-ranked is order; a
// hit that differs is fields; a facet distribution's difference is counted under the cut category
// `facetDistribution`. Each differing path is counted under source="serve-parity" only.
func TestServeParitySearchClassification(t *testing.T) {
	const tail = `,"query":"t","limit":20,"offset":0,"estimatedTotalHits":1}`
	cases := []struct {
		name, goBody, nodeBody, result, category, kind string
	}{
		{"timing only", `{"hits":[{"id":1,"name":"Tool"}],"processingTimeMs":0` + tail,
			`{"hits":[{"id":1,"name":"Tool"}],"processingTimeMs":9` + tail, "match", "", ""},
		{"another hit", `{"hits":[{"id":1,"name":"Tool"}],"processingTimeMs":0` + tail,
			`{"hits":[{"id":2,"name":"Tool"}],"processingTimeMs":3` + tail, "membership", "hits.*.id", "value"},
		{"re-ranked", `{"hits":[{"id":1},{"id":2}],"processingTimeMs":0` + tail,
			`{"hits":[{"id":2},{"id":1}],"processingTimeMs":0` + tail, "order", "hits.*.id", "value"},
		{"a hit's field", `{"hits":[{"id":1,"name":"Tool"}],"processingTimeMs":0` + tail,
			`{"hits":[{"id":1,"name":"Other"}],"processingTimeMs":0` + tail, "fields", "hits.*.name", "value"},
		{"the count only", `{"hits":[{"id":1}],"processingTimeMs":0` + tail,
			`{"hits":[{"id":1}],"processingTimeMs":0,"query":"t","limit":20,"offset":0,"estimatedTotalHits":5}`, "membership", "estimatedTotalHits", "value"},
		{"a facet value", `{"hits":[],"facetDistribution":{"type":{"a":1}},"processingTimeMs":0` + tail,
			`{"hits":[],"facetDistribution":{"type":{"a":2,"b":1}},"processingTimeMs":0` + tail, "membership", "facetDistribution", "missing-in-go"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			node := searchNodeAnswering(tc.nodeBody)
			s, up, _, _, _ := searchParitySrv(t, reg, node)
			up.res = &sitesearch.Response{Status: 200, Body: []byte(tc.goBody)}
			w := httptest.NewRecorder()
			PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, nil))
			s.shadows.Wait()
			if w.Body.String() != tc.goBody {
				t.Fatalf("served %q, want the backend's body", w.Body.String())
			}
			if v := v1ParityOutcome(t, reg, EndpointSearch, ParityCompared); v != 1 {
				t.Fatalf("serve_parity{compared} = %v, want 1 (total %v)", v, searchParityTotal(t, reg))
			}
			for _, r := range []string{"match", "fields", "order", "membership", "bad_request"} {
				want := 0.0
				if r == tc.result {
					want = 1
				}
				if v := compareCount(t, reg, EndpointSearch, r, SourceServeParity); v != want {
					t.Errorf("compare{%s,serve-parity} = %v, want %v", r, v, want)
				}
			}
			if v := compareCount(t, reg, EndpointSearch, tc.result, SourceShadow); v != 0 {
				t.Fatalf("compare{%s,shadow} = %v, want 0", tc.result, v)
			}
			if _, found := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointSearch, "category": "processingTimeMs", "kind": "value", SourceLabel: SourceServeParity}); found {
				t.Error("the backend's processingTimeMs was counted as a difference")
			}
			if _, found := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointSearch, "category": "facetDistribution.type.b", "kind": "missing-in-go", SourceLabel: SourceServeParity}); found {
				t.Error("a facet value made its own diff category")
			}
			if tc.category == "" {
				return
			}
			if v, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointSearch, "category": tc.category, "kind": tc.kind, SourceLabel: SourceServeParity}); v < 1 {
				t.Fatalf("field_diffs{%s,%s,serve-parity} = %v, want >= 1", tc.category, tc.kind, v)
			}
		})
	}
}

// Two answer bodies, compared and classified directly (multi-search and facet search included): the
// literal result for each, and the diff categories CompareSearch leaves.
func TestCompareSearchBodies(t *testing.T) {
	cases := []struct {
		name, goBody, nodeBody, result string
		categories                     []string
	}{
		{"multi-search, timing only",
			`{"results":[{"indexUid":"a","hits":[{"id":1}],"processingTimeMs":0},{"indexUid":"b","hits":[],"processingTimeMs":1}]}`,
			`{"results":[{"indexUid":"a","hits":[{"id":1}],"processingTimeMs":4},{"indexUid":"b","hits":[],"processingTimeMs":2}]}`,
			"match", nil},
		{"multi-search, a hit moved to the other result",
			`{"results":[{"indexUid":"a","hits":[{"id":1}]},{"indexUid":"b","hits":[{"id":2}]}]}`,
			`{"results":[{"indexUid":"a","hits":[{"id":2}]},{"indexUid":"b","hits":[{"id":1}]}]}`,
			"membership", []string{"results.*.hits.*.id", "results.*.hits.*.id"}},
		{"multi-search, a result's count",
			`{"results":[{"indexUid":"a","hits":[{"id":1}],"estimatedTotalHits":1}]}`,
			`{"results":[{"indexUid":"a","hits":[{"id":1}],"estimatedTotalHits":3}]}`,
			"membership", []string{"results.*.estimatedTotalHits"}},
		{"multi-search, a result's facet values",
			`{"results":[{"hits":[],"facetDistribution":{"tags":{"x":1,"y":1}}}]}`,
			`{"results":[{"hits":[],"facetDistribution":{"tags":{"x":2,"y":2}}}]}`,
			"membership", []string{"results.*.facetDistribution"}},
		{"facet search, a count",
			`{"facetHits":[{"value":"x","count":1}],"facetQuery":"x","processingTimeMs":0}`,
			`{"facetHits":[{"value":"x","count":2}],"facetQuery":"x","processingTimeMs":5}`,
			"membership", []string{"facetHits.*.count"}},
		{"facet search, re-ranked",
			`{"facetHits":[{"value":"x","count":1},{"value":"y","count":1}]}`,
			`{"facetHits":[{"value":"y","count":1},{"value":"x","count":1}]}`,
			"order", []string{"facetHits.*.value", "facetHits.*.value"}},
		{"same hits, the count and a hit's field", `{"hits":[{"id":1,"name":"a"}],"estimatedTotalHits":1}`,
			`{"hits":[{"id":1,"name":"b"}],"estimatedTotalHits":2}`, "fields", []string{"estimatedTotalHits", "hits.*.name"}},
		{"an extra member", `{"hits":[]}`, `{"hits":[],"extra":1}`, "fields", []string{"extra"}},
		// An echoed call member differs only when the two ports sent different calls: never churn.
		{"the echoed limit, same hits", `{"hits":[{"id":1}],"limit":21,"estimatedTotalHits":1}`,
			`{"hits":[{"id":1}],"limit":20,"estimatedTotalHits":1}`, "fields", []string{"limit"}},
		{"a result's echoed query, same hits", `{"results":[{"indexUid":"a","hits":[{"id":1}],"query":"u"}]}`,
			`{"results":[{"indexUid":"a","hits":[{"id":1}],"query":"t"}]}`, "fields", []string{"results.*.query"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, err := CompareSearch([]byte(tc.goBody), []byte(tc.nodeBody))
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, d := range r.Diffs {
				got = append(got, d.Category)
			}
			if len(got) != len(tc.categories) {
				t.Fatalf("categories %q, want %q", got, tc.categories)
			}
			for i := range got {
				if got[i] != tc.categories[i] {
					t.Fatalf("categories %q, want %q", got, tc.categories)
				}
			}
			if res := ClassifySearch(r, []byte(tc.goBody), []byte(tc.nodeBody)); res != tc.result {
				t.Fatalf("ClassifySearch = %q, want %q", res, tc.result)
			}
		})
	}
	// A cut facet path names no facet value (the log reads the path).
	r, err := CompareSearch([]byte(`{"facetDistribution":{"user":{"alice":1}}}`), []byte(`{"facetDistribution":{"user":{"bob":1}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Diffs) != 2 || r.Diffs[0] != (shadow.Diff{Path: "facetDistribution", Category: "facetDistribution", Kind: "missing-in-node"}) ||
		r.Diffs[1] != (shadow.Diff{Path: "facetDistribution", Category: "facetDistribution", Kind: "missing-in-go"}) {
		t.Fatalf("facet diffs %+v, want one missing-in-node and one missing-in-go at facetDistribution", r.Diffs)
	}
}

// Two shadow documents (`{upstream, body}`, one backend response reshaped by both sides) are compared
// as CompareJSON compared them before the replay existed, every member included: a processingTimeMs
// difference there is a real difference (the same recorded response reshaped), fields; a call that
// differs is membership. A document against a body is bad_request (an error).
func TestCompareSearchDocumentsAsBefore(t *testing.T) {
	const call = `{"path":"/indexes/tools_v2/search","body":{"q":"t"}}`
	cases := []struct {
		name, goDoc, nodeDoc, result string
		categories                   []string
	}{
		{"same", `{"upstream":` + call + `,"body":{"hits":[{"id":1}],"processingTimeMs":0}}`,
			`{"upstream":` + call + `,"body":{"hits":[{"id":1}],"processingTimeMs":0}}`, "match", nil},
		{"the timing", `{"upstream":` + call + `,"body":{"hits":[{"id":1}],"processingTimeMs":0}}`,
			`{"upstream":` + call + `,"body":{"hits":[{"id":1}],"processingTimeMs":2}}`, "fields", []string{"body.processingTimeMs"}},
		{"the call", `{"upstream":{"path":"/indexes/tools_v2/search","body":{"q":"u"}},"body":{"hits":[]}}`,
			`{"upstream":` + call + `,"body":{"hits":[]}}`, "membership", []string{"upstream.body.q"}},
		{"another hit (no order in a shadow)", `{"upstream":` + call + `,"body":{"hits":[{"id":1},{"id":2}]}}`,
			`{"upstream":` + call + `,"body":{"hits":[{"id":2},{"id":1}]}}`, "fields", []string{"body.hits.*.id", "body.hits.*.id"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, err := CompareSearch([]byte(tc.goDoc), []byte(tc.nodeDoc))
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, d := range r.Diffs {
				got = append(got, d.Category)
			}
			if len(got) != len(tc.categories) {
				t.Fatalf("categories %q, want %q", got, tc.categories)
			}
			for i := range got {
				if got[i] != tc.categories[i] {
					t.Fatalf("categories %q, want %q", got, tc.categories)
				}
			}
			if res := ClassifySearch(r, []byte(tc.goDoc), []byte(tc.nodeDoc)); res != tc.result {
				t.Fatalf("ClassifySearch = %q, want %q", res, tc.result)
			}
		})
	}
	if _, err := CompareSearch([]byte(`{"upstream":`+call+`,"body":{"hits":[]}}`), []byte(`{"hits":[]}`)); err == nil {
		t.Fatal("a document against a body compared, want an error")
	}
	if _, err := CompareSearch([]byte(`{"hits":[]}`), []byte(`{"upstream":`+call+`,"body":{"hits":[]}}`)); err == nil {
		t.Fatal("a body against a document compared, want an error")
	}
}

// A search Go handed back is Node's own answer (never replayed, nothing counted), and without
// SearchUpstream the route is not replayed whatever the other upstreams are.
func TestServeParitySearchNeedsItsOwnUpstreamAndAServedAnswer(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, _, _, trpcApp, v1App := searchParitySrv(t, reg, nil)
	s.Parity.SearchUpstream = nil
	w := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, nil))
	s.shadows.Wait()
	if w.Code != http.StatusOK || trpcApp.count() != 0 || v1App.count() != 0 || searchParityTotal(t, reg) != 0 {
		t.Fatalf("no search upstream: code=%d replays tRPC=%d v1=%d outcomes=%v, want 200, 0, 0, 0", w.Code, trpcApp.count(), v1App.count(), searchParityTotal(t, reg))
	}
	// A hand-back (the route off: search-off) is never replayed.
	reg = prometheus.NewRegistry()
	node := searchNodeAnswering(searchToolsHits)
	s, _, _, _, _ = searchParitySrv(t, reg, node)
	s.ServeSearch = false
	w = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(w, searchRequest(searchToolsPath, searchToolsBody, nil))
	s.shadows.Wait()
	if w.Header().Get(ServedByHeader) != ServedByNode || node.calls() != 0 || searchParityTotal(t, reg) != 0 {
		t.Fatalf("hand-back: served-by=%q replays=%d outcomes=%v, want node, 0, 0", w.Header().Get(ServedByHeader), node.calls(), searchParityTotal(t, reg))
	}
	// Positive control: the same server with the route on replays.
	s.ServeSearch = true
	PublicMux(s).ServeHTTP(httptest.NewRecorder(), searchRequest(searchToolsPath, searchToolsBody, nil))
	s.shadows.Wait()
	if node.calls() != 1 || v1ParityOutcome(t, reg, EndpointSearch, ParityCompared) != 1 {
		t.Fatalf("control: replays=%d compared=%v, want 1, 1", node.calls(), v1ParityOutcome(t, reg, EndpointSearch, ParityCompared))
	}
}

// The site-search replay series read 0 from the start: every outcome, the comparison results a replay
// can count (match, fields, order, membership, bad_request: no match_empty, the compute marks no
// trivial answer; no match_cached), and the header results.
func TestServeParitySearchSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	for _, o := range []string{"compared", "dropped_queue", "skipped_bulkhead", "skipped_credential", "skipped_closing",
		"upstream_error", "upstream_status", "timeout", "bad_body"} {
		if v, found := metricValue(t, reg, "feed_go_serve_parity_total", map[string]string{"feed_endpoint": "site-search", "outcome": o}); !found || v != 0 {
			t.Errorf("serve_parity{site-search,%s} = %v found=%v, want a 0 series", o, v, found)
		}
	}
	for _, r := range []string{"match", "mismatch", "uncompared"} {
		if v, found := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": "site-search", "result": r, SourceLabel: SourceServeParity}); !found || v != 0 {
			t.Errorf("response{site-search,%s,serve-parity} = %v found=%v, want a 0 series", r, v, found)
		}
	}
	for _, r := range []string{"match", "fields", "order", "membership", "bad_request"} {
		if v, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": "site-search", "result": r, SourceLabel: SourceServeParity}); !found || v != 0 {
			t.Errorf("compare{site-search,%s,serve-parity} = %v found=%v, want a 0 series", r, v, found)
		}
	}
	for _, r := range []string{"match_empty", "match_cached"} {
		if _, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": "site-search", "result": r, SourceLabel: SourceServeParity}); found {
			t.Errorf("compare{site-search,%s,serve-parity} exists, but a replay cannot count it", r)
		}
	}
	// The shadow still cannot count order on site-search (a document's classifier has none).
	if _, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": "site-search", "result": "order", SourceLabel: SourceShadow}); found {
		t.Error("compare{site-search,order,shadow} exists")
	}
}
