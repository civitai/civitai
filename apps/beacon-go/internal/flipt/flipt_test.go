package flipt

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// The request is the one Node's client would have the server evaluate: the global entity, no
// context, the default namespace, the environment header and the bearer token.
func TestVariantRequestAndAnswers(t *testing.T) {
	var got struct {
		path, env, auth, ctype string
		body                   map[string]any
	}
	status, answer := 200, `{"match":true,"variantKey":"0.25","reason":"MATCH_EVALUATION_REASON"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path, got.env, got.auth, got.ctype = r.URL.Path, r.Header.Get("X-Flipt-Environment"), r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got.body)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, answer)
	}))
	defer srv.Close()
	c, err := New(Config{URL: srv.URL + "/", ClientToken: "tok"})
	if err != nil {
		t.Fatal(err)
	}
	match, key, err := c.Variant(context.Background(), "feed-events-sample-rate")
	if err != nil || !match || key != "0.25" {
		t.Fatalf("match %v key %q err %v", match, key, err)
	}
	if got.path != "/evaluate/v1/variant" || got.env != "civitai-app" || got.auth != "Bearer tok" || got.ctype != "application/json" {
		t.Fatalf("request %+v", got)
	}
	want := map[string]any{"namespaceKey": "default", "flagKey": "feed-events-sample-rate", "entityId": "global", "context": map[string]any{}}
	if b1, b2 := mustJSON(got.body), mustJSON(want); b1 != b2 {
		t.Fatalf("body %s, want %s", b1, b2)
	}

	answer = `{"match":false,"variantKey":""}`
	if match, _, err := c.Variant(context.Background(), "f"); err != nil || match {
		t.Fatalf("no match: %v %v", match, err)
	}
	for _, c2 := range []struct {
		status int
		body   string
		notFnd bool
	}{
		{404, `{}`, true},
		{500, `{}`, false},
		{200, `{"variantKey":"0.1"}`, false},
		{200, `not json`, false},
	} {
		status, answer = c2.status, c2.body
		_, _, err := c.Variant(context.Background(), "f")
		if err == nil || errors.Is(err, ErrFlagNotFound) != c2.notFnd {
			t.Fatalf("status %d body %q: err %v", c2.status, c2.body, err)
		}
	}
	// No token, a named environment.
	c, _ = New(Config{URL: srv.URL, Environment: "staging"})
	status, answer = 200, `{"match":true,"variantKey":"1"}`
	if _, _, err := c.Variant(context.Background(), "f"); err != nil || got.auth != "" || got.env != "staging" {
		t.Fatalf("auth %q env %q err %v", got.auth, got.env, err)
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestNewRejectsABadURL(t *testing.T) {
	for _, u := range []string{"", "flipt:8080", "ftp://x", "http://", "://"} {
		if _, err := New(Config{URL: u}); err == nil {
			t.Errorf("%q accepted", u)
		}
	}
}

func TestVariantTransportError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	srv.Close()
	c, _ := New(Config{URL: srv.URL, Timeout: time.Second})
	if _, _, err := c.Variant(context.Background(), "f"); err == nil {
		t.Fatal("a closed server answered")
	}
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

// No reading before the first success; a success sets the value (no match is 0); a failure keeps the
// last reading for MaxAge and then there is none; a missing flag reads 0.
func TestRate(t *testing.T) {
	var match bool
	var key string
	var err error
	reads, errs := 0, 0
	r := NewRate(func(context.Context) (bool, string, error) { reads++; return match, key, err },
		func(k string) float64 { v, _ := strconv.ParseFloat(k, 64); return v })
	ck := &clock{t: time.Unix(1000, 0)}
	r.Now, r.MaxAge = ck.now, time.Minute
	r.OnError = func(error) { errs++ }

	if _, ok := r.Value(); ok {
		t.Fatal("a reading before any read")
	}
	err = errors.New("down")
	r.Refresh(context.Background())
	if _, ok := r.Value(); ok || errs != 1 {
		t.Fatalf("a failed first read gave a reading (errors %d)", errs)
	}
	match, key, err = true, "0.5", nil
	r.Refresh(context.Background())
	if v, ok := r.Value(); !ok || v != 0.5 {
		t.Fatalf("after a match: %v %v", v, ok)
	}
	err = errors.New("down")
	ck.t = ck.t.Add(time.Minute)
	r.Refresh(context.Background())
	if v, ok := r.Value(); !ok || v != 0.5 {
		t.Fatalf("a failure within MaxAge dropped the reading: %v %v", v, ok)
	}
	ck.t = ck.t.Add(time.Second)
	if _, ok := r.Value(); ok {
		t.Fatal("a reading older than MaxAge is still current")
	}
	match, key, err = false, "0.5", nil
	r.Refresh(context.Background())
	if v, ok := r.Value(); !ok || v != 0 {
		t.Fatalf("no match: %v %v", v, ok)
	}
	match, err = true, ErrFlagNotFound
	r.Refresh(context.Background())
	if v, ok := r.Value(); !ok || v != 0 {
		t.Fatalf("a missing flag: %v %v", v, ok)
	}
	if reads != 5 {
		t.Fatalf("%d reads", reads)
	}
	var nilRate *Rate
	if _, ok := nilRate.Value(); ok {
		t.Fatal("a nil Rate has a reading")
	}
	// The default MaxAge applies when none is set.
	r.MaxAge = 0
	ck.t = ck.t.Add(DefaultMaxAge)
	if _, ok := r.Value(); !ok {
		t.Fatal("a reading exactly DefaultMaxAge old dropped")
	}
	ck.t = ck.t.Add(time.Nanosecond)
	if _, ok := r.Value(); ok {
		t.Fatal("a reading past DefaultMaxAge is current")
	}
}

// Run reads once at start and once per tick, until its context ends.
func TestRateRun(t *testing.T) {
	reads := make(chan struct{}, 4)
	r := NewRate(func(context.Context) (bool, string, error) { reads <- struct{}{}; return true, "0.1", nil },
		func(string) float64 { return 0.1 })
	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time)
	done := make(chan struct{})
	go func() { r.Run(ctx, ticks); close(done) }()
	<-reads
	ticks <- time.Now()
	<-reads
	cancel()
	<-done
	if v, ok := r.Value(); !ok || v != 0.1 {
		t.Fatalf("%v %v", v, ok)
	}
	// Start reads at once in the background.
	r2 := NewRate(func(context.Context) (bool, string, error) { reads <- struct{}{}; return false, "", nil },
		func(string) float64 { return 1 })
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	r2.Start(ctx2)
	select {
	case <-reads:
	case <-time.After(5 * time.Second):
		t.Fatal("Start did not read")
	}
}
