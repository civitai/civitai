package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// fakeRecorder records every capture handed to it and answers OutcomeWritten.
type fakeRecorder struct {
	mu      sync.Mutex
	samples []evalcapture.Sample
}

func (f *fakeRecorder) Record(s evalcapture.Sample) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.samples = append(f.samples, s)
	return evalcapture.OutcomeWritten
}

func (f *fakeRecorder) got() []evalcapture.Sample {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]evalcapture.Sample(nil), f.samples...)
}

// evalUser is the session user the computes below resolve (synthetic).
var evalUser = &auth.SessionUser{ID: 31337, Username: "viewer-name", BrowsingLevel: 3, ShowNsfw: true}

// resolving is a compute that resolves evalUser as a compute does (through Resolver.Resolve, here
// answering a recorded result) and then returns answer.
func resolving(answer func() (*computed, error)) func(context.Context, *http.Request) (*computed, error) {
	return func(ctx context.Context, r *http.Request) (*computed, error) {
		if _, err := (&auth.Resolver{}).Resolve(auth.WithResolved(ctx, evalUser, nil), r); err != nil {
			return nil, err
		}
		return answer()
	}
}

// evalCount reads feed_go_eval_capture_total{feed_endpoint="as-posts",source,outcome}.
func evalCount(t *testing.T, reg *prometheus.Registry, source, outcome string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_eval_capture_total", map[string]string{"feed_endpoint": EndpointAsPosts, "source": source, "outcome": outcome})
	return v
}

// Off (EvalCapture nil, or one without a recorder), the taps add nothing: no observer on any context.
func TestEvalCaptureOffObservesNothing(t *testing.T) {
	for _, e := range []*EvalCapture{nil, {ServeRate: 1, Queue: make(chan struct{}, 1)}} {
		s := &Server{EvalCapture: e}
		ctx := context.Background()
		got, obs := s.observeViewer(ctx)
		if got != ctx || obs != nil {
			t.Errorf("EvalCapture %+v: observeViewer changed the context", e)
		}
	}
}

// T1: a shadow sample is captured on each branch of compare: a hand-back (its reason), a compute
// error, and a comparison (the result, header result and categories feed_go_shadow_compare_total and
// the diffs counted), with the viewer the compute resolved, Node's answer, and weight 1 / the sample's
// rate (the configured shadow rate when the sample sends none).
func TestEvalCaptureShadowBranches(t *testing.T) {
	node := json.RawMessage(`{"json":{"items":[{"id":1}]}}`)
	headers := map[string]string{"host": "site.example", "cookie": "a=b"}
	cases := []struct {
		name       string
		answer     func() (*computed, error)
		sampleRate float64
		result     string
		reason     string
		weight     float64
		compared   bool
	}{
		{"hand-back", func() (*computed, error) { return nil, fallback.New("test-reason") }, 0, "unsupported", "test-reason", 4, false},
		{"error", func() (*computed, error) { return nil, errors.New("boom") }, 0.5, "go_error", "", 2, false},
		{"compared", func() (*computed, error) { return &computed{payload: []byte(servedPayload)}, nil }, 0, "", "", 4, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			rec := &fakeRecorder{}
			s := serveServer(reg, resolving(c.answer), nil)
			s.EvalCapture = &EvalCapture{Recorder: rec, ShadowRate: 0.25}
			s.compare(context.Background(), EndpointAsPosts, ShadowRequest{
				Input: `{"json":{"limit":5}}`, Headers: headers, Node: node,
				ResponseHeaders: map[string]string{"cache-control": "private"}, SampleRate: c.sampleRate,
			})
			got := rec.got()
			if len(got) != 1 {
				t.Fatalf("%d captures, want 1", len(got))
			}
			g := got[0]
			if g.Source != evalcapture.SourceShadow || g.Request.Endpoint != EndpointAsPosts || g.Request.Input != `{"json":{"limit":5}}` ||
				g.Request.Headers["Cookie"] != "a=b" || g.Request.Headers["Host"] != "site.example" {
				t.Errorf("request %+v", g.Request)
			}
			if !g.ViewerKnown || g.Viewer.Class != FeedViewerUser || g.Viewer.UserID != 31337 || g.Viewer.Username != "viewer-name" || g.Viewer.BrowsingLevel != 3 {
				t.Errorf("viewer %+v known=%v", g.Viewer, g.ViewerKnown)
			}
			if g.Weight != c.weight || string(g.NodeBody) != string(node) || g.NodeHeaders["cache-control"] != "private" {
				t.Errorf("weight %v body %s headers %v", g.Weight, g.NodeBody, g.NodeHeaders)
			}
			if !c.compared {
				if g.ProdResult != c.result || g.FallbackReason != c.reason {
					t.Errorf("result %q reason %q, want %q %q", g.ProdResult, g.FallbackReason, c.result, c.reason)
				}
			} else {
				if g.ProdResult == "match" || compareCount(t, reg, EndpointAsPosts, g.ProdResult, SourceShadow) != 1 {
					t.Errorf("result %q is not the one counted", g.ProdResult)
				}
				if len(g.DiffCategories) == 0 || g.HeaderResult != "mismatch" {
					t.Errorf("categories %v header %q", g.DiffCategories, g.HeaderResult)
				}
			}
			if evalCount(t, reg, "shadow", "written") != 1 {
				t.Error("outcome not counted")
			}
		})
	}
}

