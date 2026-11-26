package server

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/beacon-go/internal/auth"
	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/golden"
)

type recordingWriter struct {
	mu   sync.Mutex
	rows []beacon.Write
}

func (w *recordingWriter) Enqueue(r beacon.Write) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.rows = append(w.rows, r)
	return true
}

type nilSessions struct{}

func (nilSessions) Resolve(context.Context, *http.Request) (*auth.SessionUser, error) {
	return nil, nil
}

func newServer(t *testing.T, engine *beacon.Engine, proxy http.Handler) (*Server, *recordingWriter) {
	t.Helper()
	w := &recordingWriter{}
	return &Server{
		Engine:      engine,
		Mode:        ModeServe,
		Writer:      w,
		Proxy:       proxy,
		Metrics:     NewMetrics(prometheus.NewRegistry()),
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		ShadowQueue: make(chan struct{}, 2),
	}, w
}

// TestServeGolden runs every non-fallback fixture through the public handler and checks the bytes on
// the wire: status, the compared headers, no sniffed Content-Type, the body, and the queued rows.
func TestServeGolden(t *testing.T) {
	served := 0
	for _, fx := range golden.LoadFixtures(t, golden.Dir) {
		if fx.Fallback != "" {
			continue
		}
		s, w := newServer(t, fx.Engine(), nil)
		hreq, _ := fx.HTTPRequest(t)
		rec := httptest.NewRecorder()
		PublicMux(s).ServeHTTP(rec, hreq)
		out := beacon.Outcome{Response: beacon.Response{Status: rec.Code, Body: rec.Body.String()}, Writes: w.rows}
		for _, name := range beacon.ComparedHeaders {
			if v := rec.Header().Get(name); v != "" {
				out.Response.Headers = append(out.Response.Headers, beacon.Header{Name: name, Value: v})
			}
		}
		t.Run(fx.Endpoint+"/"+fx.Name, func(t *testing.T) { fx.CheckOutcome(t, out) })
		served++
	}
	if served < 70 {
		t.Fatalf("only %d fixtures served", served)
	}
}

func TestFallbackIsProxiedWithTheWholeBody(t *testing.T) {
	var got struct {
		path, body, auth string
	}
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got.path, got.body, got.auth = r.URL.Path, string(b), r.Header.Get("Authorization")
		w.WriteHeader(299)
	})
	engine := &beacon.Engine{Sessions: nilSessions{}, TrackerEnabled: true}
	s, w := newServer(t, engine, backend)
	body := `{"path":"/x"}`
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/internal/ping?token=abc", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer k")
	rec := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(rec, r)
	if rec.Code != 299 || got.body != body || got.path != "/api/internal/ping" || got.auth != "Bearer k" {
		t.Fatalf("proxied %d %+v", rec.Code, got)
	}
	if len(w.rows) != 0 {
		t.Fatal("a fallback must not write")
	}
	if n := testutil.ToFloat64(s.Metrics.Fallbacks.WithLabelValues("ping", "serve", "query-string")); n != 1 {
		t.Fatalf("fallback counter %v", n)
	}
	if n := testutil.ToFloat64(s.Metrics.Requests.WithLabelValues("ping", "fallback")); n != 1 {
		t.Fatalf("requests counter %v", n)
	}
	// Any other path goes to the Node app too; without a proxy it is a 404.
	rec = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/other", nil))
	if rec.Code != 299 {
		t.Fatalf("other path: %d", rec.Code)
	}
	s.Proxy = nil
	rec = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/other", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("other path without a proxy: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/internal/pulse?x", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("a fallback without a proxy: %d", rec.Code)
	}
}

type panicky struct{}

func (panicky) Resolve(context.Context, *http.Request) (*auth.SessionUser, error) { panic("boom") }

