package index

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-index-go/internal/api"
	"github.com/civitai/civitai/apps/app-index-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-index-go/internal/registry"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

const testSchema = "urn:schema:apps.civitai.com:app@v1"

// fakeRegistry is an in-process registry serving the HTTP binding. Each subscription is handed
// to the test as a *fakeConn, which the test drives event by event; the response stays open until
// the test drops it or the consumer goes away.
type fakeRegistry struct {
	srv   *httptest.Server
	conns chan *fakeConn
}

// fakeConn's writes run on its handler goroutine (ops), never on the test's: a ResponseWriter
// must not be used once its handler returned, nor from two goroutines at once.
type fakeConn struct {
	cursor  string
	auth    string // the Authorization header the subscription carried
	ops     chan func(w http.ResponseWriter)
	started bool
	done    chan struct{}
	once    sync.Once
	gone    <-chan struct{}
}

// do runs op on the handler goroutine and waits for it; a no-op once the consumer went away.
func (c *fakeConn) do(op func(w http.ResponseWriter)) {
	ran := make(chan struct{})
	select {
	case c.ops <- func(w http.ResponseWriter) { op(w); close(ran) }:
		<-ran
	case <-c.gone:
	case <-c.done:
	}
}

func newFakeRegistry(t *testing.T) *fakeRegistry {
	t.Helper()
	r := &fakeRegistry{conns: make(chan *fakeConn)}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/subscribe" || req.URL.Query().Get("schema") != testSchema {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"bad_request","message":"unexpected request"}`)
			return
		}
		c := &fakeConn{cursor: req.URL.Query().Get("cursor"), auth: req.Header.Get("Authorization"),
			ops: make(chan func(http.ResponseWriter)), done: make(chan struct{}), gone: req.Context().Done()}
		select {
		case r.conns <- c:
		case <-req.Context().Done():
			return
		}
		for {
			select {
			case op := <-c.ops:
				op(w)
			case <-c.done:
				return
			case <-req.Context().Done():
				return
			}
		}
	}))
	t.Cleanup(r.srv.Close)
	return r
}

// next is the consumer's next subscription.
func (r *fakeRegistry) next(t *testing.T) *fakeConn {
	t.Helper()
	select {
	case c := <-r.conns:
		return c
	case <-time.After(10 * time.Second):
		t.Fatal("the consumer did not subscribe")
		return nil
	}
}

func (c *fakeConn) send(t *testing.T, event string, data any) {
	t.Helper()
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	c.do(func(w http.ResponseWriter) {
		if !c.started {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			c.started = true
		}
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		w.(http.Flusher).Flush()
	})
}

// raw writes SSE text as is: for events no well-formed registry sends.
func (c *fakeConn) raw(sse string) {
	c.do(func(w http.ResponseWriter) {
		if !c.started {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			c.started = true
		}
		_, _ = io.WriteString(w, sse)
		w.(http.Flusher).Flush()
	})
}

func appEntity(slug, name string) map[string]any {
	return map[string]any{
		"urn":     "urn:apps.civitai.com:app/" + slug,
		"schemas": []string{testSchema},
		"rev":     "rev-" + name,
		"body": map[string]any{"slug": slug, "name": name, "kind": "onsite", "contentRating": "g",
			"tagline": "the " + name + " app", "category": "generation", "iconUrl": nil, "creator": "maker"},
	}
}

func (c *fakeConn) upsert(t *testing.T, slug, name, cursor string) {
	t.Helper()
	c.send(t, "upsert", map[string]any{"entity": appEntity(slug, name), "cursor": cursor})
}

func (c *fakeConn) upsertBody(t *testing.T, slug string, body any, cursor string) {
	t.Helper()
	e := appEntity(slug, slug)
	e["body"] = body
	c.send(t, "upsert", map[string]any{"entity": e, "cursor": cursor})
}

func (c *fakeConn) del(t *testing.T, slug, cursor string) {
	t.Helper()
	c.send(t, "delete", map[string]any{"urn": "urn:apps.civitai.com:app/" + slug, "cursor": cursor})
}

func (c *fakeConn) live(t *testing.T, cursor string) {
	t.Helper()
	c.send(t, "live", map[string]any{"cursor": cursor})
}

func (c *fakeConn) progress(t *testing.T, cursor string) {
	t.Helper()
	c.send(t, "progress", map[string]any{"cursor": cursor})
}

