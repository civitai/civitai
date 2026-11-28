package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// The serve-side parity sampler on the public model routes (`GET /api/v1/models`, `GET
// /api/v1/models/[id]`, DESIGN.md §7.2): a sampled answer this service served is replayed to the
// /api/v1 Node app (V1Upstream, never the tRPC Upstream) and Node's plain-JSON body and REST headers
// are compared with what was served, under source="serve-parity".

// v1ParitySrv is serveV1Server with the sampler on at rate 1: a model route's replay goes to v1, the
// /api/v1 Node app; trpc is the tRPC Node app, which no model-route replay may reach.
func v1ParitySrv(t *testing.T, reg *prometheus.Registry, v1 http.Handler) (s *Server, trpcNode *nodeStub) {
	t.Helper()
	s, _, _ = serveV1Server(t, reg, true)
	trpcNode = nodeAnswering(servedPayload)
	s.Parity = &ServeParity{Rate: 1, Upstream: trpcNode, V1Upstream: v1, Queue: make(chan struct{}, 4),
		Timeout: 2 * time.Second, Random: func() float64 { return 0 }}
	return s, trpcNode
}

// restAnswer is the Node app's answer to a model route: status, body, and the response headers the
// public route writes for that body (literals: TestServeV1ModelsOnServesTheList and
// TestServeV1ModelsOnServesOneModel pin the same values on Go's side).
func restAnswer(status int, body, cacheControl, etag string) *nodeStub {
	return &nodeStub{status: status, body: body, respHdr: map[string]string{
		"X-Frame-Options":              "DENY",
		"Vary":                         "Authorization",
		"Access-Control-Allow-Origin":  "*",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, *",
		"Access-Control-Allow-Methods": "GET",
		"Cache-Control":                cacheControl,
		"Etag":                         etag,
		"Content-Type":                 "application/json; charset=utf-8",
	}}
}

const (
	v1PublicCC = "public, s-maxage=300, stale-while-revalidate=150"
	v1DetailCC = "private, no-store"
)

func v1ParityOutcome(t *testing.T, reg *prometheus.Registry, endpoint, outcome string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_serve_parity_total", map[string]string{"feed_endpoint": endpoint, "outcome": outcome})
	return v
}

func v1ParityTotal(t *testing.T, reg *prometheus.Registry, endpoint string) float64 {
	t.Helper()
	sum := 0.0
	for _, o := range ServeParityOutcomes {
		sum += v1ParityOutcome(t, reg, endpoint, o)
	}
	return sum
}

