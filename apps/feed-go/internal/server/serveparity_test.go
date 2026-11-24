package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// nodeStub is the Node app a replay reaches: it records each request it is sent and answers status +
// body (a tRPC result around envelope by default). With gate set, it answers only once gate is closed.
type nodeStub struct {
	mu      sync.Mutex
	calls   int
	headers []http.Header
	urls    []string
	hosts   []string
	gate    chan struct{}
	status  int
	body    string
	respHdr map[string]string
	sleep   time.Duration
}

func nodeAnswering(envelope string) *nodeStub {
	return &nodeStub{status: http.StatusOK, body: `{"result":{"data":` + envelope + `}}`}
}

func (n *nodeStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	n.calls++
	n.headers = append(n.headers, r.Header.Clone())
	n.urls = append(n.urls, r.URL.String())
	n.hosts = append(n.hosts, r.Host)
	n.mu.Unlock()
	if n.gate != nil {
		<-n.gate
	}
	if n.sleep > 0 {
		select {
		case <-time.After(n.sleep):
		case <-r.Context().Done():
			return
		}
	}
	for k, v := range n.respHdr {
		w.Header().Set(k, v)
	}
	w.WriteHeader(n.status)
	_, _ = w.Write([]byte(n.body)) //nolint:gosec // G705: a test double's fixed body
}

func (n *nodeStub) callCount() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.calls
}

// paritySrv is serveServer with the serve-side parity sampler on at rate 1 (every served answer).
func paritySrv(reg *prometheus.Registry, fn func(context.Context, *http.Request) (*computed, error), up http.Handler) (*Server, *proxyRecorder) {
	fb := &proxyRecorder{}
	s := serveServer(reg, fn, fb)
	s.Parity = &ServeParity{Rate: 1, Upstream: up, Queue: make(chan struct{}, 4), Timeout: 2 * time.Second, Random: func() float64 { return 0 }}
	return s, fb
}

func parityOutcome(t *testing.T, reg *prometheus.Registry, endpoint, outcome string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_serve_parity_total", map[string]string{"feed_endpoint": endpoint, "outcome": outcome})
	return v
}

func compareCount(t *testing.T, reg *prometheus.Registry, endpoint, result, source string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": endpoint, "result": result, SourceLabel: source})
	return v
}

// parityTotal is every feed_go_serve_parity_total{feed_endpoint="as-posts"} series added up.
func parityTotal(t *testing.T, reg *prometheus.Registry) float64 {
	t.Helper()
	sum := 0.0
	for _, o := range ServeParityOutcomes {
		sum += parityOutcome(t, reg, EndpointAsPosts, o)
	}
	return sum
}

// Off by default: a Server without a sampler, or with rate 0 (FEED_GO_SERVE_PARITY_SAMPLE_RATE unset
// reads 0, and main then builds none: config.TestServeParityEnv), never replays a served answer.
func TestServeParityOffByDefault(t *testing.T) {
	for _, p := range []*ServeParity{nil, {Rate: 0, Queue: make(chan struct{}, 1)}} {
		reg := prometheus.NewRegistry()
		node := nodeAnswering(servedPayload)
		s := serveServer(reg, served(nil), &proxyRecorder{})
		if p != nil {
			p.Upstream = node
		}
		s.Parity = p
		w := httptest.NewRecorder()
		s.ServeHTTP(w, publicRequest())
		s.shadows.Wait()
		if w.Code != http.StatusOK || node.callCount() != 0 || parityTotal(t, reg) != 0 {
			t.Fatalf("parity %+v: code=%d replays=%d outcomes=%v, want 200, 0, 0", p, w.Code, node.callCount(), parityTotal(t, reg))
		}
	}
}

