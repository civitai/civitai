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
		// On, so the golden track-batch fixtures are served; TestTrackBatchSwitch covers off.
		TrackBatchServe: true,
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
	if n := testutil.CollectAndCount(m.TrackerSendSeconds); n != 4 {
		t.Fatalf("%d send-duration series, want one per table (pageViews, views, search, actions)", n)
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
	if len(counts) != 4 || counts[beacon.TableViews] != 1 || counts[beacon.TablePageViews] != 0 ||
		counts[beacon.TableSearch] != 0 || counts[beacon.TableActions] != 0 {
		t.Fatalf("send-duration sample counts %v, want views 1 and pageViews, search, actions 0", counts)
	}
}

// The public and shadow paths of each endpoint, literally: the Node sampler builds the shadow URL
// from the same routes (beaconGoShadowUrl), and ping / pulse keep the paths they had.
func TestRoutesAndShadowPaths(t *testing.T) {
	want := map[string][2]string{
		"ping":        {"/api/internal/ping", "/internal/shadow/api/internal/ping"},
		"pulse":       {"/api/internal/pulse", "/internal/shadow/api/internal/pulse"},
		"track-batch": {"/api/track/batch", "/internal/shadow/api/track/batch"},
	}
	if len(Endpoints) != len(want) || len(Routes) != len(want) {
		t.Fatalf("endpoints %v, routes %v", Endpoints, Routes)
	}
	for _, e := range Endpoints {
		if got := [2]string{Routes[e], ShadowPath(e)}; got != want[e] {
			t.Errorf("%s: %v, want %v", e, got, want[e])
		}
	}
}

const trackBatchBody = `[{"kind":"search","data":{"query":"q","index":"i"}},{"kind":"action","data":{"type":"AwardBounty_Click"}}]`

func trackBatchRequest(t *testing.T) *http.Request {
	t.Helper()
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/api/track/batch", strings.NewReader(trackBatchBody))
	r.Host = "a.test"
	r.Header.Set("Origin", "https://a.test")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("User-Agent", "ua")
	r.Header.Set("Cf-Connecting-Ip", "192.0.2.1")
	return r
}

// BEACON_GO_TRACK_BATCH_SERVE off (the default): every /api/track/batch request is proxied with its
// whole body, counted as fallback `disabled`, and nothing is computed or written. On: served, and
// its rows queued.
func TestTrackBatchSwitch(t *testing.T) {
	var proxiedBody string
	proxied := 0
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		proxiedBody = string(b)
		proxied++
		w.WriteHeader(200)
	})
	engine := &beacon.Engine{Sessions: nilSessions{}, TrackerEnabled: true}
	s, w := newServer(t, engine, backend)
	s.TrackBatchServe = false
	rec := httptest.NewRecorder()
	PublicMux(s).ServeHTTP(rec, trackBatchRequest(t))
	if rec.Code != 200 || proxied != 1 || proxiedBody != trackBatchBody {
		t.Fatalf("off: %d, proxied %d, body %q", rec.Code, proxied, proxiedBody)
	}
	if len(w.rows) != 0 {
		t.Fatalf("off wrote %d rows", len(w.rows))
	}
	if n := testutil.ToFloat64(s.Metrics.Fallbacks.WithLabelValues("track-batch", "serve", "disabled")); n != 1 {
		t.Fatalf("disabled fallbacks %v", n)
	}
	if n := testutil.ToFloat64(s.Metrics.Requests.WithLabelValues("track-batch", "fallback")); n != 1 {
		t.Fatalf("fallback requests %v", n)
	}
	// Off and no proxy (never in serve mode): 503, nothing written.
	s.Proxy = nil
	rec = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(rec, trackBatchRequest(t))
	if rec.Code != http.StatusServiceUnavailable || len(w.rows) != 0 {
		t.Fatalf("off without a proxy: %d, %d rows", rec.Code, len(w.rows))
	}

	s.Proxy = backend
	s.TrackBatchServe = true
	rec = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(rec, trackBatchRequest(t))
	if rec.Code != 200 || proxied != 1 {
		t.Fatalf("on: %d, proxied %d", rec.Code, proxied)
	}
	want := []beacon.Write{
		{Table: "search", Body: []byte(`{"userId":0,"ip":"192.0.2.1","userAgent":"ua","query":"q","index":"i","filters":""}`)},
		{Table: "actions", Body: []byte(`{"userId":0,"ip":"192.0.2.1","userAgent":"ua","type":"AwardBounty_Click","details":""}`)},
	}
	if len(w.rows) != len(want) {
		t.Fatalf("on: %d rows", len(w.rows))
	}
	for i := range want {
		if w.rows[i].Table != want[i].Table || !bytes.Equal(w.rows[i].Body, want[i].Body) {
			t.Errorf("row %d: %s %s", i, w.rows[i].Table, w.rows[i].Body)
		}
	}
	if n := testutil.ToFloat64(s.Metrics.Requests.WithLabelValues("track-batch", "served")); n != 1 {
		t.Fatalf("served %v", n)
	}
	// A batch with an impression is proxied whole, even when on.
	r := trackBatchRequest(t)
	imp := `[{"kind":"search","data":{"query":"q","index":"i"}},{"kind":"impression","data":{}}]`
	r.Body = io.NopCloser(strings.NewReader(imp))
	rec = httptest.NewRecorder()
	PublicMux(s).ServeHTTP(rec, r)
	if proxied != 2 || proxiedBody != imp || len(w.rows) != 2 {
		t.Fatalf("impression batch: proxied %d body %q rows %d", proxied, proxiedBody, len(w.rows))
	}
	if n := testutil.ToFloat64(s.Metrics.Fallbacks.WithLabelValues("track-batch", "serve", "track-impression")); n != 1 {
		t.Fatalf("track-impression fallbacks %v", n)
	}
}

