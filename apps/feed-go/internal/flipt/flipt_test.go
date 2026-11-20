package flipt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"
)

// fakeFlipt answers /evaluate/v1/boolean with the flags it holds (a flag it does not hold is a 404,
// as Flipt answers an unknown key) and records what it was sent.
type fakeFlipt struct {
	mu    sync.Mutex
	flags map[string]bool
	reqs  []seenReq
	code  int // non-zero: answer every request with this status
}

type seenReq struct {
	method, path, auth, env, contentType string
	body                                 map[string]any
}

func (f *fakeFlipt) serve(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.reqs = append(f.reqs, seenReq{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("X-Flipt-Environment"),
			r.Header.Get("Content-Type"), body})
		code, flags := f.code, f.flags
		f.mu.Unlock()
		if code != 0 {
			w.WriteHeader(code)
			return
		}
		key, _ := body["flagKey"].(string)
		on, ok := flags[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":5,"message":"flag not found"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"enabled": on, "reason": "DEFAULT_EVALUATION_REASON", "flagKey": key})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (f *fakeFlipt) setCode(code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.code = code
}

func (f *fakeFlipt) del(key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.flags, key)
}

// setK sets the flag "k", the one the switch tests read.
func (f *fakeFlipt) setK(on bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.flags["k"] = on
}

// The request is the one Node's client would evaluate the flag as: the default namespace, the
// entity id 'global', an empty context, the Flipt environment as a header and the client token as a
// bearer token.
func TestBooleanRequest(t *testing.T) {
	f := &fakeFlipt{flags: map[string]bool{"some-flag": true}}
	srv := f.serve(t)
	c, err := New(Config{URL: srv.URL + "/", ClientToken: "tok-1", Environment: "env-x"})
	if err != nil {
		t.Fatal(err)
	}
	on, err := c.Boolean(context.Background(), "some-flag")
	if err != nil || !on {
		t.Fatalf("Boolean = %v, %v; want true", on, err)
	}
	want := seenReq{http.MethodPost, "/evaluate/v1/boolean", "Bearer tok-1", "env-x", "application/json",
		map[string]any{"namespaceKey": "default", "flagKey": "some-flag", "entityId": "global", "context": map[string]any{}}}
	if len(f.reqs) != 1 || !reflect.DeepEqual(f.reqs[0], want) {
		t.Fatalf("requests %+v, want [%+v]", f.reqs, want)
	}
	// FLIPT_ENVIRONMENT unset is the Node package's default.
	c, _ = New(Config{URL: srv.URL})
	_, _ = c.Boolean(context.Background(), "some-flag")
	if got := f.reqs[1].env; got != "civitai-app" {
		t.Fatalf("default environment %q, want civitai-app", got)
	}
	if got := f.reqs[1].auth; got != "" {
		t.Fatalf("no token: Authorization %q, want none", got)
	}
}