// T1 on an endpoint outside the first wave captures nothing; a compute that never resolved a viewer
// is resolved by the tap (no resolver here: signed out).
func TestEvalCaptureShadowEndpointAndViewerFallback(t *testing.T) {
	rec := &fakeRecorder{}
	s := serveServer(prometheus.NewRegistry(), nil, nil)
	s.computeV1Fn = served(nil)
	s.EvalCapture = &EvalCapture{Recorder: rec}
	s.compare(context.Background(), EndpointV1Images, ShadowRequest{Input: "limit=1", Node: json.RawMessage(`{}`)})
	if n := len(rec.got()); n != 0 {
		t.Fatalf("v1-images captured %d times", n)
	}
	s.computeFn = func(context.Context, *http.Request) (*computed, error) { return nil, fallback.New("method") }
	s.compare(context.Background(), EndpointAsPosts, ShadowRequest{Input: `{}`, Node: json.RawMessage(`{}`)})
	got := rec.got()
	if len(got) != 1 || !got[0].ViewerKnown || got[0].Viewer.Class != FeedViewerAnon || got[0].Weight != 0 {
		t.Fatalf("captures %+v", got)
	}
}

// T2: a compared serve-parity replay is captured once, with Node's answer, the viewer the served
// compute resolved, the request as served (credentials included: the recorder strips them) and
// weight 1 / the parity rate.
func TestEvalCaptureServeParity(t *testing.T) {
	reg := prometheus.NewRegistry()
	nodeEnvelope := `{"json":{"items":[{"id":9}]}}`
	node := nodeAnswering(nodeEnvelope)
	rec := &fakeRecorder{}
	s, _ := paritySrv(reg, resolving(func() (*computed, error) { return &computed{payload: []byte(servedPayload)}, nil }), node)
	s.Parity.Rate = 0.5
	s.Parity.Random = func() float64 { return 0 }
	s.EvalCapture = &EvalCapture{Recorder: rec}
	r := publicRequest()
	r.Header.Set("Cookie", "__Secure-civitai-token=abc")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	s.shadows.Wait()
	got := rec.got()
	if len(got) != 1 {
		t.Fatalf("%d captures, want 1 (serve rate 0: no T3)", len(got))
	}
	g := got[0]
	if g.Source != evalcapture.SourceServeParity || g.Weight != 2 || string(g.NodeBody) != nodeEnvelope ||
		g.Request.Headers["Cookie"] != "__Secure-civitai-token=abc" || g.Request.Input != "{}" {
		t.Errorf("capture %+v", g)
	}
	if !g.ViewerKnown || g.Viewer.UserID != 31337 || g.ProdResult == "" || g.ProdResult == "match" {
		t.Errorf("viewer %+v result %q", g.Viewer, g.ProdResult)
	}
	if evalCount(t, reg, "serve-parity", "written") != 1 {
		t.Error("outcome not counted")
	}
}