// A track-batch shadow sample is computed and compared and NEVER written, matching or not, with the
// serve switch on or off; the writer stays untouched.
func TestTrackBatchShadowNeverWrites(t *testing.T) {
	var match, mismatch, impression *golden.Fixture
	for _, f := range golden.LoadFixtures(t, golden.Dir) {
		if f.Endpoint != beacon.EndpointTrackBatch {
			continue
		}
		switch f.Name {
		case "mixed-order":
			match = &f
		case "action-signed-in":
			mismatch = &f
		case "impression-with-search":
			impression = &f
		}
	}
	if match == nil || mismatch == nil || impression == nil {
		t.Fatal("track-batch fixtures missing")
	}
	for _, serveOn := range []bool{false, true} {
		s, w := newServer(t, match.Engine(), nil)
		s.TrackBatchServe = serveOn
		// Room for all three samples at once, so none is dropped for a full queue.
		s.ShadowQueue = make(chan struct{}, 8)
		mux := InternalMux(s, http.NotFoundHandler())
		post := func(body string) {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, ShadowPath(beacon.EndpointTrackBatch), strings.NewReader(body)))
			if rec.Code != http.StatusAccepted {
				t.Fatalf("sample: %d", rec.Code)
			}
		}
		post(match.Shadow)
		// Node's signed-in row against this engine's signed-out session: a userId mismatch.
		post(mismatch.Shadow)
		post(impression.Shadow)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := s.Close(ctx); err != nil {
			t.Fatal(err)
		}
		cancel()
		for result, want := range map[string]float64{"match": 1, "mismatch_writes": 1, "fallback": 1} {
			if got := testutil.ToFloat64(s.Metrics.ShadowCompare.WithLabelValues("track-batch", result)); got != want {
				t.Errorf("serve %v: %s = %v, want %v", serveOn, result, got, want)
			}
		}
		if got := testutil.ToFloat64(s.Metrics.ShadowDiffs.WithLabelValues("track-batch", "write:actions:userId")); got != 1 {
			t.Errorf("serve %v: write:actions:userId = %v", serveOn, got)
		}
		if got := testutil.ToFloat64(s.Metrics.Fallbacks.WithLabelValues("track-batch", "shadow", "track-impression")); got != 1 {
			t.Errorf("serve %v: shadow track-impression = %v", serveOn, got)
		}
		if len(w.rows) != 0 {
			t.Fatalf("serve %v: the shadow path wrote %d rows", serveOn, len(w.rows))
		}
	}
}