// A served list or `[id]` answer is replayed exactly once, after the answer is written (the client
// has the whole answer while the replay is still blocked in Node), to the /api/v1 Node app only, with
// the request's own path, query, Host and cookies, the replay marker and no client Accept-Encoding;
// Node's identical body and headers are a match under source="serve-parity" (body and headers), never
// a shadow sample.
func TestServeParityV1ModelsReplaysToTheV1App(t *testing.T) {
	cases := []struct {
		endpoint, target, body, cc, etag string
	}{
		{EndpointV1Models, "/api/v1/models?limit=2", v1ListBody, v1PublicCC, v1ListETag},
		{EndpointV1ModelsID, "/api/v1/models/42", v1DetailBody, v1DetailCC, v1DetailETag},
	}
	for _, tc := range cases {
		t.Run(tc.endpoint, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			node := restAnswer(http.StatusOK, tc.body, tc.cc, tc.etag)
			node.gate = make(chan struct{})
			s, trpcNode := v1ParitySrv(t, reg, node)
			r := v1Request(tc.target, map[string]string{"Cookie": "theme=dark", "Accept-Encoding": "br",
				"Traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"})
			w := httptest.NewRecorder()
			v1Handler(s, tc.target)(w, r)
			if w.Code != http.StatusOK || w.Body.String() != tc.body || w.Header().Get(ServedByHeader) != ServedByGo {
				t.Fatalf("served code=%d body=%q served-by=%q, want Go's 200", w.Code, w.Body.String(), w.Header().Get(ServedByHeader))
			}
			if v := v1ParityOutcome(t, reg, tc.endpoint, ParityCompared); v != 0 {
				t.Fatal("compared before Node answered")
			}
			close(node.gate)
			s.shadows.Wait()
			if n := node.callCount(); n != 1 {
				t.Fatalf("replays to the /api/v1 app = %d, want exactly 1", n)
			}
			if n := trpcNode.callCount(); n != 0 {
				t.Fatalf("replays to the tRPC app = %d, want 0", n)
			}
			if node.urls[0] != tc.target || node.hosts[0] != "site.example.test" {
				t.Fatalf("replay url=%q host=%q, want %q, site.example.test", node.urls[0], node.hosts[0], tc.target)
			}
			h := node.headers[0]
			if h.Get(ParityReplayHeader) != "1" || h.Get("Cookie") != "theme=dark" || h.Get("Accept-Encoding") == "br" || h.Get("Traceparent") != "" {
				t.Fatalf("replay headers marker=%q cookie=%q accept-encoding=%q traceparent=%q", h.Get(ParityReplayHeader), h.Get("Cookie"),
					h.Get("Accept-Encoding"), h.Get("Traceparent"))
			}
			if v := v1ParityOutcome(t, reg, tc.endpoint, ParityCompared); v != 1 {
				t.Fatalf("serve_parity{%s,compared} = %v, want 1", tc.endpoint, v)
			}
			if v := compareCount(t, reg, tc.endpoint, "match", SourceServeParity); v != 1 {
				t.Fatalf("compare{%s,match,serve-parity} = %v, want 1", tc.endpoint, v)
			}
			if v := compareCount(t, reg, tc.endpoint, "match", SourceShadow); v != 0 {
				t.Fatalf("compare{%s,match,shadow} = %v, want 0: a replay is not a shadow sample", tc.endpoint, v)
			}
			// The REST header list (ETag, CORS, X-Frame-Options included), matching.
			if v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": tc.endpoint, "result": "match", SourceLabel: SourceServeParity}); v != 1 {
				t.Fatalf("response{%s,match,serve-parity} = %v, want 1", tc.endpoint, v)
			}
		})
	}
}

// A Node answer whose REST headers differ is a header mismatch under the REST list's category (here
// the ETag): the replay picks Node's headers from the same list the REST sampler sends.
func TestServeParityV1ModelsComparesTheRESTHeaders(t *testing.T) {
	reg := prometheus.NewRegistry()
	node := restAnswer(http.StatusOK, v1ListBody, v1PublicCC, `"other"`)
	s, _ := v1ParitySrv(t, reg, node)
	s.ServeV1ModelsHTTP(httptest.NewRecorder(), v1Request("/api/v1/models?limit=2", nil))
	s.shadows.Wait()
	if v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": EndpointV1Models, "result": "mismatch", SourceLabel: SourceServeParity}); v != 1 {
		t.Fatalf("response{mismatch,serve-parity} = %v, want 1", v)
	}
	if v, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": EndpointV1Models, "category": "header:etag", "kind": "value", SourceLabel: SourceServeParity}); v != 1 {
		t.Fatalf("field_diffs{header:etag,value,serve-parity} = %v, want 1", v)
	}
	if v := compareCount(t, reg, EndpointV1Models, "match", SourceServeParity); v != 1 {
		t.Fatalf("compare{match,serve-parity} = %v, want 1 (the body still matches)", v)
	}
}