// T3: at FEED_GO_EVAL_CAPTURE_SERVE_RATE, a served request is captured as served, a hand-back with its
// reason, a compute error as error; with no Node answer, weight 1 / the rate; a request not picked is
// not captured.
func TestEvalCaptureServe(t *testing.T) {
	cases := []struct {
		name         string
		answer       func() (*computed, error)
		random       float64
		want, reason string
	}{
		{"served", func() (*computed, error) { return &computed{payload: []byte(servedPayload)}, nil }, 0, "served", ""},
		{"hand-back", func() (*computed, error) { return nil, fallback.New("test-reason") }, 0, "handback", "test-reason"},
		{"error", func() (*computed, error) { return nil, errors.New("boom") }, 0, "error", "error"},
		{"not picked", func() (*computed, error) { return &computed{payload: []byte(servedPayload)}, nil }, 0.5, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			rec := &fakeRecorder{}
			fb := &proxyRecorder{}
			s := serveServer(reg, resolving(c.answer), fb)
			s.EvalCapture = &EvalCapture{Recorder: rec, ServeRate: 0.25, Queue: make(chan struct{}, 2), Random: func() float64 { return c.random }}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, publicRequest())
			s.shadows.Wait()
			got := rec.got()
			if c.want == "" {
				if len(got) != 0 {
					t.Fatalf("not picked, captured %d", len(got))
				}
				return
			}
			if len(got) != 1 {
				t.Fatalf("%d captures, want 1", len(got))
			}
			g := got[0]
			if g.Source != evalcapture.SourceServe || g.ProdResult != c.want || g.FallbackReason != c.reason || g.Weight != 4 || g.NodeBody != nil {
				t.Errorf("capture %+v", g)
			}
			if !g.ViewerKnown || g.Viewer.UserID != 31337 {
				t.Errorf("viewer %+v known=%v", g.Viewer, g.ViewerKnown)
			}
			if evalCount(t, reg, "serve", "written") != 1 {
				t.Error("outcome not counted")
			}
		})
	}
}

// T3 on hand-backs decided before any compute (the route's switch off): the reason, the viewer
// resolved by the capture worker (no resolver: signed out), on the tRPC and the REST route alike.
func TestEvalCaptureServeSwitchOffHandbacks(t *testing.T) {
	reg := prometheus.NewRegistry()
	rec := &fakeRecorder{}
	up := &proxyRecorder{}
	s := serveServer(reg, nil, up)
	s.V1Fallback = up
	s.EvalCapture = &EvalCapture{Recorder: rec, ServeRate: 1, Queue: make(chan struct{}, 2), Random: func() float64 { return 0 }}
	s.ServeModelGetAllHTTP(httptest.NewRecorder(), modelsServeRequest("https://site.example"))
	s.shadows.Wait()
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/models/5?limit=1", nil)
	s.ServeV1ModelsIDHTTP(httptest.NewRecorder(), r)
	s.shadows.Wait()
	got := rec.got()
	if len(got) != 2 {
		t.Fatalf("%d captures, want 2", len(got))
	}
	if g := got[0]; g.Request.Endpoint != EndpointModelGetAll || g.ProdResult != "handback" || g.FallbackReason != "model-getall-off" ||
		!g.ViewerKnown || g.Viewer.Class != FeedViewerAnon {
		t.Errorf("model-getall capture %+v", g)
	}
	if g := got[1]; g.Request.Endpoint != EndpointV1ModelsID || g.Request.Path != "/api/v1/models/5" || g.Request.Query != "limit=1" ||
		g.FallbackReason != "v1-models-off" || !g.ViewerKnown {
		t.Errorf("v1-models-id capture %+v", g)
	}
	if up.calls != 2 {
		t.Errorf("proxied %d, want 2", up.calls)
	}
}