// A sampled served request is replayed exactly once, after its answer is written (the response is
// complete while the replay is still blocked in the Node app), with the original's cookies, host
// and query, the replay marker and no Accept-Encoding; the comparison is counted under
// source="serve-parity", never as a shadow sample.
func TestServeParityReplaysOnceAfterTheResponse(t *testing.T) {
	reg := prometheus.NewRegistry()
	node := nodeAnswering(servedPayload)
	node.gate = make(chan struct{})
	s, fb := paritySrv(reg, served(nil), node)
	r := publicRequest()
	r.Host = "civitai.example"
	r.Header.Set("Cookie", "__Secure-civitai-token=abc")
	r.Header.Set("Accept-Encoding", "br")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	// ServeHTTP returned with the whole answer while the replay waits in Node: never on the latency path.
	if w.Code != http.StatusOK || w.Body.String() != `{"result":{"data":`+servedPayload+`}}` || fb.calls != 0 {
		t.Fatalf("served code=%d body=%q proxied=%d, want Go's answer", w.Code, w.Body.String(), fb.calls)
	}
	if parityOutcome(t, reg, EndpointAsPosts, ParityCompared) != 0 {
		t.Fatal("compared before Node answered")
	}
	close(node.gate)
	s.shadows.Wait()
	if n := node.callCount(); n != 1 {
		t.Fatalf("replays = %d, want exactly 1", n)
	}
	h := node.headers[0]
	if h.Get("Cookie") != "__Secure-civitai-token=abc" || h.Get(ParityReplayHeader) != "1" || h.Get("Accept-Encoding") == "br" {
		t.Fatalf("replay headers cookie=%q marker=%q accept-encoding=%q", h.Get("Cookie"), h.Get(ParityReplayHeader), h.Get("Accept-Encoding"))
	}
	if node.hosts[0] != "civitai.example" || node.urls[0] != "/api/trpc/"+Procedure+"?input=%7B%7D" {
		t.Fatalf("replay host=%q url=%q", node.hosts[0], node.urls[0])
	}
	if v := parityOutcome(t, reg, EndpointAsPosts, ParityCompared); v != 1 {
		t.Fatalf("serve_parity{compared} = %v, want 1", v)
	}
	if v := compareCount(t, reg, EndpointAsPosts, "match", SourceServeParity); v != 1 {
		t.Fatalf("compare{match,serve-parity} = %v, want 1", v)
	}
	if v := compareCount(t, reg, EndpointAsPosts, "match", SourceShadow); v != 0 {
		t.Fatalf("compare{match,shadow} = %v, want 0: a replay is not a shadow sample", v)
	}
	// Node sent no compared headers: Go's Cache-Control and Vary are missing in Node.
	if v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": "mismatch", SourceLabel: SourceServeParity}); v != 1 {
		t.Fatalf("response{mismatch,serve-parity} = %v, want 1", v)
	}
}

// Each replayed route is counted under its own feed_endpoint, with its classifier: the gallery's
// posts by postId, the flat pages by item id. A differing body is the diff it is, with its category
// under source="serve-parity".
func TestServeParityPerEndpointClassification(t *testing.T) {
	cases := []struct {
		endpoint     string
		serve        func(*Server) func(http.ResponseWriter, *http.Request)
		path         string
		goEnv        string
		nodeEnv      string
		result       string
		diffCategory string
	}{
		{EndpointAsPosts, func(s *Server) func(http.ResponseWriter, *http.Request) { return s.ServeHTTP }, Procedure,
			`{"json":{"items":[{"postId":1,"title":"a"}]}}`, `{"json":{"items":[{"postId":2,"title":"a"}]}}`, "membership", "items.*.postId"},
		{EndpointInfinite, func(s *Server) func(http.ResponseWriter, *http.Request) { return s.ServeInfiniteHTTP }, ProcedureInfinite,
			`{"json":{"items":[{"id":1},{"id":2}]}}`, `{"json":{"items":[{"id":2},{"id":1}]}}`, "order", "items.*.id"},
		{EndpointModelGetAll, func(s *Server) func(http.ResponseWriter, *http.Request) { return s.ServeModelGetAllHTTP }, ProcedureModelGetAll,
			`{"json":{"items":[{"id":1,"name":"a"}]}}`, `{"json":{"items":[{"id":1,"name":"b"}]}}`, "fields", "items.*.name"},
	}
	for _, tc := range cases {
		t.Run(tc.endpoint, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			fn := func(context.Context, *http.Request) (*computed, error) {
				return &computed{payload: []byte(tc.goEnv)}, nil
			}
			s, _ := paritySrv(reg, fn, nodeAnswering(tc.nodeEnv))
			s.ServeInfinite, s.ServeModelGetAll = true, true
			s.computeInfiniteFn, s.computeModelsFn = fn, fn
			r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+tc.path+"?input=%7B%7D", nil)
			r.Header.Set("Origin", "https://site.example")
			w := httptest.NewRecorder()
			tc.serve(s)(w, r)
			s.shadows.Wait()
			if w.Code != http.StatusOK {
				t.Fatalf("code %d", w.Code)
			}
			if v := parityOutcome(t, reg, tc.endpoint, ParityCompared); v != 1 {
				t.Fatalf("serve_parity{%s,compared} = %v, want 1", tc.endpoint, v)
			}
			if v := compareCount(t, reg, tc.endpoint, tc.result, SourceServeParity); v != 1 {
				t.Fatalf("compare{%s,serve-parity} = %v, want 1", tc.result, v)
			}
			if v, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": tc.endpoint, "category": tc.diffCategory, "kind": "value", SourceLabel: SourceServeParity}); v < 1 {
				t.Fatalf("field_diffs{%s,serve-parity} = %v, want >= 1", tc.diffCategory, v)
			}
			if v, _ := metricValue(t, reg, "feed_go_shadow_field_diffs_total", map[string]string{"feed_endpoint": tc.endpoint, "category": tc.diffCategory, "kind": "value"}); v != 0 {
				t.Fatalf("field_diffs{%s,shadow} = %v, want 0", tc.diffCategory, v)
			}
		})
	}
}