func (c *fakeConn) end(t *testing.T) {
	t.Helper()
	c.send(t, "end", map[string]any{})
	c.drop()
}

// errorEvent ends a started stream with a named error.
func (c *fakeConn) errorEvent(t *testing.T, code string) {
	t.Helper()
	c.send(t, "error", map[string]any{"error": code, "message": code})
	c.drop()
}

// fail answers before the stream starts: an HTTP status with the JSON error body.
func (c *fakeConn) fail(status int, code string) {
	c.do(func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = fmt.Fprintf(w, `{"error":%q,"message":"test"}`, code)
	})
	c.drop()
}

// drop closes the response without End: a lost connection.
func (c *fakeConn) drop() { c.once.Do(func() { close(c.done) }) }

// harness runs a Consumer against a fake registry and serves the API over the same store.
type harness struct {
	st      store.Store
	reg     *fakeRegistry
	m       *metrics.Metrics
	promReg *prometheus.Registry
	api     *httptest.Server
	backoff Backoff
	// tokens, when set before start, is the consumer's token source.
	tokens TokenSource

	mu     sync.Mutex
	delays []time.Duration

	cancel context.CancelFunc
	done   chan struct{}
}

func newHarness(t *testing.T, st store.Store, reg *fakeRegistry) *harness {
	t.Helper()
	pr := prometheus.NewRegistry()
	h := &harness{st: st, reg: reg, m: metrics.New(pr), promReg: pr,
		backoff: Backoff{Base: 100 * time.Millisecond, Max: 1600 * time.Millisecond, Jitter: func() float64 { return 0.5 }}}
	srv := &api.Server{Store: st, Metrics: h.m, Gatherer: pr, Log: slog.New(slog.DiscardHandler)}
	h.api = httptest.NewServer(srv.Handler())
	t.Cleanup(h.api.Close)
	return h
}

// start runs a consumer (a process start) with the given layout.
func (h *harness) start(t *testing.T, layout int) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel, h.done = cancel, make(chan struct{})
	c := &Consumer{
		Store:   h.st,
		Sub:     ClientSubscriber{Client: &registry.Client{BaseURL: h.reg.srv.URL}},
		Schema:  testSchema,
		Layout:  layout,
		Log:     slog.New(slog.DiscardHandler),
		Metrics: h.m,
		Backoff: h.backoff,
		Tokens:  h.tokens,
		Sleep: func(ctx context.Context, d time.Duration) error {
			h.mu.Lock()
			h.delays = append(h.delays, d)
			h.mu.Unlock()
			return ctx.Err()
		},
	}
	go func() {
		defer close(h.done)
		_ = c.Run(ctx)
	}()
	t.Cleanup(h.stop)
}

// stop ends the consumer (a process stop) and waits for it.
func (h *harness) stop() {
	if h.cancel == nil {
		return
	}
	h.cancel()
	<-h.done
	h.cancel = nil
}

func (h *harness) waitDelays() []time.Duration {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.delays)
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// cursorIs waits until the generation in the given state stored cursor.
func (h *harness) cursorIs(t *testing.T, state, cursor string) {
	t.Helper()
	eventually(t, fmt.Sprintf("%s cursor %q", state, cursor), func() bool {
		st, err := h.st.State(context.Background())
		if err != nil {
			return false
		}
		g := st.Serving
		if state == store.StateBuilding {
			g = st.Building
		}
		return g != nil && g.Cursor == cursor
	})
}

func (h *harness) state(t *testing.T) store.State {
	t.Helper()
	st, err := h.st.State(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return st
}

type searchResponse struct {
	Results []store.Result `json:"results"`
}

// search calls GET /search and returns the status and the result names in order.
func (h *harness) search(t *testing.T, query string) (int, []string) {
	t.Helper()
	res, err := http.Get(h.api.URL + "/search?" + query) //nolint:noctx // test
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return res.StatusCode, nil
	}
	var body searchResponse
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, r := range body.Results {
		names = append(names, r.Name)
	}
	return res.StatusCode, names
}

func (h *harness) readyz(t *testing.T) int {
	t.Helper()
	res, err := http.Get(h.api.URL + "/readyz") //nolint:noctx // test
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

func (h *harness) counter(c *prometheus.CounterVec, label string) float64 {
	return testutil.ToFloat64(c.WithLabelValues(label))
}
