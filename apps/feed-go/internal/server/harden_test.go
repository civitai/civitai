package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// servedPayload is the page served() answers.
const servedPayload = `{"json":{"items":[]}}`

// served is a computeFn that answers at once with servedPayload.
func served(ttl *trpc.CacheTTL) func(context.Context, *http.Request) (*computed, error) {
	return func(context.Context, *http.Request) (*computed, error) {
		return &computed{payload: []byte(servedPayload), ttl: ttl}, nil
	}
}

type proxyRecorder struct {
	mu    sync.Mutex
	calls int
	ctxOK bool
}

func (p *proxyRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	p.calls++
	p.ctxOK = r.Context().Err() == nil
	p.mu.Unlock()
	w.WriteHeader(http.StatusTeapot) // marks the answer as the proxy's
}

// getURL is Client.Get with an explicit context (the background one Get uses).
func getURL(c *http.Client, target string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	return c.Do(req)
}

func publicRequest() *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+Procedure+"?input=%7B%7D", nil)
	r.Header.Set("Origin", "https://site.example")
	return r
}

func serveServer(reg *prometheus.Registry, fn func(context.Context, *http.Request) (*computed, error), fb http.Handler) *Server {
	return &Server{
		Metrics:        NewMetrics(reg),
		Log:            quietLog(),
		AllowedOrigins: allowed,
		Fallback:       fb,
		computeFn:      fn,
		RequestBudget:  50 * time.Millisecond,
	}
}

// requests reads feed_go_requests_total{feed_endpoint="as-posts",mode="serve",outcome=<outcome>}.
func requests(t *testing.T, reg *prometheus.Registry, outcome string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_requests_total", map[string]string{"feed_endpoint": EndpointAsPosts, "mode": "serve", "outcome": outcome})
	return v
}