// A replay that fails — Node unreachable (the proxy's empty 502), a non-200, a body that is no tRPC
// result, a body over the bound, or past the deadline — is counted as its outcome, compares nothing,
// and never changes the answer already served.
func TestServeParityReplayFailuresAreCountedNotServed(t *testing.T) {
	cases := []struct {
		name    string
		node    *nodeStub
		timeout time.Duration
		outcome string
	}{
		{"unreachable", &nodeStub{status: http.StatusBadGateway}, 0, ParityUpstreamError},
		{"non-200", &nodeStub{status: http.StatusTooManyRequests, body: `{"error":{}}`}, 0, ParityUpstreamStatus},
		{"not a tRPC result", &nodeStub{status: http.StatusOK, body: `{"error":{"json":{}}}`}, 0, ParityBadBody},
		{"not JSON", &nodeStub{status: http.StatusOK, body: `<html>`}, 0, ParityBadBody},
		{"over the bound", &nodeStub{status: http.StatusOK, body: `{"result":{"data":"` + strings.Repeat("x", maxParityBody) + `"}}`}, 0, ParityBadBody},
		{"timeout", &nodeStub{status: http.StatusOK, body: `{"result":{"data":` + servedPayload + `}}`, sleep: time.Second}, 20 * time.Millisecond, ParityTimeout},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s, fb := paritySrv(reg, served(nil), tc.node)
			if tc.timeout > 0 {
				s.Parity.Timeout = tc.timeout
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, publicRequest())
			s.shadows.Wait()
			if w.Code != http.StatusOK || w.Body.String() != `{"result":{"data":`+servedPayload+`}}` || fb.calls != 0 {
				t.Fatalf("served code=%d body=%q proxied=%d: the replay changed the answer", w.Code, w.Body.String(), fb.calls)
			}
			if v := parityOutcome(t, reg, EndpointAsPosts, tc.outcome); v != 1 {
				t.Fatalf("serve_parity{%s} = %v, want 1 (total %v)", tc.outcome, v, parityTotal(t, reg))
			}
			if v := parityTotal(t, reg); v != 1 {
				t.Fatalf("serve_parity total = %v, want 1", v)
			}
			for _, r := range parityResults {
				if v := compareCount(t, reg, EndpointAsPosts, r, SourceServeParity); v != 0 {
					t.Fatalf("compare{%s,serve-parity} = %v after a failed replay, want 0", r, v)
				}
			}
		})
	}
}

// Every replay slot busy: the replay is dropped and counted, never queued behind the others, and
// the upstream is never called.
func TestServeParityQueueFullDrops(t *testing.T) {
	reg := prometheus.NewRegistry()
	node := nodeAnswering(servedPayload)
	s, _ := paritySrv(reg, served(nil), node)
	s.Parity.Queue = make(chan struct{}, 1)
	s.Parity.Queue <- struct{}{}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	s.shadows.Wait()
	if w.Code != http.StatusOK || node.callCount() != 0 {
		t.Fatalf("code=%d replays=%d, want 200, 0", w.Code, node.callCount())
	}
	if v := parityOutcome(t, reg, EndpointAsPosts, ParityDroppedQueue); v != 1 {
		t.Fatalf("serve_parity{dropped_queue} = %v, want 1", v)
	}
	if len(s.Parity.Queue) != 1 {
		t.Fatalf("queue holds %d, want the 1 slot the test took", len(s.Parity.Queue))
	}
}

