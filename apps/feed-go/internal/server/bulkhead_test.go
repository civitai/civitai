package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/dbpool"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// inFlightGauge reads feed_go_serve_in_flight{feed_endpoint="as-posts"}; found is false when the series
// is not exported.
func inFlightGauge(t *testing.T, reg *prometheus.Registry) (float64, bool) {
	t.Helper()
	return metricValue(t, reg, "feed_go_serve_in_flight", map[string]string{"feed_endpoint": EndpointAsPosts})
}

// With every serve slot held by a compute that has not returned, the next public request is not
// computed: it is the `bulkhead` fallback, proxied to the Node app, and exactly one such fallback is
// counted. Once the held computes return, every slot is free again. An unset cap is the pool
// default (8), never unlimited.
func TestServeBulkheadShedsExactlyTheRequestPastTheCap(t *testing.T) {
	for _, c := range []struct {
		name     string
		max, cap int
	}{
		{"configured cap", 3, 3},
		{"unset cap is the pool default, never unlimited", 0, 8},
	} {
		t.Run(c.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			fb := &proxyRecorder{}
			// Buffered past the cap, so a compute the bulkhead wrongly admitted is seen (len) instead of
			// blocking on the send.
			started := make(chan struct{}, c.cap+1)
			release := make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			t.Cleanup(unblock)
			s := serveServer(reg, func(ctx context.Context, _ *http.Request) (*computed, error) {
				started <- struct{}{}
				select {
				case <-release:
				case <-ctx.Done():
				}
				return &computed{payload: []byte(`{"json":{"items":[]}}`)}, nil
			}, fb)
			// The hold is the release channel, never the budget.
			s.RequestBudget = time.Minute
			s.MaxInFlight = c.max

			var wg sync.WaitGroup
			for range c.cap {
				wg.Add(1)
				go func() {
					defer wg.Done()
					s.ServeHTTP(httptest.NewRecorder(), publicRequest())
				}()
			}
			for i := range c.cap {
				select {
				case <-started:
				case <-time.After(10 * time.Second):
					t.Fatalf("only %d of %d computes started under a cap of %d (in flight %d)", i, c.cap, c.cap, s.InFlight())
				}
			}
			if got := s.InFlight(); got != int64(c.cap) {
				t.Fatalf("in flight with every compute held = %d, want %d", got, c.cap)
			}
			if g, ok := inFlightGauge(t, reg); !ok || g != float64(c.cap) {
				t.Fatalf("feed_go_serve_in_flight = %v (exported %v), want %d", g, ok, c.cap)
			}

			// The request past the cap. Run aside: wrongly admitted, it would block in the fake compute.
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() {
				defer close(done)
				s.ServeHTTP(w, publicRequest())
			}()
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				t.Fatalf("the request past the cap was computed (in flight %d, computes started %d)", s.InFlight(), len(started))
			}
			if len(started) != 0 {
				t.Fatalf("the request past the cap reached compute")
			}
			if w.Code != http.StatusTeapot || fb.calls != 1 {
				t.Fatalf("past the cap: code=%d proxied=%d, want the proxy's 418 and 1", w.Code, fb.calls)
			}
			if n := fallbackCount(t, reg, "bulkhead"); n != 1 {
				t.Fatalf("bulkhead fallbacks = %v, want 1", n)
			}

			unblock()
			wg.Wait()
			if got := s.InFlight(); got != 0 {
				t.Fatalf("in flight after every compute returned = %d, want 0", got)
			}
			if g, _ := inFlightGauge(t, reg); g != 0 {
				t.Fatalf("feed_go_serve_in_flight after every compute returned = %v, want 0", g)
			}
			if n := requests(t, reg, "served"); n != float64(c.cap) {
				t.Fatalf("served = %v, want %d", n, c.cap)
			}
			// The freed slots admit again; the bulkhead count is unchanged.
			w = httptest.NewRecorder()
			s.ServeHTTP(w, publicRequest())
			if w.Code != http.StatusOK || fallbackCount(t, reg, "bulkhead") != 1 || fb.calls != 1 {
				t.Fatalf("after release: code=%d bulkhead=%v proxied=%d, want 200, 1, 1", w.Code, fallbackCount(t, reg, "bulkhead"), fb.calls)
			}
		})
	}
}

// slotProbe is a fallback that records how many serve slots were held while it proxied.
type slotProbe struct {
	s     *Server
	calls int
	held  int64
}