// T3 never blocks the request: with every capture worker busy, the request is answered and the
// capture is dropped (counted), never queued behind the workers; shutting down drops too.
func TestEvalCaptureServeFullQueueDrops(t *testing.T) {
	reg := prometheus.NewRegistry()
	rec := &fakeRecorder{}
	s := serveServer(reg, served(nil), &proxyRecorder{})
	q := make(chan struct{}, 1)
	q <- struct{}{}
	s.EvalCapture = &EvalCapture{Recorder: rec, ServeRate: 1, Queue: q, Random: func() float64 { return 0 }}
	done := make(chan int, 1)
	go func() {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, publicRequest())
		done <- w.Code
	}()
	select {
	case code := <-done:
		if code != http.StatusOK {
			t.Fatalf("code %d", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the request waited for a capture worker")
	}
	if len(rec.got()) != 0 || evalCount(t, reg, "serve", "dropped") != 1 {
		t.Errorf("captures %d dropped %v, want 0 and 1", len(rec.got()), evalCount(t, reg, "serve", "dropped"))
	}
	<-q
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.ServeHTTP(httptest.NewRecorder(), publicRequest())
	if len(rec.got()) != 0 || evalCount(t, reg, "serve", "dropped") != 2 {
		t.Errorf("after Close: captures %d dropped %v, want 0 and 2", len(rec.got()), evalCount(t, reg, "serve", "dropped"))
	}
}

// T1's weight is 1 / the sample's own sampleRate when it sends one in (0, 1], else 1 / the configured
// FEED_GO_EVAL_CAPTURE_SHADOW_RATE: absent (an older sampler), above 1 or negative. The rates are
// pairwise distinct, so a weight hardcoded to either one cannot pass every case.
func TestEvalCaptureShadowWeightFromSampleRate(t *testing.T) {
	const envRate = 0.0625 // weight 16
	for _, c := range []struct {
		name       string
		sampleRate float64
		want       float64
	}{
		{"sent", 0.125, 8},
		{"sent, at the bound", 1, 1},
		{"absent", 0, 16},
		{"above 1", 1.5, 16},
		{"negative", -0.25, 16},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec := &fakeRecorder{}
			s := serveServer(prometheus.NewRegistry(), resolving(func() (*computed, error) { return &computed{payload: []byte(servedPayload)}, nil }), nil)
			s.EvalCapture = &EvalCapture{Recorder: rec, ShadowRate: envRate}
			s.compare(context.Background(), EndpointAsPosts, ShadowRequest{
				Input: `{"json":{"limit":5}}`, Headers: map[string]string{"host": "site.example"},
				Node: json.RawMessage(`{"json":{"items":[]}}`), SampleRate: c.sampleRate,
			})
			got := rec.got()
			if len(got) != 1 || got[0].Weight != c.want {
				t.Fatalf("captures %+v, want one of weight %v", got, c.want)
			}
		})
	}
}

// corpusOnlyBody is a corpus-only sample's POST body (synthetic values). A nil Node is marshalled as
// `"node":null`, which carries no answer and is accepted as Node's absent member is.
func corpusOnlyBody(t *testing.T, req ShadowRequest) *strings.Reader {
	t.Helper()
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	return strings.NewReader(string(b))
}

// shadowCompareTotal is every feed_go_shadow_compare_total series of endpoint added up.
func shadowCompareTotal(t *testing.T, reg *prometheus.Registry, endpoint string) float64 {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	sum := 0.0
	for _, mf := range mfs {
		if mf.GetName() != "feed_go_shadow_compare_total" {
			continue
		}
		for _, m := range mf.GetMetric() {
			for _, l := range m.GetLabel() {
				if l.GetName() == "feed_endpoint" && l.GetValue() == endpoint {
					sum += m.GetCounter().GetValue()
				}
			}
		}
	}
	return sum
}

// corpusOnlyServer is a shadow server whose v1-models compute fails the test if it ever runs: a
// corpus-only sample is never computed.
func corpusOnlyServer(t *testing.T, reg *prometheus.Registry, rec EvalRecorder) *Server {
	t.Helper()
	s := newPhaseServer(reg, 2, nil)
	s.computeV1ModelsFn = func(context.Context, *http.Request) (*computed, error) {
		t.Error("a corpus-only sample was computed")
		return nil, errors.New("computed")
	}
	if rec != nil {
		s.EvalCapture = &EvalCapture{Recorder: rec, ShadowRate: 0.5}
	}
	return s
}

func postCorpusOnly(t *testing.T, s *Server, req ShadowRequest) int {
	t.Helper()
	w := httptest.NewRecorder()
	s.ShadowV1ModelsIDHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/api/v1/models/id", corpusOnlyBody(t, req)))
	return w.Code
}

