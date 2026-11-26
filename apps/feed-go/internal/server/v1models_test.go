package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

func postV1Models(t *testing.T, handler http.HandlerFunc, path, input, node string) {
	t.Helper()
	b, err := json.Marshal(ShadowRequest{
		Input: input, Path: path, Headers: map[string]string{"host": "civitai.example", "cf-ipcountry": "US"},
		Node: json.RawMessage(node),
	})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/api/v1/models", strings.NewReader(string(b))))
	if w.Code != http.StatusAccepted {
		t.Fatalf("code %d, want 202", w.Code)
	}
}

func resultCount(t *testing.T, reg *prometheus.Registry, endpoint, result string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": endpoint, "result": result})
	return v
}

// Both model samples run the model compute (never the tRPC or images one), compare as plain JSON,
// and are labelled with their own feed_endpoint; a cached answer is served_cached / match_cached.
func TestV1ModelsShadowSamples(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 2, func(context.Context, *http.Request) (*computed, error) {
		t.Error("the tRPC compute must not run for a model sample")
		return nil, nil
	})
	s.computeV1Fn = func(context.Context, *http.Request) (*computed, error) {
		t.Error("the images compute must not run for a model sample")
		return nil, nil
	}
	var seen []*http.Request
	s.computeV1ModelsFn = func(_ context.Context, r *http.Request) (*computed, error) {
		seen = append(seen, r)
		if strings.HasPrefix(r.URL.Path, "/api/v1/models/") {
			return &computed{payload: []byte(`{"id":42,"name":"a"}`), cached: true}, nil
		}
		return &computed{payload: []byte(`{"items":[{"id":1},{"id":2}],"metadata":{}}`)}, nil
	}
	postV1Models(t, s.ShadowV1ModelsIDHandler, "/api/v1/models/42", "", `{"name":"a","id":42}`)
	waitFor(t, "the cached match", func() bool {
		return resultCount(t, reg, EndpointV1ModelsID, "match_cached") == 1 && len(s.ShadowQueue) == 0
	})
	if n, _ := metricValue(t, reg, "feed_go_shadow_phase_seconds", map[string]string{"feed_endpoint": EndpointV1ModelsID, "phase": "compute", "outcome": "served_cached"}); n != 1 {
		t.Fatalf("served_cached compute phases = %v, want 1", n)
	}
	postV1Models(t, s.ShadowV1ModelsHandler, "/api/v1/models", "limit=2", `{"items":[{"id":2},{"id":1}],"metadata":{}}`)
	waitFor(t, "the list order diff", func() bool { return resultCount(t, reg, EndpointV1Models, "order") == 1 && len(s.ShadowQueue) == 0 })
	if len(seen) != 2 || seen[0].URL.Path != "/api/v1/models/42" || seen[1].URL.RawQuery != "limit=2" || seen[1].Host != "civitai.example" {
		t.Fatalf("synthetic requests: %+v", seen)
	}
	for _, e := range []string{EndpointV1Models, EndpointV1ModelsID} {
		if v, found := metricValue(t, reg, "feed_go_shadow_dropped_total", map[string]string{"feed_endpoint": e}); !found || v != 0 {
			t.Fatalf("dropped{%s} = %v found=%v, want a 0 series", e, v, found)
		}
	}
}