// A conditional request Go answered 304 is still compared on the full body: the replay drops
// If-None-Match and If-Modified-Since, so Node answers its 200 with the body rather than its own 304.
func TestServeParityV1ModelsConditionalReplayAsksForTheBody(t *testing.T) {
	cases := []struct {
		endpoint, target, body, cc, etag string
		headers                          map[string]string
		code                             int
	}{
		{EndpointV1Models, "/api/v1/models?limit=2", v1ListBody, v1PublicCC, v1ListETag,
			map[string]string{"If-None-Match": v1ListETag}, http.StatusNotModified},
		{EndpointV1ModelsID, "/api/v1/models/42", v1DetailBody, v1DetailCC, v1DetailETag,
			map[string]string{"If-None-Match": v1DetailETag, "If-Modified-Since": "Sat, 21 Nov 2026 00:00:00 GMT"}, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.endpoint, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			node := restAnswer(http.StatusOK, tc.body, tc.cc, tc.etag)
			s, _ := v1ParitySrv(t, reg, node)
			w := httptest.NewRecorder()
			v1Handler(s, tc.target)(w, v1Request(tc.target, tc.headers))
			s.shadows.Wait()
			if w.Code != tc.code {
				t.Fatalf("served %d, want %d", w.Code, tc.code)
			}
			if node.callCount() != 1 {
				t.Fatalf("replays = %d, want 1", node.callCount())
			}
			h := node.headers[0]
			if len(h.Values("If-None-Match")) != 0 || len(h.Values("If-Modified-Since")) != 0 {
				t.Fatalf("replay kept If-None-Match=%q If-Modified-Since=%q", h.Values("If-None-Match"), h.Values("If-Modified-Since"))
			}
			if v := compareCount(t, reg, tc.endpoint, "match", SourceServeParity); v != 1 {
				t.Fatalf("compare{match,serve-parity} = %v, want 1", v)
			}
		})
	}
}

// Each model route's answers are classified by its own selection (CompareSelection): the list by
// item id (membership, order, fields), `[id]` as one model (fields; a not-found answer against Node's
// model is membership). Node's `[id]` 404 is a comparable answer: Go's not-found against Node's
// not-found is match_empty, Go's model from the origin cache match_cached. Each differing path is
// counted under its category, under source="serve-parity" only.
func TestServeParityV1ModelsClassification(t *testing.T) {
	const notFound = `{"error":"No model with id 42"}`
	cases := []struct {
		name, endpoint, target string
		goAnswer               computed
		node                   *nodeStub
		result, diffCategory   string
	}{
		{"list membership", EndpointV1Models, "/api/v1/models?limit=2", computed{payload: []byte(`{"items":[{"id":1}],"metadata":{}}`)},
			restAnswer(http.StatusOK, `{"items":[{"id":2}],"metadata":{}}`, v1PublicCC, v1ListETag), "membership", "items.*.id"},
		{"list order", EndpointV1Models, "/api/v1/models?limit=2", computed{payload: []byte(`{"items":[{"id":1},{"id":2}],"metadata":{}}`)},
			restAnswer(http.StatusOK, `{"items":[{"id":2},{"id":1}],"metadata":{}}`, v1PublicCC, v1ListETag), "order", "items.*.id"},
		{"list fields", EndpointV1Models, "/api/v1/models?limit=2", computed{payload: []byte(`{"items":[{"id":1,"name":"a"}],"metadata":{}}`)},
			restAnswer(http.StatusOK, `{"items":[{"id":1,"name":"b"}],"metadata":{}}`, v1PublicCC, v1ListETag), "fields", "items.*.name"},
		{"[id] fields", EndpointV1ModelsID, "/api/v1/models/42", computed{payload: []byte(`{"id":42,"name":"a"}`)},
			restAnswer(http.StatusOK, `{"id":42,"name":"b"}`, v1DetailCC, v1DetailETag), "fields", "name"},
		{"[id] Go not found, Node a model", EndpointV1ModelsID, "/api/v1/models/42",
			computed{payload: []byte(notFound), trivial: true, notFound: true, absent: true},
			restAnswer(http.StatusOK, `{"id":42,"name":"a"}`, v1DetailCC, v1DetailETag), "membership", "error"},
		{"[id] both not found", EndpointV1ModelsID, "/api/v1/models/42",
			computed{payload: []byte(notFound), trivial: true, notFound: true, absent: true},
			restAnswer(http.StatusNotFound, notFound, v1DetailCC, `"x"`), "match_empty", ""},
		{"[id] from the origin cache", EndpointV1ModelsID, "/api/v1/models/42", computed{payload: []byte(v1DetailBody), cached: true},
			restAnswer(http.StatusOK, v1DetailBody, v1DetailCC, v1DetailETag), "match_cached", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s, _ := v1ParitySrv(t, reg, tc.node)
			s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
				c := tc.goAnswer
				c.payload = append([]byte(nil), tc.goAnswer.payload...)
				return &c, nil
			}
			w := httptest.NewRecorder()
			v1Handler(s, tc.target)(w, v1Request(tc.target, nil))
			s.shadows.Wait()
			if w.Header().Get(ServedByHeader) != ServedByGo {
				t.Fatalf("not served by Go: code %d", w.Code)
			}
			if v := v1ParityOutcome(t, reg, tc.endpoint, ParityCompared); v != 1 {
				t.Fatalf("serve_parity{compared} = %v, want 1 (total %v)", v, v1ParityTotal(t, reg, tc.endpoint))
			}
			if v := compareCount(t, reg, tc.endpoint, tc.result, SourceServeParity); v != 1 {
				t.Fatalf("compare{%s,serve-parity} = %v, want 1", tc.result, v)
			}
			if v := compareCount(t, reg, tc.endpoint, tc.result, SourceShadow); v != 0 {
				t.Fatalf("compare{%s,shadow} = %v, want 0", tc.result, v)
			}
			if tc.diffCategory == "" {
				return
			}
			if v, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": tc.endpoint, "category": tc.diffCategory, "kind": "value", SourceLabel: SourceServeParity}); v < 1 {
				// A key only one side has is a missing-in-* diff, not a value diff.
				m1, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": tc.endpoint, "category": tc.diffCategory, "kind": "missing-in-node", SourceLabel: SourceServeParity})
				m2, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": tc.endpoint, "category": tc.diffCategory, "kind": "missing-in-go", SourceLabel: SourceServeParity})
				if m1+m2 < 1 {
					t.Fatalf("field_diffs{%s,serve-parity} = 0, want >= 1", tc.diffCategory)
				}
			}
		})
	}
}