// An unknown flag, a non-200, a body without `enabled`, an unreachable server and a hung one are
// all errors (which a Switch reads as off).
func TestBooleanErrors(t *testing.T) {
	f := &fakeFlipt{flags: map[string]bool{}}
	srv := f.serve(t)
	c, _ := New(Config{URL: srv.URL})
	if on, err := c.Boolean(context.Background(), "unknown"); err == nil || on {
		t.Fatalf("unknown flag = %v, %v; want an error", on, err)
	}
	f.setCode(http.StatusInternalServerError)
	if _, err := c.Boolean(context.Background(), "unknown"); err == nil {
		t.Fatal("500: want an error")
	}
	noField := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"reason":"x"}`)) }))
	t.Cleanup(noField.Close)
	c, _ = New(Config{URL: noField.URL})
	if _, err := c.Boolean(context.Background(), "f"); err == nil {
		t.Fatal("no enabled field: want an error")
	}
	c, _ = New(Config{URL: "http://127.0.0.1:1"})
	if _, err := c.Boolean(context.Background(), "f"); err == nil {
		t.Fatal("unreachable: want an error")
	}
	release := make(chan struct{})
	hung := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(hung.Close)
	t.Cleanup(func() { close(release) })
	c, _ = New(Config{URL: hung.URL, Timeout: 50 * time.Millisecond})
	start := time.Now()
	if _, err := c.Boolean(context.Background(), "f"); err == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("hung server: err %v after %v; want an error within the timeout", err, time.Since(start))
	}
	for _, u := range []string{"", "flipt:8080", "ftp://x", "/relative"} {
		if _, err := New(Config{URL: u}); err == nil {
			t.Errorf("New(%q): want an error", u)
		}
	}
}

// A Switch is off before its first read and follows the flag on every read, both ways. A server
// error keeps the last good value; the flag deleted (Flipt answers 404) reads off.
func TestSwitchFollowsTheFlag(t *testing.T) {
	f := &fakeFlipt{flags: map[string]bool{"k": false}}
	srv := f.serve(t)
	c, _ := New(Config{URL: srv.URL})
	var errs int
	sw := NewSwitch(func(ctx context.Context) (bool, error) { return c.Boolean(ctx, "k") })
	sw.OnError = func(error) { errs++ }
	ctx := context.Background()
	if sw.On() {
		t.Fatal("on before the first read")
	}
	steps := []struct {
		name string
		do   func()
		want bool
	}{
		{"off", func() {}, false},
		{"flipped on", func() { f.setK(true) }, true},
		{"server error keeps the last good value", func() { f.setCode(http.StatusServiceUnavailable) }, true},
		{"recovered", func() { f.setCode(0) }, true},
		{"flag deleted", func() { f.del("k") }, false},
		{"re-created off", func() { f.setK(false) }, false},
		{"on again", func() { f.setK(true) }, true},
		{"flipped off", func() { f.setK(false) }, false},
	}
	for _, s := range steps {
		s.do()
		sw.Refresh(ctx)
		if got := sw.On(); got != s.want {
			t.Fatalf("%s: On %v, want %v", s.name, got, s.want)
		}
	}
	if errs != 2 {
		t.Fatalf("OnError saw %d failures, want 2", errs)
	}
	var nilSwitch *Switch
	if nilSwitch.On() {
		t.Fatal("a nil switch reads on")
	}
}

// A failed read keeps the last value read successfully (Node's client holds its last snapshot when a
// poll fails, errorStrategy FALLBACK): flag ON, then Flipt failing, stays ON.
func TestSwitchKeepsLastGoodOnFailure(t *testing.T) {
	var fail bool
	sw := NewSwitch(func(context.Context) (bool, error) {
		if fail {
			return false, errors.New("flipt: connection refused")
		}
		return true, nil
	})
	sw.Refresh(context.Background())
	fail = true
	sw.Refresh(context.Background())
	if !sw.On() {
		t.Fatal("ON then a failed read: off, want the last good value (on)")
	}
}

// Never read successfully, a failed read reads OFF.
func TestSwitchNeverReadFailureIsOff(t *testing.T) {
	sw := NewSwitch(func(context.Context) (bool, error) { return true, errors.New("flipt: connection refused") })
	sw.Refresh(context.Background())
	if sw.On() {
		t.Fatal("never read + failure: on, want off")
	}
}

// ON, then failures: the last good value holds up to MaxStale (the default, 10 min) and reads OFF past
// it, OnStale told once; a later success clears the outage.
func TestSwitchStalenessBound(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	fail, answer := false, true
	var stale []time.Duration
	sw := NewSwitch(func(context.Context) (bool, error) {
		if fail {
			return false, errors.New("flipt: http 503")
		}
		return answer, nil
	})
	sw.Now = func() time.Time { return now }
	sw.OnStale = func(age time.Duration) { stale = append(stale, age) }
	ctx := context.Background()
	sw.Refresh(ctx)
	fail = true
	for _, step := range []struct {
		at   time.Duration
		want bool
	}{{time.Minute, true}, {DefaultMaxStale, true}, {DefaultMaxStale + time.Second, false}, {DefaultMaxStale + time.Minute, false}} {
		now = time.Unix(1_800_000_000, 0).Add(step.at)
		sw.Refresh(ctx)
		if got := sw.On(); got != step.want {
			t.Fatalf("%v after the last good read: On %v, want %v", step.at, got, step.want)
		}
	}
	if len(stale) != 1 || stale[0] != DefaultMaxStale+time.Second {
		t.Fatalf("OnStale calls %v, want one, at %v", stale, DefaultMaxStale+time.Second)
	}
	fail = false
	sw.Refresh(ctx)
	if !sw.On() {
		t.Fatal("recovered: off, want on")
	}
	fail = true
	now = now.Add(DefaultMaxStale + time.Second)
	sw.Refresh(ctx)
	if sw.On() || len(stale) != 2 {
		t.Fatalf("second outage past the bound: On %v, OnStale calls %d; want off, 2", sw.On(), len(stale))
	}
}

// Run reads at once and then once per tick, until its context ends.
func TestSwitchRunReadsPerTick(t *testing.T) {
	var mu sync.Mutex
	reads, answer := 0, false
	sw := NewSwitch(func(context.Context) (bool, error) {
		mu.Lock()
		defer mu.Unlock()
		reads++
		return answer, nil
	})
	ticks := make(chan time.Time)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { sw.Run(ctx, ticks); close(done) }()
	waitFor := func(n int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			mu.Lock()
			r := reads
			mu.Unlock()
			if r >= n {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%d reads, want %d", r, n)
			}
			time.Sleep(time.Millisecond)
		}
	}
	waitFor(1)
	mu.Lock()
	answer = true
	mu.Unlock()
	ticks <- time.Now()
	// The tick's read has been taken once the next tick is accepted.
	ticks <- time.Now()
	waitFor(3)
	if !sw.On() {
		t.Fatal("off after a tick read on")
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if reads != 3 {
		t.Fatalf("%d reads, want 3 (one at start, one per tick)", reads)
	}
}