func TestAPanicFallsBackAndIsCounted(t *testing.T) {
	proxied := false
	engine := &beacon.Engine{Sessions: panicky{}, TrackerEnabled: true}
	s, _ := newServer(t, engine, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied = true
		w.WriteHeader(200)
	}))
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/internal/ping", strings.NewReader(`{"path":"/"}`))
	r.Host = "a.test"
	r.Header.Set("Referer", "https://a.test/")
	r.Header.Set("CF-Connecting-IP", "192.0.2.1")
	PublicMux(s).ServeHTTP(httptest.NewRecorder(), r)
	if !proxied || testutil.ToFloat64(s.Metrics.Panics.WithLabelValues("serve")) != 1 ||
		testutil.ToFloat64(s.Metrics.Fallbacks.WithLabelValues("ping", "serve", "panic")) != 1 {
		t.Fatal("a panic must fall back to the Node app and be counted")
	}
}

func TestWriteResponseSetsNoContentType(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteResponse(rec, beacon.Response{Status: 400, Body: "invalid request", Headers: []beacon.Header{{Name: "etag", Value: `"e"`}}})
	if _, ok := rec.Header()["Content-Type"]; ok && rec.Header().Get("Content-Type") != "" {
		t.Fatalf("content-type %q", rec.Header().Get("Content-Type"))
	}
	if rec.Header().Get("ETag") != `"e"` || rec.Body.String() != "invalid request" {
		t.Fatalf("%v %q", rec.Header(), rec.Body.String())
	}
	// Through a real server: net/http would sniff text/plain for this body.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteResponse(w, beacon.Response{Status: 400, Body: "invalid request"})
	}))
	defer srv.Close()
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL, nil)
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if ct := res.Header.Get("Content-Type"); ct != "" {
		t.Fatalf("sniffed content-type %q", ct)
	}
}

// The shadow endpoint: 202 then a background compare; its verdict is counted and nothing is written.
func TestShadowEndpoint(t *testing.T) {
	var fx *golden.Fixture
	for _, f := range golden.LoadFixtures(t, golden.Dir) {
		if f.Endpoint == beacon.EndpointPulse && f.Name == "anon-basic" {
			fx = &f
		}
	}
	if fx == nil {
		t.Fatal("fixture pulse/anon-basic missing")
	}
	s, w := newServer(t, fx.Engine(), nil)
	mux := InternalMux(s, http.NotFoundHandler())
	post := func(body string) int {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, ShadowPath(beacon.EndpointPulse), strings.NewReader(body)))
		return rec.Code
	}
	if code := post(fx.Shadow); code != http.StatusAccepted {
		t.Fatalf("sample: %d", code)
	}
	if code := post("{"); code != http.StatusBadRequest {
		t.Fatalf("invalid sample: %d", code)
	}
	// A mutated Node row is a mismatch.
	if code := post(strings.Replace(fx.Shadow, `\"entityId\":123`, `\"entityId\":124`, 1)); code != http.StatusAccepted {
		t.Fatalf("mutated sample: %d", code)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if got := testutil.ToFloat64(s.Metrics.ShadowCompare.WithLabelValues("pulse", "match")); got != 1 {
		t.Fatalf("match = %v", got)
	}
	if got := testutil.ToFloat64(s.Metrics.ShadowCompare.WithLabelValues("pulse", "invalid")); got != 1 {
		t.Fatalf("invalid = %v", got)
	}
	if got := testutil.ToFloat64(s.Metrics.ShadowCompare.WithLabelValues("pulse", "mismatch_writes")); got != 1 {
		t.Fatalf("mismatch_writes = %v", got)
	}
	if got := testutil.ToFloat64(s.Metrics.ShadowDiffs.WithLabelValues("pulse", "write:views:entityId")); got != 1 {
		t.Fatalf("diff counter = %v", got)
	}
	if len(w.rows) != 0 {
		t.Fatal("the shadow path wrote a row")
	}
	// After Close, a sample is dropped (and still answered 202).
	if code := post(fx.Shadow); code != http.StatusAccepted {
		t.Fatalf("after close: %d", code)
	}
	if got := testutil.ToFloat64(s.Metrics.ShadowCompare.WithLabelValues("pulse", "dropped")); got != 1 {
		t.Fatalf("dropped = %v", got)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, ShadowPath(beacon.EndpointPing), nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/healthz", nil))
	if rec.Code != 200 || rec.Body.String() != "ok" {
		t.Fatalf("healthz: %d %q", rec.Code, rec.Body.String())
	}
}

func TestShadowQueueFullDrops(t *testing.T) {
	s, _ := newServer(t, &beacon.Engine{Sessions: nilSessions{}}, nil)
	s.ShadowQueue <- struct{}{}
	s.ShadowQueue <- struct{}{}
	rec := httptest.NewRecorder()
	InternalMux(s, http.NotFoundHandler()).ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, ShadowPath(beacon.EndpointPing), bytes.NewReader([]byte("{}"))))
	if rec.Code != http.StatusAccepted || testutil.ToFloat64(s.Metrics.ShadowCompare.WithLabelValues("ping", "dropped")) != 1 {
		t.Fatalf("full queue: %d", rec.Code)
	}
}