// A replay that fails is counted as its outcome and compares nothing: Node unreachable (the proxy's
// empty 502), a status other than 200 (or, on `[id]` only, 404), a body that is not JSON, or past the
// deadline. The answer already served is unchanged.
func TestServeParityV1ModelsReplayFailures(t *testing.T) {
	cases := []struct {
		name, endpoint, target string
		node                   *nodeStub
		timeout                time.Duration
		outcome                string
	}{
		{"unreachable", EndpointV1Models, "/api/v1/models?limit=2", &nodeStub{status: http.StatusBadGateway}, 0, ParityUpstreamError},
		{"Node's 500", EndpointV1ModelsID, "/api/v1/models/42", &nodeStub{status: http.StatusInternalServerError, body: `{"error":"x"}`}, 0, ParityUpstreamStatus},
		{"a 404 on the list", EndpointV1Models, "/api/v1/models?limit=2", &nodeStub{status: http.StatusNotFound, body: `{"error":"x"}`}, 0, ParityUpstreamStatus},
		{"a 304 Node should never send", EndpointV1Models, "/api/v1/models?limit=2", &nodeStub{status: http.StatusNotModified}, 0, ParityUpstreamStatus},
		{"not JSON", EndpointV1ModelsID, "/api/v1/models/42", &nodeStub{status: http.StatusOK, body: `<html>`}, 0, ParityBadBody},
		{"timeout", EndpointV1Models, "/api/v1/models?limit=2", &nodeStub{status: http.StatusOK, body: v1ListBody, sleep: time.Second}, 20 * time.Millisecond, ParityTimeout},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s, _ := v1ParitySrv(t, reg, tc.node)
			if tc.timeout > 0 {
				s.Parity.Timeout = tc.timeout
			}
			w := httptest.NewRecorder()
			v1Handler(s, tc.target)(w, v1Request(tc.target, nil))
			s.shadows.Wait()
			if w.Code != http.StatusOK || w.Header().Get(ServedByHeader) != ServedByGo {
				t.Fatalf("served code=%d: the replay changed the answer", w.Code)
			}
			if v := v1ParityOutcome(t, reg, tc.endpoint, tc.outcome); v != 1 {
				t.Fatalf("serve_parity{%s} = %v, want 1 (total %v)", tc.outcome, v, v1ParityTotal(t, reg, tc.endpoint))
			}
			if v := v1ParityTotal(t, reg, tc.endpoint); v != 1 {
				t.Fatalf("serve_parity total = %v, want 1", v)
			}
			for _, r := range []string{"match", "match_empty", "match_cached", "fields", "order", "membership", "bad_request"} {
				if v := compareCount(t, reg, tc.endpoint, r, SourceServeParity); v != 0 {
					t.Fatalf("compare{%s,serve-parity} = %v after a failed replay, want 0", r, v)
				}
			}
		})
	}
}