func TestClassifyV1ModelID(t *testing.T) {
	report := func(g, n string) *shadow.Report {
		r, err := shadow.CompareJSON([]byte(g), []byte(n))
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	for _, c := range []struct{ goBody, node, want string }{
		{`{"id":1}`, `{"id":1}`, "match"},
		{`{"id":1,"name":"a"}`, `{"id":1,"name":"b"}`, "fields"},
		{`{"error":"No model with id 1"}`, `{"id":1}`, "membership"},
	} {
		if got := ClassifyV1ModelID(report(c.goBody, c.node), []byte(c.goBody), []byte(c.node)); got != c.want {
			t.Errorf("%s vs %s: %s, want %s", c.goBody, c.node, got, c.want)
		}
	}
}

func TestV1ModelsRoute(t *testing.T) {
	s := &Server{}
	if _, _, ok := s.v1ModelsRoute(EndpointV1Images); ok {
		t.Fatal("the images endpoint is not a model route")
	}
	for _, e := range []string{EndpointV1Models, EndpointV1ModelsID} {
		if b, c, ok := s.v1ModelsRoute(e); !ok || b == nil || c == nil {
			t.Fatalf("%s: no route", e)
		}
	}
	r, err := SyntheticV1ModelsRequest(context.Background(), ShadowRequest{Input: "a=1", Headers: map[string]string{"host": "h.example"}})
	if err != nil || r.URL.Path != V1ModelsPath || r.URL.RawQuery != "a=1" || r.Host != "h.example" || r.Method != http.MethodGet {
		t.Fatalf("synthetic: %+v %v", r, err)
	}
}

func TestComputeV1ModelsFallbacks(t *testing.T) {
	ctx := context.Background()
	req := func(method, target string, headers map[string]string) *http.Request {
		r := httptest.NewRequestWithContext(ctx, method, target, nil)
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		return r
	}
	unconfigured := &Server{}
	// No edge URL prefix: a request that reaches the port falls back there (v1-models-unconfigured-urls).
	configured := &Server{
		Resolver: &auth.Resolver{},
		V1Models: &V1ModelsDeps{Deps: &v1models.Deps{Config: v1models.Config{BaseURL: "https://s.example"}}},
	}
	for _, c := range []struct {
		name   string
		s      *Server
		id     bool
		r      *http.Request
		reason string
	}{
		{"list unconfigured", unconfigured, false, req(http.MethodGet, "/api/v1/models", nil), "v1-models-unconfigured"},
		{"id unconfigured", unconfigured, true, req(http.MethodGet, "/api/v1/models/1", nil), "v1-models-unconfigured"},
		{"list POST", configured, false, req(http.MethodPost, "/api/v1/models", nil), "method"},
		{"id POST", configured, true, req(http.MethodPost, "/api/v1/models/1", nil), "method"},
		{"list text query", configured, false, req(http.MethodGet, "/api/v1/models?query=x", nil), "v1-models-query"},
		{"list API key", configured, false, req(http.MethodGet, "/api/v1/models", map[string]string{"Authorization": "Bearer k"}), "bearer-token"},
		{"list reaches the port", configured, false, req(http.MethodGet, "/api/v1/models?limit=2", map[string]string{"cf-ipcountry": "US"}), "v1-models-unconfigured-urls"},
		{"id API key", configured, true, req(http.MethodGet, "/api/v1/models/1", map[string]string{"Authorization": "Bearer k"}), "bearer-token"},
		{"id nested path", configured, true, req(http.MethodGet, "/api/v1/models/1/2", nil), "v1-models-path"},
		{"id not under the route", configured, true, req(http.MethodGet, "/api/v1/images/1", nil), "v1-models-path"},
		{"id reaches the port", configured, true, req(http.MethodGet, "/api/v1/models/7", nil), "v1-models-unconfigured-urls"},
	} {
		var err error
		if c.id {
			_, err = c.s.computeV1ModelsID(ctx, c.r)
		} else {
			_, err = c.s.computeV1Models(ctx, c.r)
		}
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: %q (%v), want %q", c.name, got, err, c.reason)
		}
	}
}

func TestV1ModelsAnswerEncodesPlainJSON(t *testing.T) {
	c, err := v1ModelsAnswer(&v1models.Answer{Body: superjson.Object{{Key: "id", Val: int64(1)}, {Key: "x", Val: superjson.Undefined{}}}, Trivial: true})
	if err != nil {
		t.Fatal(err)
	}
	defer c.release()
	if string(c.payload) != `{"id":1}` || !c.trivial || c.cached {
		t.Fatalf("answer: %s %+v", c.payload, c)
	}
	if _, err := v1ModelsAnswer(&v1models.Answer{Body: superjson.Object{{Key: "bad", Val: make(chan int)}}}); err == nil {
		t.Fatal("an unencodable body is an error")
	}
}

func TestInternalMuxRoutesTheModelShadows(t *testing.T) {
	s := newPhaseServer(prometheus.NewRegistry(), 1, nil)
	mux := InternalMux(s, http.NotFoundHandler(), false)
	for _, path := range []string{"/internal/shadow/api/v1/models", "/internal/shadow/api/v1/models/id"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: %d, want the shadow handler's 405 for a GET", path, w.Code)
		}
	}
}

// The model routes read the Host header as Node's req.headers.host: a rebuilt sample's (origin form,
// the forwarded header) and an origin-form request's; an absolute-form request line, whose host
// replaces the header in net/http, falls back. The statement-hash header reaches the listing.
func TestV1ModelsHost(t *testing.T) {
	r, err := SyntheticV1ModelsRequest(context.Background(), ShadowRequest{
		Path: "/api/v1/models/1", Headers: map[string]string{"host": "Red.Example:8443", v1models.TrainingDataSQLHeader: "abc"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if h, err := v1ModelsHost(r); err != nil || h != "Red.Example:8443" {
		t.Errorf("sample: %q %v", h, err)
	}
	if got := r.Header.Get(v1models.TrainingDataSQLHeader); got != "abc" {
		t.Errorf("hash header %q", got)
	}
	origin := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/v1/models", nil)
	origin.Host = "site.example"
	if h, err := v1ModelsHost(origin); err != nil || h != "site.example" {
		t.Errorf("origin form: %q %v", h, err)
	}
	abs := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://other.example/api/v1/models", nil)
	if _, err := v1ModelsHost(abs); fallback.Reason(err) != "v1-models-host" {
		t.Errorf("absolute form: %v", err)
	}
}