// T4: a corpus-only sample is recorded with source corpus-only, its credential class (header or query)
// on the request, weight 1 / its own sampleRate (never the shadow's configured rate), no Node answer
// and a signed-out viewer; it is never computed and no comparison result is counted.
func TestEvalCaptureCorpusOnlyRecorded(t *testing.T) {
	for _, class := range []string{"header", "query"} {
		t.Run(class, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			rec := &fakeRecorder{}
			s := corpusOnlyServer(t, reg, rec)
			code := postCorpusOnly(t, s, ShadowRequest{
				CorpusOnly: true, Credential: class, SampleRate: 0.03125,
				Input: "limit=1", Path: "/api/v1/models/5001", Headers: map[string]string{"host": "site.example", "cf-ipcountry": "US"},
			})
			if code != http.StatusAccepted {
				t.Fatalf("code %d, want 202", code)
			}
			got := rec.got()
			if len(got) != 1 {
				t.Fatalf("%d captures, want 1", len(got))
			}
			g := got[0]
			if g.Source != evalcapture.SourceCorpusOnly || g.Request.Endpoint != EndpointV1ModelsID || g.Request.CredentialClass != class ||
				g.Request.Path != "/api/v1/models/5001" || g.Request.Query != "limit=1" || g.Request.Headers["host"] != "site.example" {
				t.Errorf("capture %+v", g)
			}
			if g.Weight != 32 || g.ProdResult != evalcapture.ResultCorpusOnly || g.NodeBody != nil || g.NodeHeaders != nil {
				t.Errorf("weight %v result %q node %s %v", g.Weight, g.ProdResult, g.NodeBody, g.NodeHeaders)
			}
			if !g.ViewerKnown || g.Viewer.Class != FeedViewerAnon || g.Viewer.UserID != 0 {
				t.Errorf("viewer %+v known=%v", g.Viewer, g.ViewerKnown)
			}
			if n := shadowCompareTotal(t, reg, EndpointV1ModelsID); n != 0 {
				t.Errorf("%v comparison results counted, want 0", n)
			}
			if v, _ := metricValue(t, reg, "feed_go_eval_capture_total", map[string]string{"feed_endpoint": EndpointV1ModelsID, "source": "corpus-only", "outcome": "written"}); v != 1 {
				t.Errorf("written = %v, want 1", v)
			}
			if len(s.ShadowQueue) != 0 {
				t.Errorf("queue holds %d slots after the sample", len(s.ShadowQueue))
			}
		})
	}
}

// T4 refuses (400, counted refused, never recorded) a corpus-only sample that still carries a
// credential of any kind, a credential class other than exactly header or query, or Node's answer.
func TestEvalCaptureCorpusOnlyRefused(t *testing.T) {
	ok := func() ShadowRequest {
		return ShadowRequest{CorpusOnly: true, Credential: "header", SampleRate: 0.25, Input: "limit=1", Path: "/api/v1/models/5001",
			Headers: map[string]string{"host": "site.example"}}
	}
	for _, c := range []struct {
		name string
		edit func(*ShadowRequest)
	}{
		{"an authorization header", func(r *ShadowRequest) { r.Headers["Authorization"] = "Bearer synthetic-key" }},
		{"an authorization placeholder", func(r *ShadowRequest) { r.Headers["authorization"] = "present" }},
		{"a credential description header", func(r *ShadowRequest) { r.Headers["x-feed-go-credential"] = "key:described" }},
		{"a session cookie", func(r *ShadowRequest) { r.Headers["cookie"] = "theme=dark; __Secure-civitai-token=synthetic" }},
		{"a token query pair", func(r *ShadowRequest) { r.Input = "limit=1&token=synthetic-key" }},
		{"an escaped token query pair", func(r *ShadowRequest) { r.Input = "limit=1&%74oken=synthetic-key" }},
		{"a credential-named query pair", func(r *ShadowRequest) { r.Input = "apiKey=synthetic-key" }},
		{"a node body", func(r *ShadowRequest) { r.Node = json.RawMessage(`{"id":5001}`) }},
		{"node response headers", func(r *ShadowRequest) { r.ResponseHeaders = map[string]string{"etag": "x"} }},
		{"a search backend answer", func(r *ShadowRequest) { r.Upstream = json.RawMessage(`{"hits":[]}`) }},
		{"no credential class", func(r *ShadowRequest) { r.Credential = "" }},
		{"the session class", func(r *ShadowRequest) { r.Credential = "session" }},
		{"a joined class", func(r *ShadowRequest) { r.Credential = "header+query" }},
		{"a class in another case", func(r *ShadowRequest) { r.Credential = "Header" }},
	} {
		t.Run(c.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			rec := &fakeRecorder{}
			s := corpusOnlyServer(t, reg, rec)
			req := ok()
			c.edit(&req)
			if code := postCorpusOnly(t, s, req); code != http.StatusBadRequest {
				t.Errorf("code %d, want 400", code)
			}
			if n := len(rec.got()); n != 0 {
				t.Errorf("Record called %d times, want 0", n)
			}
			if v, _ := metricValue(t, reg, "feed_go_eval_capture_total", map[string]string{"feed_endpoint": EndpointV1ModelsID, "source": "corpus-only", "outcome": "refused"}); v != 1 {
				t.Errorf("refused = %v, want 1", v)
			}
			if n := shadowCompareTotal(t, reg, EndpointV1ModelsID); n != 0 {
				t.Errorf("%v comparison results counted, want 0", n)
			}
		})
	}
	// The control: the same sample unedited is recorded, so each case above is refused for its edit.
	rec := &fakeRecorder{}
	if code := postCorpusOnly(t, corpusOnlyServer(t, prometheus.NewRegistry(), rec), ok()); code != http.StatusAccepted || len(rec.got()) != 1 {
		t.Fatalf("the unedited sample: code %d, %d captures, want 202 and 1", code, len(rec.got()))
	}
}