// `[id]` with FEED_GO_V1_BEARER_AUTH answers API-credentialed requests: none is ever replayed (the
// replay would present the credential again), each counted skipped_credential. The two forms the
// tRPC routes' credential reading does not see (an empty Authorization line; an empty `token` before a
// non-empty one) are skipped too: the model routes' own, looser reading decides.
func TestServeParityV1ModelsNeverReplaysACredential(t *testing.T) {
	cases := []struct {
		name, target string
		headers      [][2]string
	}{
		{"Bearer key", "/api/v1/models/42", [][2]string{{"Authorization", "Bearer k-read"}}},
		{"other scheme", "/api/v1/models/42", [][2]string{{"Authorization", "Basic eDp5"}}},
		{"?token=", "/api/v1/models/42?token=k-unknown", nil},
		{"empty Authorization line", "/api/v1/models/42", [][2]string{{"Authorization", ""}}},
		{"empty then a ?token=", "/api/v1/models/42?token=&token=k-unknown", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			node := restAnswer(http.StatusOK, v1DetailBody, v1DetailCC, v1DetailETag)
			s, trpcNode := v1ParitySrv(t, reg, node)
			s.Resolver, _ = v1BearerResolver(t)
			s.V1BearerAuth = true
			r := v1Request(tc.target, nil)
			for _, h := range tc.headers {
				r.Header.Add(h[0], h[1])
			}
			w := httptest.NewRecorder()
			s.ServeV1ModelsIDHTTP(w, r)
			s.shadows.Wait()
			if w.Code != http.StatusOK || w.Header().Get(ServedByHeader) != ServedByGo {
				t.Fatalf("precondition: code=%d served-by=%q, want Go's 200", w.Code, w.Header().Get(ServedByHeader))
			}
			if node.callCount() != 0 || trpcNode.callCount() != 0 {
				t.Fatalf("replays = %d (v1), %d (tRPC), want 0", node.callCount(), trpcNode.callCount())
			}
			if v := v1ParityOutcome(t, reg, EndpointV1ModelsID, ParitySkippedCredential); v != 1 {
				t.Fatalf("serve_parity{skipped_credential} = %v, want 1 (total %v)", v, v1ParityTotal(t, reg, EndpointV1ModelsID))
			}
		})
	}
	// Positive control: the same route and switch without a credential is replayed.
	reg := prometheus.NewRegistry()
	node := restAnswer(http.StatusOK, v1DetailBody, v1DetailCC, v1DetailETag)
	s, _ := v1ParitySrv(t, reg, node)
	s.Resolver, _ = v1BearerResolver(t)
	s.V1BearerAuth = true
	s.ServeV1ModelsIDHTTP(httptest.NewRecorder(), v1Request("/api/v1/models/42", nil))
	s.shadows.Wait()
	if node.callCount() != 1 || v1ParityOutcome(t, reg, EndpointV1ModelsID, ParityCompared) != 1 {
		t.Fatalf("control: replays=%d compared=%v, want 1, 1", node.callCount(), v1ParityOutcome(t, reg, EndpointV1ModelsID, ParityCompared))
	}
}

// Without the /api/v1 upstream the model routes are not replayed (and nothing is counted), however
// the tRPC upstream is set; a request handed back to Node is never replayed.
func TestServeParityV1ModelsNeedsItsOwnUpstream(t *testing.T) {
	reg := prometheus.NewRegistry()
	s, trpcNode := v1ParitySrv(t, reg, nil)
	for _, target := range []string{"/api/v1/models?limit=2", "/api/v1/models/42"} {
		w := httptest.NewRecorder()
		v1Handler(s, target)(w, v1Request(target, nil))
		s.shadows.Wait()
		if w.Code != http.StatusOK || trpcNode.callCount() != 0 || v1ParityTotal(t, reg, v1Endpoint(target)) != 0 {
			t.Fatalf("%s: code=%d tRPC replays=%d outcomes=%v, want 200, 0, 0", target, w.Code, trpcNode.callCount(), v1ParityTotal(t, reg, v1Endpoint(target)))
		}
	}
	// A fallback (the list's session cookie) is Node's own answer: never replayed.
	reg = prometheus.NewRegistry()
	node := restAnswer(http.StatusOK, v1ListBody, v1PublicCC, v1ListETag)
	s, _ = v1ParitySrv(t, reg, node)
	w := httptest.NewRecorder()
	s.ServeV1ModelsHTTP(w, v1Request("/api/v1/models?limit=2", map[string]string{"Cookie": "__Secure-civitai-token=t"}))
	s.shadows.Wait()
	if w.Header().Get(ServedByHeader) != ServedByNode || node.callCount() != 0 || v1ParityTotal(t, reg, EndpointV1Models) != 0 {
		t.Fatalf("fallback: served-by=%q replays=%d outcomes=%v, want node, 0, 0", w.Header().Get(ServedByHeader), node.callCount(), v1ParityTotal(t, reg, EndpointV1Models))
	}
}