func TestDiffFieldIsBounded(t *testing.T) {
	for in, want := range map[string]string{
		"status": "status", "header:vary": "header:vary", "write:views:details": "write:views:details",
		"write:pageViews:order": "write:pageViews:order", "write:views:surprise": "other", "header:x-new": "other",
	} {
		if got := DiffField(in); got != want {
			t.Errorf("DiffField(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReadErrorReporterRateLimitsLogs(t *testing.T) {
	var buf bytes.Buffer
	now := time.Unix(0, 0)
	c := prometheus.NewCounter(prometheus.CounterOpts{Name: "x"})
	f := &ReadErrorReporter{Log: slog.New(slog.NewTextHandler(&buf, nil)), Counter: c, Every: time.Second, Now: func() time.Time { return now }}
	f.Report(io.EOF)
	f.Report(io.EOF)
	now = now.Add(2 * time.Second)
	f.Report(io.EOF)
	if testutil.ToFloat64(c) != 3 || strings.Count(buf.String(), "revocation read failed; requests fall back") != 2 || !strings.Contains(buf.String(), "suppressed=1") {
		t.Fatalf("counter %v, log:\n%s", testutil.ToFloat64(c), buf.String())
	}
}

func TestListeners(t *testing.T) {
	p := PublicHTTPServer(":1", http.NotFoundHandler())
	i := InternalHTTPServer(":2", http.NotFoundHandler())
	if p.ReadHeaderTimeout != ReadHeaderTimeout || p.MaxHeaderBytes != MaxHeaderBytes || p.WriteTimeout != PublicWriteTimeout || i.ReadTimeout != InternalReadTimeout {
		t.Fatal("listener limits")
	}
}

// The send-duration histogram is seeded for both tables (a "none sent" table reads as a zero count,
// not an absent series) and the queue-depth gauge reads its source at each collection.
func TestTrackerSendAndQueueMetrics(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	depth := 7
	reg.MustRegister(TrackerQueueDepth(func() int { return depth }))
	m.TrackerSendSeconds.WithLabelValues(beacon.TableViews).Observe(0.003)
	const want = `
# HELP beacon_go_tracker_queue_depth Rows waiting in the tracker queue (serve mode only); a full queue drops the row (beacon_go_tracker_writes_total{result="dropped"}).
# TYPE beacon_go_tracker_queue_depth gauge
beacon_go_tracker_queue_depth 7
`
	if err := testutil.GatherAndCompare(reg, strings.NewReader(want), "beacon_go_tracker_queue_depth"); err != nil {
		t.Fatal(err)
	}
	depth = 2
	if got := testutil.ToFloat64(TrackerQueueDepth(func() int { return depth })); got != 2 {
		t.Fatalf("queue depth %v, want 2", got)
	}
	if n := testutil.CollectAndCount(m.TrackerSendSeconds); n != 2 {
		t.Fatalf("%d send-duration series, want one per table", n)
	}
	counts := map[string]uint64{}
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "beacon_go_tracker_send_seconds" {
			continue
		}
		for _, s := range mf.GetMetric() {
			counts[s.GetLabel()[0].GetValue()] = s.GetHistogram().GetSampleCount()
		}
	}
	if len(counts) != 2 || counts[beacon.TableViews] != 1 || counts[beacon.TablePageViews] != 0 {
		t.Fatalf("send-duration sample counts %v, want views 1 and pageViews 0", counts)
	}
}