func TestServeHTTPServedPath(t *testing.T) {
	reg := prometheus.NewRegistry()
	fb := &proxyRecorder{}
	s := serveServer(reg, served(&trpc.SignedOutTTL), fb)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != 200 || fb.calls != 0 {
		t.Fatalf("code=%d proxied=%d, want 200 and 0", w.Code, fb.calls)
	}
	if got := w.Body.String(); got != `{"result":{"data":{"json":{"items":[]}}}}` {
		t.Fatalf("body = %s", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "public, max-age=60, s-maxage=60, stale-while-revalidate=30" {
		t.Fatalf("Cache-Control = %q", got)
	}
	// tRPC's resolveResponse sets this Vary on every answer; a served one must carry it too.
	if got := w.Header().Values("Vary"); len(got) != 1 || got[0] != "trpc-accept, accept" {
		t.Fatalf("Vary = %q, want [\"trpc-accept, accept\"]", got)
	}
	if requests(t, reg, "served") != 1 {
		t.Fatal("served request not counted")
	}
	// Signed in (no TTL): private.
	s.computeFn = served(nil)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if got := w.Header().Get("Cache-Control"); got != "max-age=0, private, no-cache" {
		t.Fatalf("signed-in Cache-Control = %q", got)
	}
	if got := w.Header().Values("Vary"); len(got) != 1 || got[0] != "trpc-accept, accept" {
		t.Fatalf("signed-in Vary = %q, want [\"trpc-accept, accept\"]", got)
	}
}

func TestServeHTTPErrorFallsBack(t *testing.T) {
	reg := prometheus.NewRegistry()
	fb := &proxyRecorder{}
	s := serveServer(reg, func(context.Context, *http.Request) (*computed, error) {
		return nil, errors.New("replica on fire")
	}, fb)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != http.StatusTeapot || fb.calls != 1 {
		t.Fatalf("code=%d proxied=%d, want the proxy's 418 and 1", w.Code, fb.calls)
	}
	// A proxied answer carries the app's own headers only: nothing is added here (the recorder proxy
	// sets no Vary, so any Vary on the response would be this service's).
	if got := w.Header().Values("Vary"); len(got) != 0 {
		t.Fatalf("a proxied answer got Vary %q from this service", got)
	}
	if fallbackCount(t, reg, "error") != 1 || requests(t, reg, "error") != 1 {
		t.Fatalf("error fallback not recorded: reason=%v outcome=%v", fallbackCount(t, reg, "error"), requests(t, reg, "error"))
	}
}

func TestServeHTTPWithoutFallbackIs503(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := serveServer(reg, func(context.Context, *http.Request) (*computed, error) {
		return nil, errors.New("replica on fire")
	}, nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", w.Code)
	}
	// tRPC sets the same Vary on an error answer as on a result.
	if got := w.Header().Values("Vary"); len(got) != 1 || got[0] != "trpc-accept, accept" {
		t.Fatalf("503 Vary = %q, want [\"trpc-accept, accept\"]", got)
	}
	// tRPC's error envelope: the superjson-wrapped error shape.
	var body struct {
		Error struct {
			JSON struct {
				Message string `json:"message"`
				Data    struct {
					Code       string `json:"code"`
					HTTPStatus int    `json:"httpStatus"`
				} `json:"data"`
			} `json:"json"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Error.JSON.Message != "unavailable" ||
		body.Error.JSON.Data.Code != "INTERNAL_SERVER_ERROR" || body.Error.JSON.Data.HTTPStatus != 503 {
		t.Fatalf("body = %s (%v), want the tRPC INTERNAL_SERVER_ERROR envelope", w.Body.String(), err)
	}
}

// A compute still running when the budget ends is the `deadline` fallback, even when it then returns a
// value (a store read that failed open on the expired context could otherwise yield a partial page).
// The proxy gets the original request, whose context is still live.
func TestServeHTTPDeadlineIsAFallbackNeverAPartialAnswer(t *testing.T) {
	reg := prometheus.NewRegistry()
	fb := &proxyRecorder{}
	var sawDeadline atomic.Bool
	s := serveServer(reg, func(ctx context.Context, _ *http.Request) (*computed, error) {
		<-ctx.Done()
		sawDeadline.Store(true)
		return &computed{payload: []byte(`{"json":{"items":["partial"]}}`)}, nil
	}, fb)
	start := time.Now()
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if el := time.Since(start); el > time.Second {
		t.Fatalf("took %v with a 50 ms budget", el)
	}
	if !sawDeadline.Load() || w.Code != http.StatusTeapot || fb.calls != 1 || !fb.ctxOK {
		t.Fatalf("deadline: sawDeadline=%v code=%d proxied=%d proxyCtxLive=%v, want true 418 1 true",
			sawDeadline.Load(), w.Code, fb.calls, fb.ctxOK)
	}
	if strings.Contains(w.Body.String(), "partial") {
		t.Fatal("a partial answer was written")
	}
	if fallbackCount(t, reg, "deadline") != 1 {
		t.Fatalf("deadline fallbacks = %v, want 1", fallbackCount(t, reg, "deadline"))
	}
	// Without a fallback the deadline is a 503, never the partial page.
	s.Fallback = nil
	w = httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "partial") {
		t.Fatalf("no fallback: code=%d body=%s", w.Code, w.Body.String())
	}
}

func TestDefaultRequestBudget(t *testing.T) {
	if DefaultRequestBudget != 6*time.Second {
		t.Fatalf("DefaultRequestBudget = %v, want 6s", DefaultRequestBudget)
	}
	var seen time.Duration
	s := &Server{Metrics: NewMetrics(prometheus.NewRegistry()), Log: quietLog(), AllowedOrigins: allowed,
		computeFn: func(ctx context.Context, _ *http.Request) (*computed, error) {
			dl, _ := ctx.Deadline()
			seen = time.Until(dl)
			return &computed{payload: []byte(`{}`)}, nil
		}}
	s.ServeHTTP(httptest.NewRecorder(), publicRequest())
	if seen <= 5*time.Second || seen > 6*time.Second {
		t.Fatalf("unset budget gave a %v deadline, want ~6s", seen)
	}
}

// A client that went away is not counted as a deadline.
func TestServeHTTPCanceledClient(t *testing.T) {
	reg := prometheus.NewRegistry()
	fb := &proxyRecorder{}
	ctx, cancel := context.WithCancel(context.Background())
	s := serveServer(reg, func(c context.Context, _ *http.Request) (*computed, error) {
		cancel()
		<-c.Done()
		return nil, c.Err()
	}, fb)
	s.ServeHTTP(httptest.NewRecorder(), publicRequest().WithContext(ctx))
	if fallbackCount(t, reg, "canceled") != 1 || fallbackCount(t, reg, "deadline") != 0 {
		t.Fatalf("canceled=%v deadline=%v, want 1 and 0", fallbackCount(t, reg, "canceled"), fallbackCount(t, reg, "deadline"))
	}
	// The client has gone: nothing is proxied to the Node app.
	if fb.calls != 0 {
		t.Fatalf("a canceled request was proxied %d times, want 0", fb.calls)
	}
}

func panics(t *testing.T, reg *prometheus.Registry, where string) float64 {
	t.Helper()
	v, found := metricValue(t, reg, "feed_go_panics_total", map[string]string{"where": where})
	if !found {
		t.Fatalf("feed_go_panics_total{where=%q} is not exported", where)
	}
	return v
}

func TestServeHTTPPanicFallsBack(t *testing.T) {
	reg := prometheus.NewRegistry()
	fb := &proxyRecorder{}
	var logs bytes.Buffer
	s := serveServer(reg, func(context.Context, *http.Request) (*computed, error) {
		var m map[string]int
		m["x"] = 1 //nolint:govet,staticcheck // nilness, SA5000: the nil-map write is deliberate, the test needs a runtime panic
		return nil, nil
	}, fb)
	s.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if w.Code != http.StatusTeapot || fb.calls != 1 {
		t.Fatalf("code=%d proxied=%d, want the proxy's answer", w.Code, fb.calls)
	}
	if panics(t, reg, "serve") != 1 || panics(t, reg, "shadow") != 0 || fallbackCount(t, reg, "panic") != 1 {
		t.Fatalf("panics serve=%v shadow=%v fallback=%v, want 1 0 1", panics(t, reg, "serve"), panics(t, reg, "shadow"), fallbackCount(t, reg, "panic"))
	}
	if !strings.Contains(logs.String(), `"msg":"recovered panic"`) || !strings.Contains(logs.String(), "assignment to entry in nil map") {
		t.Fatalf("panic log line missing: %s", logs.String())
	}
}

func shadowResult(t *testing.T, reg *prometheus.Registry, result string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": result})
	return v
}

func shadowFallback(t *testing.T, reg *prometheus.Registry, reason string) float64 {
	t.Helper()
	v, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointAsPosts, "mode": "shadow", "reason": reason})
	return v
}

// A panic in a shadow sample, inside compute or after it (here: compare dereferencing a nil answer),
// is counted and logged, the queue slot is released, and the process carries on.
func TestShadowPanicIsRecoveredAndReleasesTheSlot(t *testing.T) {
	reg := prometheus.NewRegistry()
	var calls atomic.Int32
	s := newPhaseServer(reg, 1, func(context.Context, *http.Request) (*computed, error) {
		if calls.Add(1) == 1 {
			return nil, nil // compare reads c.trivial: a nil-pointer panic outside compute
		}
		panic("compute exploded")
	})
	post(t, s, "{}")
	waitFor(t, "the panicking sample to be recovered", func() bool {
		v, _ := metricValue(t, reg, "feed_go_panics_total", map[string]string{"where": "shadow"})
		return v == 1 && len(s.ShadowQueue) == 0
	})
	// The one worker slot is free again: the next sample (inside compute this time) runs too.
	post(t, s, "{}")
	waitFor(t, "the compute panic", func() bool {
		return shadowFallback(t, reg, "panic") == 1 && len(s.ShadowQueue) == 0
	})
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if panics(t, reg, "shadow") != 2 || panics(t, reg, "serve") != 0 {
		t.Fatalf("panics shadow=%v serve=%v, want 2 and 0", panics(t, reg, "shadow"), panics(t, reg, "serve"))
	}
}

func TestShadowComputeRunsUnderTheBudget(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := newPhaseServer(reg, 1, func(ctx context.Context, _ *http.Request) (*computed, error) {
		<-ctx.Done()
		return &computed{payload: []byte(nodeEnvelope)}, nil
	})
	s.RequestBudget = 30 * time.Millisecond
	post(t, s, "{}")
	waitFor(t, "the deadline", func() bool { return shadowFallback(t, reg, "deadline") == 1 && len(s.ShadowQueue) == 0 })
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Its own result, not `unsupported`, so the share the budget excludes stays visible.
	if shadowResult(t, reg, "deadline") != 1 || shadowResult(t, reg, "unsupported") != 0 || shadowResult(t, reg, "match") != 0 {
		t.Fatalf("deadline=%v unsupported=%v match=%v, want 1 0 0: a timed-out compute is counted as deadline and never compared",
			shadowResult(t, reg, "deadline"), shadowResult(t, reg, "unsupported"), shadowResult(t, reg, "match"))
	}
}

// The deadline result is exported at 0 for every endpoint before any sample.
func TestShadowDeadlineResultIsSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	for _, e := range []string{"as-posts", "v1-images", "infinite", "model-getall"} {
		v, found := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": e, "result": "deadline"})
		if !found || v != 0 {
			t.Fatalf("feed_go_shadow_compare_total{feed_endpoint=%q,result=\"deadline\"} = %v (found %v), want a seeded 0", e, v, found)
		}
	}
}

// A deadline the parent carries that ends before the budget (a shadow sample's own bound, below a
// budget configured above it) is still the `deadline` fallback, not `canceled`.
func TestComputeWithinParentDeadlineIsADeadline(t *testing.T) {
	s := &Server{Metrics: NewMetrics(prometheus.NewRegistry()), Log: quietLog(), RequestBudget: time.Minute}
	parent, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := s.computeWithin(parent, publicRequest(), "shadow", func(ctx context.Context, _ *http.Request) (*computed, error) {
		<-ctx.Done()
		return &computed{payload: []byte(`{}`)}, nil
	})
	if got := fallback.Reason(err); got != "deadline" {
		t.Fatalf("reason = %q (%v), want deadline", got, err)
	}
	// Control: a cancelled parent is `canceled`.
	parent2, cancel2 := context.WithCancel(context.Background())
	_, err = s.computeWithin(parent2, publicRequest(), "shadow", func(ctx context.Context, _ *http.Request) (*computed, error) {
		cancel2()
		<-ctx.Done()
		return nil, ctx.Err()
	})
	if got := fallback.Reason(err); got != "canceled" {
		t.Fatalf("cancelled parent: reason = %q, want canceled", got)
	}
}

// Every computation runs under one write-back budget (hydrate.WithWriteBudget), so its
// cache writes share one bound however many caches it fills; the probe and shadow paths go through
// within too. Fails on: within not installing it (each write would take its own bound).
func TestWithinInstallsOneWriteBudget(t *testing.T) {
	s := &Server{Metrics: NewMetrics(prometheus.NewRegistry()), Log: quietLog(), RequestBudget: time.Minute}
	var marked bool
	_, err := s.computeWithin(context.Background(), publicRequest(), "serve", func(ctx context.Context, _ *http.Request) (*computed, error) {
		marked = hydrate.WithWriteBudget(ctx) == ctx
		return &computed{payload: []byte(`{}`)}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !marked {
		t.Fatal("the computation's context carries no write-back budget")
	}
}

// Served computes are the site's traffic; shadow computes are marked so the feed service tells them
// apart (feedsvc.IsShadow drives the request-source headers).
func TestShadowModeReachesTheFeedClientOnlyFromTheShadowPath(t *testing.T) {
	reg := prometheus.NewRegistry()
	var servedShadow, sampleShadow atomic.Int32
	s := serveServer(reg, func(ctx context.Context, _ *http.Request) (*computed, error) {
		if feedsvc.IsShadow(ctx) {
			servedShadow.Store(1)
		} else {
			servedShadow.Store(2)
		}
		return &computed{payload: []byte(nodeEnvelope)}, nil
	}, &proxyRecorder{})
	s.ServeHTTP(httptest.NewRecorder(), publicRequest())
	s.ShadowQueue = make(chan struct{}, 1)
	s.computeFn = func(ctx context.Context, _ *http.Request) (*computed, error) {
		if feedsvc.IsShadow(ctx) {
			sampleShadow.Store(1)
		} else {
			sampleShadow.Store(2)
		}
		return &computed{payload: []byte(nodeEnvelope)}, nil
	}
	s.RequestBudget = time.Second
	post(t, s, "{}")
	waitFor(t, "the sample", func() bool { return shadowResult(t, reg, "match") == 1 && len(s.ShadowQueue) == 0 })
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if servedShadow.Load() != 2 || sampleShadow.Load() != 1 {
		t.Fatalf("served marked=%v sample marked=%v, want unmarked (2) and marked (1)", servedShadow.Load(), sampleShadow.Load())
	}
}

// Close cancels running samples, waits for them, and drops samples posted after it began.
func TestCloseCancelsAndDrainsShadowSamples(t *testing.T) {
	reg := prometheus.NewRegistry()
	started := make(chan struct{})
	var canceled atomic.Bool
	s := newPhaseServer(reg, 2, func(ctx context.Context, _ *http.Request) (*computed, error) {
		close(started)
		<-ctx.Done()
		canceled.Store(errors.Is(ctx.Err(), context.Canceled))
		return nil, ctx.Err()
	})
	s.RequestBudget = time.Minute
	post(t, s, "{}")
	<-started
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	t0 := time.Now()
	if err := s.Close(closeCtx); err != nil {
		t.Fatalf("Close = %v, want the sample drained", err)
	}
	if !canceled.Load() || len(s.ShadowQueue) != 0 || time.Since(t0) > 2*time.Second {
		t.Fatalf("canceled=%v queued=%d took=%v", canceled.Load(), len(s.ShadowQueue), time.Since(t0))
	}
	if shadowFallback(t, reg, "canceled") != 1 {
		t.Fatalf("canceled sample recorded as %v canceled fallbacks, want 1", shadowFallback(t, reg, "canceled"))
	}
	// After Close: dropped, never computed.
	s.computeFn = func(context.Context, *http.Request) (*computed, error) {
		t.Error("a sample posted after Close was computed")
		return nil, nil
	}
	post(t, s, "{}")
	if v, _ := metricValue(t, reg, "feed_go_shadow_dropped_total", map[string]string{"feed_endpoint": EndpointAsPosts}); v != 1 {
		t.Fatalf("dropped after close = %v, want 1", v)
	}
}

// A sample that ignores cancellation holds Close only until the grace period ends.
func TestCloseGivesUpAtTheGracePeriod(t *testing.T) {
	reg := prometheus.NewRegistry()
	release := make(chan struct{})
	started := make(chan struct{})
	s := newPhaseServer(reg, 1, func(context.Context, *http.Request) (*computed, error) {
		close(started)
		<-release
		return nil, errors.New("late")
	})
	post(t, s, "{}")
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := s.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close = %v, want the grace period's deadline", err)
	}
	close(release)
	if err := s.Close(context.Background()); err != nil {
		t.Fatalf("second Close = %v, want nil once the sample returned", err)
	}
}

func TestSyntheticRequest(t *testing.T) {
	input := `{"json":{"modelVersionId":9,"cursor":"feed:1:2"},"meta":{"values":{}}}`
	r, err := SyntheticRequest(context.Background(), ShadowRequest{
		Input: input,
		Headers: map[string]string{
			"host": "red.example", "cookie": "a=1; b=2", "cf-ipcountry": "GB", "x-civitai-verified-bot": "1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.Method != http.MethodGet || r.URL.Path != "/api/trpc/"+Procedure || r.Host != "red.example" {
		t.Fatalf("request = %s %s host %s", r.Method, r.URL.Path, r.Host)
	}
	if r.URL.RawQuery != "input="+url.QueryEscape(input) || r.URL.Query().Get("input") != input {
		t.Fatalf("query = %q", r.URL.RawQuery)
	}
	for k, want := range map[string]string{"Cookie": "a=1; b=2", "Cf-Ipcountry": "GB", "X-Civitai-Verified-Bot": "1", "Host": "red.example"} {
		if got := r.Header.Get(k); got != want {
			t.Errorf("header %s = %q, want %q", k, got, want)
		}
	}
	// No host header: the request keeps net/http's default host, and no stray headers appear.
	r, err = SyntheticRequest(context.Background(), ShadowRequest{Input: "{}"})
	if err != nil || len(r.Header) != 0 || r.Host != "" {
		t.Fatalf("bare sample: host=%q headers=%v err=%v", r.Host, r.Header, err)
	}
}

func TestHTTPServerLimits(t *testing.T) {
	h := http.NotFoundHandler()
	p := PublicHTTPServer(":1", h, 6*time.Second)
	if p.Addr != ":1" || p.ReadHeaderTimeout != 5*time.Second || p.ReadTimeout != 10*time.Second ||
		p.WriteTimeout != 66*time.Second || p.IdleTimeout != 120*time.Second || p.MaxHeaderBytes != 65536 {
		t.Fatalf("public = rh %v r %v w %v idle %v hdr %d", p.ReadHeaderTimeout, p.ReadTimeout, p.WriteTimeout, p.IdleTimeout, p.MaxHeaderBytes)
	}
	if got := PublicHTTPServer(":1", h, 2*time.Second).WriteTimeout; got != 62*time.Second {
		t.Fatalf("public write timeout follows the budget: %v, want 62s", got)
	}
	if got := PublicHTTPServer(":1", h, 0).WriteTimeout; got != 66*time.Second {
		t.Fatalf("public write timeout with the default budget: %v, want 66s", got)
	}
	i := InternalHTTPServer(":2", h)
	if i.Addr != ":2" || i.ReadHeaderTimeout != 5*time.Second || i.ReadTimeout != 60*time.Second ||
		i.WriteTimeout != 30*time.Second || i.IdleTimeout != 120*time.Second || i.MaxHeaderBytes != 65536 {
		t.Fatalf("internal = rh %v r %v w %v idle %v hdr %d", i.ReadHeaderTimeout, i.ReadTimeout, i.WriteTimeout, i.IdleTimeout, i.MaxHeaderBytes)
	}
}

// A pprof capture longer than the internal write timeout still completes: net/http/pprof extends its
// own write deadline by the capture length (what InternalWriteTimeout's comment relies on). The
// server here is the internal one with its write timeout shortened below the capture.
func TestPprofCaptureOutlivesTheInternalWriteTimeout(t *testing.T) {
	ts := httptest.NewUnstartedServer(nil)
	ts.Config = InternalHTTPServer("", InternalMux(muxServer(), okHandler(), true))
	ts.Config.WriteTimeout = 300 * time.Millisecond
	ts.Start()
	defer ts.Close()
	get := func(path string) (int, []byte, time.Duration) {
		t0 := time.Now()
		res, err := getURL(ts.Client(), ts.URL+path)
		if err != nil {
			t.Fatalf("%s: %v (connection cut by the write timeout?)", path, err)
		}
		defer func() { _ = res.Body.Close() }()
		b, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatalf("%s: body: %v (connection cut by the write timeout?)", path, err)
		}
		return res.StatusCode, b, time.Since(t0)
	}
	code, body, took := get("/debug/pprof/profile?seconds=1")
	// A CPU profile is gzipped protobuf: the gzip magic proves a whole profile arrived.
	if code != http.StatusOK || len(body) < 2 || body[0] != 0x1f || body[1] != 0x8b || took < time.Second {
		t.Fatalf("1 s capture under a 300 ms write timeout: code %d, %d bytes, took %v", code, len(body), took)
	}
	// Control: an ordinary handler that writes past the write timeout is cut.
	slow := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(600 * time.Millisecond)
		_, _ = w.Write(bytes.Repeat([]byte("x"), 1<<20))
	}))
	slow.Config.WriteTimeout = 300 * time.Millisecond
	slow.Start()
	defer slow.Close()
	res, err := getURL(slow.Client(), slow.URL)
	if err == nil {
		_, err = io.ReadAll(res.Body)
		_ = res.Body.Close()
	}
	if err == nil {
		t.Fatal("control: a write past WriteTimeout was not cut, so this test cannot see the exemption")
	}
}

func TestRevocationDegradedReporterRateLimitsTheLogNotTheCounter(t *testing.T) {
	var logs bytes.Buffer
	counter := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "x"}, []string{"verdict"})
	now := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	f := &RevocationDegradedReporter{Log: slog.New(slog.NewJSONHandler(&logs, nil)), Counter: counter, Every: 10 * time.Second,
		Now: func() time.Time { return now }}
	for i := 0; i < 5; i++ {
		f.Report(errors.New("sysredis timeout"), "allow_unknown")
	}
	now = now.Add(9 * time.Second)
	f.Report(errors.New("sysredis timeout"), "deny_cached")
	now = now.Add(time.Second) // 10 s after the first line
	f.Report(errors.New("sysredis timeout"), "deny_cached")

	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("%d log lines for 7 failed reads over 10 s, want 2:\n%s", len(lines), logs.String())
	}
	var second struct {
		Msg        string `json:"msg"`
		Suppressed int    `json:"suppressed"`
		Err        string `json:"err"`
		Verdict    string `json:"verdict"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatal(err)
	}
	if second.Msg != "revocation read failed; answered from the markers already read" || second.Suppressed != 5 ||
		second.Err != "sysredis timeout" || second.Verdict != "deny_cached" {
		t.Fatalf("second line = %+v, want 5 suppressed and verdict deny_cached", second)
	}
	reg := prometheus.NewRegistry()
	reg.MustRegister(counter)
	if v, _ := metricValue(t, reg, "x", map[string]string{"verdict": "allow_unknown"}); v != 5 {
		t.Fatalf("allow_unknown = %v, want 5 (every failed read counted)", v)
	}
	if v, _ := metricValue(t, reg, "x", map[string]string{"verdict": "deny_cached"}); v != 2 {
		t.Fatalf("deny_cached = %v, want 2", v)
	}
}

// The cache-miss counter is seeded for every cache and result, and ObserveCacheMiss adds ids.
func TestCacheMissCounter(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	m.ObserveCacheMiss("image-frames", "computed", 3)
	m.ObserveCacheMiss("image-frames", "computed", 2)
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]float64{}
	for _, mf := range mfs {
		if mf.GetName() != "feed_go_cache_miss_total" {
			continue
		}
		for _, metric := range mf.GetMetric() {
			labels := map[string]string{}
			for _, l := range metric.GetLabel() {
				labels[l.GetName()] = l.GetValue()
			}
			got[labels["cache"]+"/"+labels["result"]] = metric.GetCounter().GetValue()
		}
	}
	want := map[string]float64{
		"user-cosmetics/computed": 0, "user-cosmetics/error": 0, "image-frames/computed": 5, "image-frames/error": 0,
		"event-decorations/computed": 0, "event-decorations/error": 0,
		"image-meta/computed": 0, "image-meta/error": 0,
		"tag-ids/computed": 0, "tag-ids/error": 0, "model-frames/computed": 0, "model-frames/error": 0,
		"version-images/computed": 0, "version-images/error": 0,
		"model-decorations/computed": 0, "model-decorations/error": 0,
		"model-data/computed": 0, "model-data/error": 0, "model-tags/computed": 0, "model-tags/error": 0,
		"official-models/computed": 0, "official-models/error": 0,
		"metrics/computed": 0, "metrics/error": 0,
		"image-tags/computed": 0, "image-tags/error": 0,
		"user-follows/computed": 0, "user-follows/error": 0,
		"version-showcase/computed": 0, "version-showcase/error": 0,
		"image-resources/computed": 0, "image-resources/error": 0,
	}
	if len(got) != len(want) {
		t.Fatalf("series %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
}

// The endpoint label is `feed_endpoint` on every per-endpoint family. `endpoint` is a reserved scrape
// target label: the scraper's own value overwrites it, so a query on endpoint="as-posts" would match
// nothing. Each family is touched once so Gather shows its label names.
func TestMetricsEndpointLabelIsFeedEndpoint(t *testing.T) {
	if EndpointLabel != "feed_endpoint" {
		t.Fatalf("EndpointLabel = %q, want feed_endpoint", EndpointLabel)
	}
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	m.Requests.WithLabelValues(EndpointAsPosts, "serve", "served").Inc()
	m.Fallbacks.WithLabelValues(EndpointAsPosts, "serve", "origin").Inc()
	m.Duration.WithLabelValues(EndpointAsPosts, "serve", "served").Observe(1)
	m.ShadowResults.WithLabelValues(EndpointAsPosts, "match").Inc()
	m.ShadowDiffs.WithLabelValues(EndpointAsPosts, "c", "value").Inc()
	m.ShadowPhase.WithLabelValues(EndpointAsPosts, "compute", "served").Observe(1)
	m.ShadowPhaseCPU.WithLabelValues(EndpointAsPosts, "compute", "served").Inc()
	m.ShadowPhaseSolo.WithLabelValues(EndpointAsPosts, "compute", "served").Inc()
	m.ShadowPhaseSoloWall.WithLabelValues(EndpointAsPosts, "compute", "served").Inc()
	m.GoFirstDBReads.WithLabelValues(EndpointAsPosts, "basic-users").Inc()
	m.GoFirstCheckLag.WithLabelValues(EndpointAsPosts).Observe(1)
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	unlabelled := map[string]bool{"feed_go_panics_total": true, "feed_go_revocation_degraded_total": true, "feed_go_jwks_refresh_total": true, "feed_go_jwks_stale_total": true, "feed_go_fallback_proxy_errors_total": true,
		// Sessions are resolved once per request, before any endpoint's compute.
		"feed_go_session_cookie_slot_total": true,
		// Hydration is shared by both endpoints: the cache-miss counter is per cache, not per endpoint.
		"feed_go_cache_miss_total": true}
	checked := 0
	for _, mf := range mfs {
		if !strings.HasPrefix(mf.GetName(), "feed_go_") || unlabelled[mf.GetName()] {
			continue
		}
		checked++
		for _, metric := range mf.GetMetric() {
			has := false
			for _, l := range metric.GetLabel() {
				if l.GetName() == "endpoint" {
					t.Errorf("%s carries the reserved label endpoint", mf.GetName())
				}
				if l.GetName() == "feed_endpoint" {
					has = true
				}
			}
			if !has {
				t.Errorf("%s has no feed_endpoint label", mf.GetName())
			}
		}
	}
	// 22: feed_go_shadow_compare_viewer_total (per-viewer-class body results),
	// feed_go_shadow_response_viewer_total (the tRPC feeds' per-viewer-class header results) and
	// feed_go_devalue_write_total included.
	if checked != 22 {
		t.Fatalf("checked %d per-endpoint families, want 22 (a family was renamed or lost)", checked)
	}
}

// Both fallback proxy error reasons are exported from the start, reading 0.
func TestFallbackProxyErrorsAreSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	for _, reason := range []string{"upstream", "canceled"} {
		v, found := metricValue(t, reg, "feed_go_fallback_proxy_errors_total", map[string]string{"reason": reason})
		if !found || v != 0 {
			t.Errorf("feed_go_fallback_proxy_errors_total{reason=%q} = %v (found %v), want an exported 0", reason, v, found)
		}
	}
}