// The replay series of the model routes read 0 from the start: every outcome, the comparison results
// each route's serve-parity can count (the list: no match_cached, it has no cached answer; `[id]`: no
// order, one model, and match_empty from its not-found answer), and the header results.
func TestServeParityV1ModelsSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	for _, e := range []string{"v1-models", "v1-models-id"} {
		for _, o := range []string{"compared", "dropped_queue", "skipped_bulkhead", "skipped_credential", "skipped_closing",
			"upstream_error", "upstream_status", "timeout", "bad_body"} {
			if v, found := metricValue(t, reg, "feed_go_serve_parity_total", map[string]string{"feed_endpoint": e, "outcome": o}); !found || v != 0 {
				t.Errorf("serve_parity{%s,%s} = %v found=%v, want a 0 series", e, o, v, found)
			}
		}
		for _, r := range []string{"match", "mismatch", "uncompared"} {
			if v, found := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": e, "result": r, SourceLabel: SourceServeParity}); !found || v != 0 {
				t.Errorf("response{%s,%s,serve-parity} = %v found=%v, want a 0 series", e, r, v, found)
			}
		}
	}
	want := map[string][]string{
		"v1-models":    {"match", "match_empty", "fields", "order", "membership", "bad_request"},
		"v1-models-id": {"match", "match_empty", "match_cached", "fields", "membership", "bad_request"},
	}
	for e, results := range want {
		for _, r := range results {
			if v, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": e, "result": r, SourceLabel: SourceServeParity}); !found || v != 0 {
				t.Errorf("compare{%s,%s,serve-parity} = %v found=%v, want a 0 series", e, r, v, found)
			}
		}
	}
	for _, c := range [][2]string{{"v1-models", "match_cached"}, {"v1-models-id", "order"}, {"as-posts", "match_cached"}} {
		if _, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": c[0], "result": c[1], SourceLabel: SourceServeParity}); found {
			t.Errorf("compare{%s,%s,serve-parity} exists, but a replay cannot count it", c[0], c[1])
		}
	}
}

// Invariant guard (the old code never replayed `[id]`, so it never captured one either): with the eval
// capture on, a compared `[id]` replay is not written as a T2 row (replay's model-route branch never
// calls captureParity, which parityCaptured also gates), while the comparison is still counted. The
// tRPC positive control: TestEvalCaptureServeParity.
func TestServeParityV1ModelsReplayIsNotCaptured(t *testing.T) {
	reg := prometheus.NewRegistry()
	node := restAnswer(http.StatusOK, v1DetailBody, v1DetailCC, v1DetailETag)
	s, _ := v1ParitySrv(t, reg, node)
	rec := &fakeRecorder{}
	s.EvalCapture = &EvalCapture{Recorder: rec}
	s.ServeV1ModelsIDHTTP(httptest.NewRecorder(), v1Request("/api/v1/models/42", nil))
	s.shadows.Wait()
	if v := compareCount(t, reg, EndpointV1ModelsID, "match", SourceServeParity); v != 1 {
		t.Fatalf("compare{match,serve-parity} = %v, want 1", v)
	}
	for _, g := range rec.got() {
		if g.Source == "serve-parity" {
			t.Fatalf("a v1-models-id replay was captured: %+v", g)
		}
	}
}