// The skips after the sample decision: an API credential (header or ?token=), a pod near its serve
// cap, shutdown. Each is counted, none reaches Node.
func TestServeParitySkips(t *testing.T) {
	cases := []struct {
		name    string
		setup   func(*Server, *http.Request)
		outcome string
	}{
		{"bearer", func(_ *Server, r *http.Request) { r.Header.Set("Authorization", "Bearer k") }, ParitySkippedCredential},
		{"query token", func(_ *Server, r *http.Request) { r.URL.RawQuery += "&token=k" }, ParitySkippedCredential},
		{"bulkhead near full", func(s *Server, _ *http.Request) { s.MaxInFlight = 4; s.inFlight.Store(3) }, ParitySkippedBulkhead},
		{"closing", func(s *Server, r *http.Request) { _ = s.Close(r.Context()) }, ParitySkippedClosing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			node := nodeAnswering(servedPayload)
			s, _ := paritySrv(reg, served(nil), node)
			r := publicRequest()
			tc.setup(s, r)
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			s.shadows.Wait()
			if w.Code != http.StatusOK || node.callCount() != 0 {
				t.Fatalf("code=%d replays=%d, want 200, 0", w.Code, node.callCount())
			}
			if v := parityOutcome(t, reg, EndpointAsPosts, tc.outcome); v != 1 {
				t.Fatalf("serve_parity{%s} = %v, want 1", tc.outcome, v)
			}
		})
	}
}

// An unsampled served request (the draw at or above the rate) is not replayed and counts nothing.
func TestServeParityUnsampledNoReplay(t *testing.T) {
	reg := prometheus.NewRegistry()
	node := nodeAnswering(servedPayload)
	s, _ := paritySrv(reg, served(nil), node)
	s.Parity.Rate = 0.005
	s.Parity.Random = func() float64 { return 0.005 }
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	s.shadows.Wait()
	if w.Code != http.StatusOK || node.callCount() != 0 || parityTotal(t, reg) != 0 {
		t.Fatalf("code=%d replays=%d outcomes=%v, want 200, 0, 0", w.Code, node.callCount(), parityTotal(t, reg))
	}
}

// A request Go did not serve (a fallback, a compute error, the origin refused) is Node's own answer
// already: it is never replayed, whatever the rate.
func TestServeParityNeverReplaysAFallback(t *testing.T) {
	cases := []struct {
		name  string
		fn    func(context.Context, *http.Request) (*computed, error)
		setup func(*http.Request)
	}{
		{name: "fallback", fn: func(context.Context, *http.Request) (*computed, error) { return nil, fallback.New("unported-filter") }},
		{name: "error", fn: func(context.Context, *http.Request) (*computed, error) { return nil, errors.New("replica on fire") }},
		{name: "origin refused", fn: served(nil), setup: func(r *http.Request) { r.Header.Set("Origin", "https://elsewhere.example") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			node := nodeAnswering(servedPayload)
			s, fb := paritySrv(reg, tc.fn, node)
			r := publicRequest()
			if tc.setup != nil {
				tc.setup(r)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			s.shadows.Wait()
			if fb.calls != 1 || node.callCount() != 0 || parityTotal(t, reg) != 0 {
				t.Fatalf("proxied=%d replays=%d outcomes=%v, want 1, 0, 0", fb.calls, node.callCount(), parityTotal(t, reg))
			}
		})
	}
}

// An answer written as devalue is compared as superjson, encoded from its value in the background
// (the shadow compute's format, and what Node answers a replay in).
func TestServeParityDevalueAnswerComparedAsSuperjson(t *testing.T) {
	reg := prometheus.NewRegistry()
	fn := func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(`"[devalue]"`), devalue: true, value: map[string]any{"items": []any{}}}, nil
	}
	s, _ := paritySrv(reg, fn, nodeAnswering(servedPayload))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	s.shadows.Wait()
	if v := compareCount(t, reg, EndpointAsPosts, "match", SourceServeParity); v != 1 {
		t.Fatalf("compare{match,serve-parity} = %v, want 1 (outcomes compared=%v bad_body=%v)", v,
			parityOutcome(t, reg, EndpointAsPosts, ParityCompared), parityOutcome(t, reg, EndpointAsPosts, ParityBadBody))
	}
}

