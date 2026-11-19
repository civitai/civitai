package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// pooledAnswer returns a computed whose payload is a pooled superjson buffer, as compute builds it.
// It runs on the request's goroutine, so a failure panics (computeWithin turns that into the `panic`
// fallback, which the callers' body checks then report) rather than calling t.Fatal off the test's own
// goroutine.
func pooledAnswer(items ...any) *computed {
	buf, err := superjson.SerializeBuffer(superjson.Object{{Key: "items", Val: items}})
	if err != nil {
		panic(err)
	}
	return &computed{payload: buf.Bytes(), buf: buf}
}

func released(c *computed) bool { return c.buf == nil && c.payload == nil }

// The served path releases a pooled payload only once WriteResult has sent it.
func TestServeHTTPReleasesThePooledPayloadAfterWriting(t *testing.T) {
	var made *computed
	s := serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
		made = pooledAnswer("a")
		return made, nil
	}, &proxyRecorder{})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if got := w.Body.String(); got != `{"result":{"data":{"json":{"items":["a"]}}}}` {
		t.Fatalf("body = %s", got)
	}
	if !released(made) {
		t.Fatal("the served payload was not released")
	}
}

// An answer computeWithin discards (past the budget) is released, never written.
func TestComputeWithinReleasesADiscardedAnswer(t *testing.T) {
	var made *computed
	s := serveServer(prometheus.NewRegistry(), func(ctx context.Context, _ *http.Request) (*computed, error) {
		<-ctx.Done()
		made = pooledAnswer("late")
		return made, nil
	}, &proxyRecorder{})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, publicRequest())
	if strings.Contains(w.Body.String(), "late") || w.Code != http.StatusTeapot {
		t.Fatalf("code=%d body=%s, want the proxy's 418 and no late answer", w.Code, w.Body.String())
	}
	if made == nil || !released(made) {
		t.Fatal("the discarded answer was not released")
	}
}

// A shadow sample releases its payload once the comparison is done.
func TestShadowCompareReleasesThePayload(t *testing.T) {
	var made *computed
	reg := prometheus.NewRegistry()
	s := serveServer(reg, func(context.Context, *http.Request) (*computed, error) {
		made = pooledAnswer()
		return made, nil
	}, nil)
	s.compare(context.Background(), EndpointAsPosts, ShadowRequest{Input: `{}`, Node: json.RawMessage(`{"json":{"items":[]}}`)})
	if made == nil || !released(made) {
		t.Fatal("the compared payload was not released")
	}
	if v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointAsPosts, "result": "match"}); v != 1 {
		t.Fatalf("shadow match = %v, want 1 (the comparison read the payload before its release)", v)
	}
}

// Concurrent served requests each get their own bytes (run under -race in CI): a payload is released
// after its response is written while other requests reuse the pool.
func TestServeHTTPConcurrentPooledPayloads(t *testing.T) {
	s := serveServer(prometheus.NewRegistry(), func(_ context.Context, r *http.Request) (*computed, error) {
		n, _ := strconv.Atoi(r.Header.Get("x-n"))
		return pooledAnswer(n, strings.Repeat("q", (n*41)%3000)), nil
	}, &proxyRecorder{})
	const requests = 64
	s.MaxInFlight = requests // this test is about pooled payloads, not the bulkhead: admit every request
	bodies := make([]string, requests)
	var wg sync.WaitGroup
	for n := range requests {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := publicRequest()
			r.Header.Set("x-n", strconv.Itoa(n))
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			bodies[n] = w.Body.String()
		}()
	}
	wg.Wait()
	for n, got := range bodies {
		want := `{"result":{"data":{"json":{"items":[` + strconv.Itoa(n) + `,"` + strings.Repeat("q", (n*41)%3000) + `"]}}}}`
		if got != want {
			t.Fatalf("request %d: %.80s…", n, got)
		}
	}
}