// T4 with the capture off (or on an endpoint it does not capture) is accepted and discarded: nothing
// recorded, computed, compared or counted.
func TestEvalCaptureCorpusOnlyDiscarded(t *testing.T) {
	req := ShadowRequest{CorpusOnly: true, Credential: "query", SampleRate: 0.25, Path: "/api/v1/models/5001", Headers: map[string]string{"host": "site.example"}}
	reg := prometheus.NewRegistry()
	s := corpusOnlyServer(t, reg, nil)
	if code := postCorpusOnly(t, s, req); code != http.StatusAccepted {
		t.Fatalf("capture off: code %d, want 202", code)
	}
	if n := shadowCompareTotal(t, reg, EndpointV1ModelsID); n != 0 {
		t.Errorf("capture off: %v comparison results counted", n)
	}
	rec := &fakeRecorder{}
	s = corpusOnlyServer(t, prometheus.NewRegistry(), rec)
	w := httptest.NewRecorder()
	s.ShadowV1ModelsHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/api/v1/models", corpusOnlyBody(t, req)))
	if w.Code != http.StatusAccepted || len(rec.got()) != 0 {
		t.Fatalf("the list endpoint: code %d, %d captures, want 202 and 0", w.Code, len(rec.got()))
	}
}

// feed_go_eval_capture_total is seeded: every outcome per source for the endpoints it captures (shadow
// and serve: the four first-wave endpoints; serve-parity: the three tRPC ones), and nothing else.
func TestEvalCaptureSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	if n := testutil.CollectAndCount(m.EvalCapture); n != 4*3+3*3+4*3+1*4 {
		t.Fatalf("feed_go_eval_capture_total has %d series, want 37", n)
	}
	for _, o := range []string{"written", "deduped", "dropped", "refused"} {
		if v, found := metricValue(t, reg, "feed_go_eval_capture_total", map[string]string{"feed_endpoint": "v1-models-id", "source": "corpus-only", "outcome": o}); !found || v != 0 {
			t.Errorf("eval_capture{v1-models-id,corpus-only,%s} = %v found=%v, want a 0 series", o, v, found)
		}
	}
	if _, found := metricValue(t, reg, "feed_go_eval_capture_total", map[string]string{"feed_endpoint": "as-posts", "source": "corpus-only", "outcome": "written"}); found {
		t.Error("corpus-only is sent for v1-models-id only, but an as-posts series exists")
	}
	for source, endpoints := range map[string][]string{
		"shadow":       {"as-posts", "infinite", "model-getall", "v1-models-id"},
		"serve":        {"as-posts", "infinite", "model-getall", "v1-models-id"},
		"serve-parity": {"as-posts", "infinite", "model-getall"},
	} {
		for _, e := range endpoints {
			for _, o := range []string{"written", "deduped", "dropped"} {
				if v, found := metricValue(t, reg, "feed_go_eval_capture_total", map[string]string{"feed_endpoint": e, "source": source, "outcome": o}); !found || v != 0 {
					t.Errorf("eval_capture{%s,%s,%s} = %v found=%v, want a 0 series", e, source, o, v, found)
				}
			}
		}
	}
	if n := testutil.CollectAndCount(m.EvalCaptureRowsDropped); n != 2*7 {
		t.Errorf("feed_go_eval_capture_rows_dropped_total has %d series, want 14", n)
	}
	for _, table := range []string{"samples", "cases"} {
		for _, reason := range []string{"queue_full", "marshal", "http_4xx", "http_other", "http_5xx", "transport", "shutdown"} {
			if v, found := metricValue(t, reg, "feed_go_eval_capture_rows_dropped_total", map[string]string{"table": table, "reason": reason}); !found || v != 0 {
				t.Errorf("rows_dropped{%s,%s} = %v found=%v, want a 0 series", table, reason, v, found)
			}
		}
	}
	if _, found := metricValue(t, reg, "feed_go_eval_capture_total", map[string]string{"feed_endpoint": "v1-models-id", "source": "serve-parity", "outcome": "written"}); found {
		t.Error("serve-parity never replays v1-models-id, but its series exists")
	}
}
