package evalharness

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock advances only when slept on.
type fakeClock struct {
	mu    sync.Mutex
	t     time.Time
	slept time.Duration
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
	c.slept += d
	return nil
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func TestTokenBucketPaces(t *testing.T) {
	clock := &fakeClock{t: testNow}
	b := NewTokenBucket(clock, 3, 3)
	ctx := context.Background()
	// The burst is there at once: one case's three calls.
	if err := b.Wait(ctx, 3); err != nil || clock.slept != 0 {
		t.Fatalf("burst: %v slept %v", err, clock.slept)
	}
	// The next case waits for three tokens at 3/s: one second.
	if err := b.Wait(ctx, 3); err != nil {
		t.Fatal(err)
	}
	if clock.slept < 990*time.Millisecond || clock.slept > 1010*time.Millisecond {
		t.Fatalf("slept %v, want ~1s", clock.slept)
	}
	// Ten more cases: 30 calls at 3/s is ten more seconds, never faster.
	for range 10 {
		if err := b.Wait(ctx, 3); err != nil {
			t.Fatal(err)
		}
	}
	if clock.slept < 10900*time.Millisecond || clock.slept > 11100*time.Millisecond {
		t.Fatalf("slept %v, want ~11s", clock.slept)
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if err := b.Wait(cctx, 3); err == nil {
		t.Fatal("a cancelled wait must fail")
	}
}

func TestWindow(t *testing.T) {
	w, err := ParseWindow("03:00-08:00")
	if err != nil || w != DefaultWindow || w.String() != "03:00-08:00" {
		t.Fatalf("%v %v", w, err)
	}
	at := func(h, m int) time.Time { return time.Date(2026, 11, 26, h, m, 0, 0, time.UTC) }
	for _, c := range []struct {
		t    time.Time
		want bool
	}{{at(2, 59), false}, {at(3, 0), true}, {at(5, 30), true}, {at(7, 59), true}, {at(8, 0), false}, {at(23, 0), false}} {
		if got := w.Contains(c.t); got != c.want {
			t.Errorf("%v: %v", c.t, got)
		}
	}
	// A zone other than UTC is read in UTC.
	if !w.Contains(time.Date(2026, 11, 26, 6, 0, 0, 0, time.FixedZone("x", 2*3600))) {
		t.Error("04:00 UTC given in +02:00")
	}
	wrap, _ := ParseWindow("22:30-01:15")
	if !wrap.Contains(at(23, 0)) || !wrap.Contains(at(1, 0)) || wrap.Contains(at(1, 15)) || wrap.Contains(at(12, 0)) {
		t.Error("wrapping window")
	}
	for _, bad := range []string{"", "03:00", "3-8", "03:00-03:00", "25:00-08:00"} {
		if _, err := ParseWindow(bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}

func TestParseHealthCheck(t *testing.T) {
	c, err := ParseHealthCheck(`load=max(rate(x{a="b;c=d"}[5m]));max=0.75`)
	if err != nil || c.Name != "load" || c.Query != `max(rate(x{a="b;c=d"}[5m]))` || c.Max != 0.75 {
		t.Fatalf("%+v %v", c, err)
	}
	for _, bad := range []string{"load=up", "=up;max=1", "Load=up;max=1", "load=;max=1", "load=up;max=x"} {
		if _, err := ParseHealthCheck(bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}

// fakeProm answers the n-th instant query (from 1) with the sample value value(n) returns ("" = no
// sample).
func fakeProm(t *testing.T, value func(n int64) string) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if r.URL.Path != "/api/v1/query" || r.URL.Query().Get("query") != "q_load" {
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		v := value(n)
		result := "[]"
		if v != "" {
			result = fmt.Sprintf(`[{"metric":{"a":"1"},"value":[1700000000,"0.1"]},{"metric":{"a":"2"},"value":[1700000000,%q]}]`, v)
		}
		_, _ = fmt.Fprintf(w, `{"status":"success","data":{"resultType":"vector","result":%s}}`, result)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func gateRunner(clock *fakeClock, promURL string) *runner {
	return &runner{
		cfg: RunConfig{Clock: clock, Log: io.Discard, Window: DefaultWindow, HealthInterval: 30 * time.Second, MaxPause: 2 * time.Minute,
			MaxDuration: 5 * time.Hour, Health: &Health{PromURL: promURL, Checks: []HealthCheck{{Name: "load", Query: "q_load", Max: 0.9}}}},
		started: clock.Now(),
	}
}

func TestHealthGuardPausesAndResumes(t *testing.T) {
	// Check 1 healthy; 2-4 breached (the larger of the two samples counts); 5 on healthy.
	srv, calls := fakeProm(t, func(n int64) string {
		switch {
		case n == 1:
			return "0.5"
		case n <= 4:
			return "0.95"
		}
		return "0.2"
	})
	clock := &fakeClock{t: testNow}
	r := gateRunner(clock, srv.URL)
	ctx := context.Background()
	if why := r.gate(ctx); why != "" {
		t.Fatalf("healthy: %q", why)
	}
	// Within the interval no new check is made.
	clock.advance(10 * time.Second)
	if why := r.gate(ctx); why != "" || calls.Load() != 1 {
		t.Fatalf("within interval: %q, %d checks", why, calls.Load())
	}
	clock.advance(30 * time.Second)
	before := clock.Now()
	if why := r.gate(ctx); why != "" {
		t.Fatalf("resumed: %q", why)
	}
	// Paused through checks 2, 3 and 4, an interval each; resumed at check 5.
	if paused := clock.Now().Sub(before); paused != 90*time.Second || calls.Load() != 5 {
		t.Fatalf("paused %v over %d checks", paused, calls.Load())
	}
}

func TestHealthGuardAbortsAfterMaxPause(t *testing.T) {
	for _, c := range []struct {
		name  string
		value string
		want  string
	}{
		{"breach", "0.91", "health:load:breach"},
		{"no data", "", "health:load:no-data"},
	} {
		srv, _ := fakeProm(t, func(int64) string { return c.value })
		clock := &fakeClock{t: testNow}
		r := gateRunner(clock, srv.URL)
		start := clock.Now()
		if why := r.gate(context.Background()); why != c.want {
			t.Errorf("%s: %q, want %q", c.name, why, c.want)
		}
		if el := clock.Now().Sub(start); el <= r.cfg.MaxPause || el > r.cfg.MaxPause+r.cfg.HealthInterval {
			t.Errorf("%s: ended after %v", c.name, el)
		}
	}
	// Prometheus unreachable.
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	clock := &fakeClock{t: testNow}
	if why := gateRunner(clock, url).gate(context.Background()); why != "health:load:unreachable" {
		t.Errorf("unreachable: %q", why)
	}
}

func TestGateWindowAndBudget(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 11, 26, 7, 59, 0, 0, time.UTC)}
	r := &runner{cfg: RunConfig{Clock: clock, Window: DefaultWindow, MaxDuration: 5 * time.Hour}, started: clock.Now()}
	if why := r.gate(context.Background()); why != "" {
		t.Fatalf("open: %q", why)
	}
	clock.advance(time.Minute)
	if why := r.gate(context.Background()); why != EndWindow {
		t.Fatalf("closed: %q", why)
	}
	r.cfg.ForceWindow = true
	if why := r.gate(context.Background()); why != "" {
		t.Fatalf("forced: %q", why)
	}
	clock.advance(5 * time.Hour)
	if why := r.gate(context.Background()); why != EndMaxDuration {
		t.Fatalf("duration: %q", why)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if why := r.gate(ctx); why != EndCanceled {
		t.Fatalf("cancelled: %q", why)
	}
}

func TestRunRefusesOutsideWindow(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)}
	cfg := RunConfig{NodeURL: "http://127.0.0.1:1", GoURL: "http://127.0.0.1:2", AllowNoHealth: true, Clock: clock}
	_, err := Run(context.Background(), cfg, nil, &memStore{})
	if err == nil || !strings.Contains(err.Error(), "outside the run window 03:00-08:00 UTC") {
		t.Fatalf("err %v", err)
	}
	cfg.AllowNoHealth = false
	cfg.ForceWindow = true
	if _, err := Run(context.Background(), cfg, nil, &memStore{}); err == nil || !strings.Contains(err.Error(), "no health check") {
		t.Fatalf("no health: %v", err)
	}
}

func TestLoadHealthChecks(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.json")
	if err := os.WriteFile(good, []byte(`[{"name":"load","query":"max(x)","max":0.8},{"name":"errs","query":"sum(y)","max":5}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := LoadHealthChecks(good)
	if err != nil || len(got) != 2 || got[1] != (HealthCheck{Name: "errs", Query: "sum(y)", Max: 5}) {
		t.Fatalf("%+v %v", got, err)
	}
	for name, body := range map[string]string{"not json": `{`, "bad name": `[{"name":"X","query":"q","max":1}]`, "no query": `[{"name":"x","max":1}]`} {
		p := filepath.Join(dir, "bad.json")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadHealthChecks(p); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	if _, err := LoadHealthChecks(filepath.Join(dir, "absent")); err == nil {
		t.Error("absent: no error")
	}
}

func TestHealthCheckReadsScalarsAndRefusesJunk(t *testing.T) {
	answers := map[string]string{
		"/scalar/api/v1/query": `{"status":"success","data":{"resultType":"scalar","result":[1700000000,"0.95"]}}`,
		"/matrix/api/v1/query": `{"status":"success","data":{"resultType":"matrix","result":[]}}`,
		"/error/api/v1/query":  `{"status":"error"}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, ok := answers[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = io.WriteString(w, a)
	}))
	defer srv.Close()
	check := func(base string) (bool, string) {
		h := &Health{PromURL: srv.URL + base, Checks: []HealthCheck{{Name: "load", Query: "q", Max: 0.9}}}
		return h.Check(context.Background())
	}
	if ok, why := check("/scalar"); ok || why != "load:breach" {
		t.Errorf("scalar over max: %v %q", ok, why)
	}
	for _, base := range []string{"/matrix", "/error", "/status"} {
		if ok, why := check(base); ok || why != "load:unreachable" {
			t.Errorf("%s: %v %q", base, ok, why)
		}
	}
}

func TestRealClockSleep(t *testing.T) {
	var c RealClock
	if err := c.Sleep(context.Background(), time.Millisecond); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Sleep(ctx, time.Hour); err == nil {
		t.Fatal("a cancelled sleep must fail")
	}
	if err := c.Sleep(ctx, 0); err == nil {
		t.Fatal("a cancelled zero sleep reports the context")
	}
	if c.Now().IsZero() {
		t.Fatal("now")
	}
}

func TestNewRunID(t *testing.T) {
	id, err := NewRunID(PhaseLive, time.Date(2026, 11, 26, 3, 4, 5, 0, time.FixedZone("x", 3600)))
	if err != nil || !runIDRE.MatchString(id) || !strings.HasPrefix(id, "live-20261126T020405Z-") {
		t.Fatalf("%q %v", id, err)
	}
}