// Through a real reverse proxy and transport, as main wires it: the transport negotiates gzip itself
// (the client's own Accept-Encoding is dropped) and decodes Node's compressed answer, and the
// compared headers Node wrote are compared (a match here).
func TestServeParityThroughAReverseProxy(t *testing.T) {
	var (
		mu    sync.Mutex
		gotAE string
		hit   bool
	)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotAE, hit = r.Header.Get("Accept-Encoding"), true
		mu.Unlock()
		var b bytes.Buffer
		zw := gzip.NewWriter(&b)
		_, _ = zw.Write([]byte(`{"result":{"data":` + servedPayload + `}}`))
		_ = zw.Close()
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Cache-Control", trpc.ResultCacheControl(nil))
		w.Header().Set("Vary", trpc.Vary)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b.Bytes())
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	reg := prometheus.NewRegistry()
	s, _ := paritySrv(reg, served(nil), httputil.NewSingleHostReverseProxy(target))
	r := publicRequest()
	r.Header.Set("Accept-Encoding", "br")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	s.shadows.Wait()
	mu.Lock()
	ae, reached := gotAE, hit
	mu.Unlock()
	if !reached || ae != "gzip" {
		t.Fatalf("Node reached=%v saw Accept-Encoding %q, want the transport's own gzip", reached, ae)
	}
	if v := compareCount(t, reg, EndpointAsPosts, "match", SourceServeParity); v != 1 {
		t.Fatalf("compare{match,serve-parity} = %v, want 1 (bad_body=%v)", v, parityOutcome(t, reg, EndpointAsPosts, ParityBadBody))
	}
	if v, _ := metricValue(t, reg, "feed_go_shadow_response_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": "match", SourceLabel: SourceServeParity}); v != 1 {
		t.Fatalf("response{match,serve-parity} = %v, want 1", v)
	}
}

// The marker is a wire contract with the Node app (src/server/trpc/feed-go-parity-replay.ts reads it
// lowercased), so it is a literal.
func TestParityReplayHeaderIsTheWireName(t *testing.T) {
	if ParityReplayHeader != "X-Feed-Go-Parity-Replay" || SourceServeParity != "serve-parity" || SourceShadow != "shadow" || SourceLabel != "source" {
		t.Fatalf("wire names changed: %q %q %q %q", ParityReplayHeader, SourceServeParity, SourceShadow, SourceLabel)
	}
}

// The compared response headers are picked as the Node sampler picks them: the listed names only,
// Set-Cookie as presence (an empty one absent), each value cut at 1024 characters.
func TestPickResponseHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("Cache-Control", "private")
	h.Add("Vary", "a")
	h.Add("Vary", "b")
	h.Set("Set-Cookie", "s=1")
	h.Set("Cache-Tag", strings.Repeat("t", 2000))
	h.Set("X-Other", "x")
	got := pickResponseHeaders(h)
	if len(got) != 4 || got["cache-control"] != "private" || got["vary"] != "a, b" || got["set-cookie"] != "present" || len(got["cache-tag"]) != 1024 {
		t.Fatalf("picked %v", got)
	}
	h2 := http.Header{"Set-Cookie": {""}}
	if got := pickResponseHeaders(h2); len(got) != 0 {
		t.Fatalf("an empty Set-Cookie picked as %v, want absent", got)
	}
}

// A replay in flight holds a queue slot, so a shadow phase overlapping it is not solo (its CPU is
// not attributed to the sample).
func TestServeParityReplayIsNotSolo(t *testing.T) {
	s := &Server{ShadowQueue: make(chan struct{}, 2), ProbeQueue: make(chan struct{}, 1), Parity: &ServeParity{Queue: make(chan struct{}, 1)}}
	s.ShadowQueue <- struct{}{}
	if !s.aloneInFlight() {
		t.Fatal("one shadow sample, nothing else: want solo")
	}
	s.Parity.Queue <- struct{}{}
	if s.aloneInFlight() {
		t.Fatal("a replay in flight: want not solo")
	}
}