func (p *slotProbe) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	p.calls++
	p.held = p.s.InFlight()
	w.WriteHeader(http.StatusTeapot)
}

// Every way a served computation can end gives its slot back: with a cap of 1, the request after it is
// computed and served, never the `bulkhead` fallback. A proxied fallback runs after the slot is
// released, so a slow Node answer never holds one.
func TestServeBulkheadReleasesOnEveryExit(t *testing.T) {
	cases := []struct {
		name    string
		budget  time.Duration
		compute func(cancel context.CancelFunc) func(context.Context, *http.Request) (*computed, error)
		reason  string // "" = served
		proxied bool
	}{
		{"served", 0, func(context.CancelFunc) func(context.Context, *http.Request) (*computed, error) {
			return served(nil)
		}, "", false},
		{"fallback", 0, func(context.CancelFunc) func(context.Context, *http.Request) (*computed, error) {
			return func(context.Context, *http.Request) (*computed, error) { return nil, fallback.New("method") }
		}, "method", true},
		{"error", 0, func(context.CancelFunc) func(context.Context, *http.Request) (*computed, error) {
			return func(context.Context, *http.Request) (*computed, error) { return nil, errors.New("replica on fire") }
		}, "error", true},
		{"panic", 0, func(context.CancelFunc) func(context.Context, *http.Request) (*computed, error) {
			return func(context.Context, *http.Request) (*computed, error) { panic("boom") }
		}, "panic", true},
		{"deadline", 20 * time.Millisecond, func(context.CancelFunc) func(context.Context, *http.Request) (*computed, error) {
			return func(ctx context.Context, _ *http.Request) (*computed, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			}
		}, "deadline", true},
		{"client canceled", 0, func(cancel context.CancelFunc) func(context.Context, *http.Request) (*computed, error) {
			return func(ctx context.Context, _ *http.Request) (*computed, error) {
				cancel() // the client leaves mid-compute
				<-ctx.Done()
				return nil, ctx.Err()
			}
		}, "canceled", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reg := prometheus.NewRegistry()
			s := serveServer(reg, nil, nil)
			probe := &slotProbe{s: s, held: -1}
			s.Fallback = probe
			s.MaxInFlight = 1
			if c.budget > 0 {
				s.RequestBudget = c.budget
			} else {
				s.RequestBudget = time.Minute
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.computeFn = c.compute(cancel)
			s.ServeHTTP(httptest.NewRecorder(), publicRequest().WithContext(ctx))

			if c.reason == "" {
				if requests(t, reg, "served") != 1 {
					t.Fatal("first request not served")
				}
			} else if n := fallbackCount(t, reg, c.reason); n != 1 {
				t.Fatalf("%s fallbacks = %v, want 1", c.reason, n)
			}
			if (probe.calls == 1) != c.proxied {
				t.Fatalf("proxied %d times, want proxied=%v", probe.calls, c.proxied)
			}
			if c.proxied && probe.held != 0 {
				t.Fatalf("%d serve slot(s) held while the fallback proxied, want 0", probe.held)
			}
			if got := s.InFlight(); got != 0 {
				t.Fatalf("in flight after the %s exit = %d, want 0", c.name, got)
			}
			if g, _ := inFlightGauge(t, reg); g != 0 {
				t.Fatalf("feed_go_serve_in_flight after the %s exit = %v, want 0", c.name, g)
			}

			// The one slot is free: the next request is computed and served.
			s.computeFn = served(nil)
			before := requests(t, reg, "served")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, publicRequest())
			if w.Code != http.StatusOK || requests(t, reg, "served") != before+1 || fallbackCount(t, reg, "bulkhead") != 0 {
				t.Fatalf("after the %s exit: code=%d bulkhead=%v, want 200 and 0", c.name, w.Code, fallbackCount(t, reg, "bulkhead"))
			}
		})
	}
}

// A request the origin check hands to the app never takes a slot: it computes nothing.
func TestServeBulkheadSkipsOriginFallback(t *testing.T) {
	reg := prometheus.NewRegistry()
	var computes atomic.Int32
	s := serveServer(reg, func(context.Context, *http.Request) (*computed, error) {
		computes.Add(1)
		return &computed{payload: []byte(`{}`)}, nil
	}, nil)
	probe := &slotProbe{s: s, held: -1}
	s.Fallback = probe
	s.MaxInFlight = 1
	s.acquireServe() // the pod's one slot is held
	defer s.releaseServe()
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "/api/trpc/"+Procedure, nil)
	s.ServeHTTP(httptest.NewRecorder(), r)
	if fallbackCount(t, reg, "origin") != 1 || fallbackCount(t, reg, "bulkhead") != 0 || computes.Load() != 0 {
		t.Fatalf("origin=%v bulkhead=%v computes=%d, want 1, 0, 0", fallbackCount(t, reg, "origin"), fallbackCount(t, reg, "bulkhead"), computes.Load())
	}
}

