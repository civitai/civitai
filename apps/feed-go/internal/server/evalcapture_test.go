package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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

// feed_go_eval_capture_total is seeded: every outcome per source for the endpoints it captures (shadow
// and serve: the four first-wave endpoints; serve-parity: the three tRPC ones), and nothing else.
func TestEvalCaptureSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	if n := testutil.CollectAndCount(m.EvalCapture); n != 4*3+3*3+4*3 {
		t.Fatalf("feed_go_eval_capture_total has %d series, want 33", n)
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
	if _, found := metricValue(t, reg, "feed_go_eval_capture_total", map[string]string{"feed_endpoint": "v1-models-id", "source": "serve-parity", "outcome": "written"}); found {
		t.Error("serve-parity never replays v1-models-id, but its series exists")
	}
}