// The bulkhead series are exported from the start: the in-flight gauge at 0 and the bulkhead fallback
// at 0, so a pod that never shed reads 0, not an absent series.
func TestServeBulkheadSeriesAreSeeded(t *testing.T) {
	reg := prometheus.NewRegistry()
	NewMetrics(reg)
	if g, ok := inFlightGauge(t, reg); !ok || g != 0 {
		t.Fatalf("feed_go_serve_in_flight = %v (exported %v), want an exported 0", g, ok)
	}
	v, ok := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointAsPosts, "mode": "serve", "reason": "bulkhead"})
	if !ok || v != 0 {
		t.Fatalf("feed_go_fallback_total{reason=bulkhead} = %v (exported %v), want an exported 0", v, ok)
	}
}

// Taking and giving back a slot, and being refused one, allocate nothing: the acquire runs on every
// served request, and the refusal on every request of an overloaded pod.
func TestServeSlotAllocatesNothing(t *testing.T) {
	s := &Server{Metrics: NewMetrics(prometheus.NewRegistry()), MaxInFlight: 1}
	if n := testing.AllocsPerRun(100, func() {
		if !s.acquireServe() {
			t.Fatal("free slot refused")
		}
		s.releaseServe()
	}); n != 0 {
		t.Fatalf("acquire+release allocated %v times, want 0", n)
	}
	if !s.acquireServe() {
		t.Fatal("free slot refused")
	}
	defer s.releaseServe()
	if n := testing.AllocsPerRun(100, func() {
		if s.acquireServe() {
			t.Fatal("a second slot was granted past a cap of 1")
		}
	}); n != 0 {
		t.Fatalf("a refused acquire allocated %v times, want 0", n)
	}
	// The refusal is the bulkhead fallback, before the compute (nil here) is ever called.
	if _, err := s.computeServe(publicRequest(), EndpointAsPosts, nil); fallback.Reason(err) != "bulkhead" {
		t.Fatalf("full pod: %v, want the bulkhead fallback", err)
	}
}

// The serve cap: unset, it is the replica pool's ceiling (whatever that resolved to); an explicit
// value wins, and one above the ceiling is a warning, not a refusal. Both values are logged.
func TestResolveMaxInFlight(t *testing.T) {
	if dbpool.DefaultMaxConns != 8 {
		t.Fatalf("dbpool.DefaultMaxConns = %d, want 8", dbpool.DefaultMaxConns)
	}
	cases := []struct {
		name                   string
		explicit, pool         int
		want                   int
		wantExplicit, wantWarn bool
	}{
		{"unset: the pool default", 0, 8, 8, false, false},
		{"unset: a raised pool", 0, 32, 32, false, false},
		{"unknown pool: the pool default", 0, 0, 8, false, false},
		{"explicit below the pool", 5, 32, 5, true, false},
		{"explicit at the pool", 32, 32, 32, true, false},
		{"explicit above the pool warns", 40, 32, 40, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var buf bytes.Buffer
			got := ResolveMaxInFlight(slog.New(slog.NewJSONHandler(&buf, nil)), c.explicit, c.pool)
			if got != c.want {
				t.Fatalf("cap = %d, want %d", got, c.want)
			}
			var info, warn map[string]any
			dec := json.NewDecoder(&buf)
			for dec.More() {
				var line map[string]any
				if err := dec.Decode(&line); err != nil {
					t.Fatal(err)
				}
				switch line["level"] {
				case "INFO":
					info = line
				case "WARN":
					warn = line
				}
			}
			wantPool := c.pool
			if wantPool <= 0 {
				wantPool = 8
			}
			if info == nil || info["FEED_GO_MAX_IN_FLIGHT"] != float64(c.want) || info["db_max_conns"] != float64(wantPool) || info["explicit"] != c.wantExplicit {
				t.Fatalf("startup line = %v, want cap %d, db_max_conns %d, explicit %v", info, c.want, wantPool, c.wantExplicit)
			}
			if (warn != nil) != c.wantWarn {
				t.Fatalf("warning = %v, want one: %v", warn, c.wantWarn)
			}
		})
	}
}
