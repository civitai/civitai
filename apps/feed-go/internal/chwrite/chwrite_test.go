package chwrite

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// recorded is one request the fake server saw.
type recorded struct {
	method     string
	requestURI string
	path       string
	query      url.Values
	body       string
	user, pass string
}

// fakeServer answers every request with handler, recording it (in arrival order) and announcing it
// on the returned channel once recorded.
func fakeServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*httptest.Server, <-chan recorded, func() []recorded) {
	t.Helper()
	var mu sync.Mutex
	var seen []recorded
	arrived := make(chan recorded, 100)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		u, p, _ := r.BasicAuth()
		rec := recorded{r.Method, r.RequestURI, r.URL.Path, r.URL.Query(), string(body), u, p}
		mu.Lock()
		seen = append(seen, rec)
		mu.Unlock()
		arrived <- rec
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, arrived, func() []recorded {
		mu.Lock()
		defer mu.Unlock()
		return append([]recorded(nil), seen...)
	}
}

func ok(http.ResponseWriter, *http.Request) {}

// tokenRE is an insert_deduplication_token: 16 hex digits of the Writer's random prefix, a dash, the
// batch counter.
var tokenRE = regexp.MustCompile(`^[0-9a-f]{16}-[1-9][0-9]*$`)

// drop is one Config.Dropped call.
type drop struct {
	n      int
	reason string
}

// dropLog records Config.Dropped calls.
type dropLog struct {
	mu    sync.Mutex
	calls []drop
}

func (d *dropLog) hook(n int, reason string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, drop{n, reason})
}

func (d *dropLog) get() []drop {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]drop(nil), d.calls...)
}

// newWriter builds a Writer and closes it at the end of the test (Close is idempotent, so a test
// that closes it itself is unaffected).
func newWriter(t *testing.T, cfg Config) *Writer {
	t.Helper()
	w, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = w.Close(ctx)
	})
	return w
}

func closeWithin(t *testing.T, w *Writer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := w.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func waitRequest(t *testing.T, ch <-chan recorded) recorded {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(10 * time.Second):
		t.Fatal("no request arrived within 10s")
		return recorded{}
	}
}

type row struct {
	ID int `json:"id"`
}

func bodies(rs []recorded) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.body)
	}
	return out
}

// 7 rows with BatchRows=3 and a flush interval that never fires: two full batches are sent as the
// third and sixth rows are taken, before Close; the seventh row goes on Close. ceil(7/3) = 3 POSTs,
// each body the rows in order, one JSON object per line.
func TestBatchesByRows(t *testing.T) {
	srv, arrived, seen := fakeServer(t, ok)
	w := newWriter(t, Config{URL: srv.URL, Table: "events", BatchRows: 3, FlushInterval: time.Hour})
	for i := 1; i <= 7; i++ {
		if !w.Add(row{i}) {
			t.Fatalf("Add(%d) = false", i)
		}
	}
	if got := waitRequest(t, arrived).body; got != "{\"id\":1}\n{\"id\":2}\n{\"id\":3}\n" {
		t.Fatalf("first batch = %q", got)
	}
	if got := waitRequest(t, arrived).body; got != "{\"id\":4}\n{\"id\":5}\n{\"id\":6}\n" {
		t.Fatalf("second batch = %q", got)
	}
	closeWithin(t, w)
	want := []string{
		"{\"id\":1}\n{\"id\":2}\n{\"id\":3}\n",
		"{\"id\":4}\n{\"id\":5}\n{\"id\":6}\n",
		"{\"id\":7}\n",
	}
	if got := bodies(seen()); !reflect.DeepEqual(got, want) {
		t.Fatalf("bodies = %q, want %q", got, want)
	}
	recs := seen()
	suffixes := make([]string, 0, len(recs))
	for _, r := range recs {
		tok := r.query.Get("insert_deduplication_token")
		suffixes = append(suffixes, tok[strings.LastIndexByte(tok, '-')+1:])
	}
	if want := []string{"1", "2", "3"}; !reflect.DeepEqual(suffixes, want) {
		t.Fatalf("token batch counters = %v, want %v", suffixes, want)
	}
	if w.Sent() != 7 || w.Dropped() != 0 {
		t.Fatalf("sent %d dropped %d, want 7 and 0", w.Sent(), w.Dropped())
	}
}

// Each row is 9 bytes with its newline; BatchBytes=20 holds two, so a third starts the next batch:
// [1 2] [3 4] [5]. No batch's body goes past 20 bytes.
func TestBatchesByBytes(t *testing.T) {
	srv, _, seen := fakeServer(t, ok)
	w := newWriter(t, Config{URL: srv.URL, Table: "events", BatchRows: 100, BatchBytes: 20, FlushInterval: time.Hour})
	for i := 1; i <= 5; i++ {
		w.Add(row{i})
	}
	closeWithin(t, w)
	want := []string{
		"{\"id\":1}\n{\"id\":2}\n",
		"{\"id\":3}\n{\"id\":4}\n",
		"{\"id\":5}\n",
	}
	if got := bodies(seen()); !reflect.DeepEqual(got, want) {
		t.Fatalf("bodies = %q, want %q", got, want)
	}
}

// Fewer rows than BatchRows are sent once FlushInterval has passed, without Close (the test waits
// for the request before closing) and not before the interval.
func TestFlushInterval(t *testing.T) {
	srv, arrived, _ := fakeServer(t, ok)
	const interval = 300 * time.Millisecond
	w := newWriter(t, Config{URL: srv.URL, Table: "events", BatchRows: 100, FlushInterval: interval})
	start := time.Now()
	w.Add(row{1})
	w.Add(row{2})
	got := waitRequest(t, arrived)
	if elapsed := time.Since(start); elapsed < interval {
		t.Fatalf("sent after %v, before the %v flush interval", elapsed, interval)
	}
	if got.body != "{\"id\":1}\n{\"id\":2}\n" {
		t.Fatalf("body = %q", got.body)
	}
	closeWithin(t, w)
	if w.Sent() != 2 {
		t.Fatalf("sent = %d, want 2", w.Sent())
	}
}

// The request: a POST to /, basic auth, the URL path as the database, the URL's own query parameters
// kept, and the three this client sets.
func TestRequestShape(t *testing.T) {
	srv, _, seen := fakeServer(t, ok)
	w := newWriter(t, Config{URL: srv.URL + "/exampledb?application=test-writer", Username: "writer", Password: "pw", Table: "events"})
	w.Add(row{1})
	closeWithin(t, w)
	got := seen()
	if len(got) != 1 {
		t.Fatalf("%d requests, want 1", len(got))
	}
	r := got[0]
	if r.method != http.MethodPost || r.path != "/" || r.user != "writer" || r.pass != "pw" {
		t.Fatalf("method %q path %q auth %q/%q", r.method, r.path, r.user, r.pass)
	}
	token := r.query.Get("insert_deduplication_token")
	if !tokenRE.MatchString(token) || !strings.HasSuffix(token, "-1") {
		t.Fatalf("insert_deduplication_token = %q, want <16 hex>-1 (the first batch)", token)
	}
	r.query.Del("insert_deduplication_token")
	want := url.Values{
		"application":              {"test-writer"},
		"database":                 {"exampledb"},
		"async_insert":             {"1"},
		"wait_for_async_insert":    {"1"},
		"async_insert_deduplicate": {"1"},
		"query":                    {"INSERT INTO events FORMAT JSONEachRow"},
	}
	if !reflect.DeepEqual(r.query, want) {
		t.Fatalf("query = %v, want %v", r.query, want)
	}
	if r.body != "{\"id\":1}\n" {
		t.Fatalf("body = %q", r.body)
	}
}

// Whatever path a batch takes (delivered, retried after a 5xx, refused with a 4xx), every request is
// a POST whose query is exactly the INSERT, and no request carries SELECT anywhere: method, raw
// request URI, decoded query, body.
func TestNeverSendsSelect(t *testing.T) {
	var mu sync.Mutex
	n := 0
	srv, _, seen := fakeServer(t, func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		n++
		i := n
		mu.Unlock()
		switch i {
		case 2:
			w.WriteHeader(http.StatusServiceUnavailable)
		case 4:
			w.WriteHeader(http.StatusBadRequest)
		}
	})
	w := newWriter(t, Config{URL: srv.URL + "/exampledb", Table: "db1.events", BatchRows: 1, MaxRetries: 1,
		RetryBackoff: time.Millisecond, FlushInterval: time.Hour})
	for i := 1; i <= 3; i++ {
		w.Add(row{i})
	}
	closeWithin(t, w)
	got := seen()
	if len(got) != 4 {
		t.Fatalf("%d requests, want 4 (ok, 503, retry ok, 400)", len(got))
	}
	for i, r := range got {
		if r.method != http.MethodPost {
			t.Errorf("request %d: method %q", i, r.method)
		}
		q := r.query.Get("query")
		if q != "INSERT INTO db1.events FORMAT JSONEachRow" || !strings.HasPrefix(q, "INSERT INTO ") {
			t.Errorf("request %d: query %q", i, q)
		}
		for _, s := range []string{r.method, r.requestURI, r.query.Encode(), q, r.body} {
			if strings.Contains(strings.ToLower(s), "select") {
				t.Errorf("request %d carries SELECT: %q", i, s)
			}
		}
	}
}

// With the one batch in flight held by the server, the queue (4) fills and every Add past it returns
// false at once (all within 1s) and is counted: exactly the 3 overflow rows, reason queue_full. Once
// the server answers, the 5 queued rows are all delivered.
func TestQueueFullDropsWithoutBlocking(t *testing.T) {
	release := make(chan struct{})
	srv, arrived, seen := fakeServer(t, func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	var drops dropLog
	w := newWriter(t, Config{URL: srv.URL, Table: "events", QueueSize: 4, BatchRows: 1, FlushInterval: time.Hour, Dropped: drops.hook})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })

	if !w.Add(row{1}) {
		t.Fatal("Add(1) = false")
	}
	waitRequest(t, arrived) // row 1 is in flight; the queue is empty and nothing reads it

	results := make(chan []bool, 1)
	go func() {
		var r []bool
		for i := 2; i <= 8; i++ {
			r = append(r, w.Add(row{i}))
		}
		results <- r
	}()
	var got []bool
	select {
	case got = <-results:
	case <-time.After(time.Second):
		t.Fatal("Add blocked: 7 Adds did not return within 1s")
	}
	if want := []bool{true, true, true, true, false, false, false}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Add results = %v, want %v", got, want)
	}
	if w.Dropped() != 3 {
		t.Fatalf("Dropped() = %d, want 3", w.Dropped())
	}
	if want := []drop{{1, "queue_full"}, {1, "queue_full"}, {1, "queue_full"}}; !reflect.DeepEqual(drops.get(), want) {
		t.Fatalf("drops = %v, want %v", drops.get(), want)
	}

	once.Do(func() { close(release) })
	closeWithin(t, w)
	want := []string{"{\"id\":1}\n", "{\"id\":2}\n", "{\"id\":3}\n", "{\"id\":4}\n", "{\"id\":5}\n"}
	if got := bodies(seen()); !reflect.DeepEqual(got, want) {
		t.Fatalf("bodies = %q, want %q", got, want)
	}
	if w.Sent() != 5 || w.Dropped() != 3 {
		t.Fatalf("sent %d dropped %d, want 5 and 3", w.Sent(), w.Dropped())
	}
}

// The queue's byte bound: with one batch held in flight, rows of 8 marshalled bytes fill a 30-byte
// bound after three (24 bytes); the fourth (32 > 30) is dropped at once although the row bound (100) is far off,
// and a row larger than the bound on its own never queues. Once the server answers, the queued bytes
// are released and a row fits again.
func TestQueueBytesBound(t *testing.T) {
	release := make(chan struct{})
	srv, arrived, seen := fakeServer(t, func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	var drops dropLog
	w := newWriter(t, Config{URL: srv.URL, Table: "events", QueueSize: 100, QueueBytes: 30, BatchRows: 1,
		FlushInterval: time.Hour, Dropped: drops.hook})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })

	if !w.Add(row{1}) {
		t.Fatal("Add(1) = false")
	}
	waitRequest(t, arrived) // row 1 taken off the queue and in flight
	var got []bool
	for i := 2; i <= 5; i++ {
		got = append(got, w.Add(row{i}))
	}
	got = append(got, w.Add(map[string]string{"pad": strings.Repeat("x", 40)}))
	if want := []bool{true, true, true, false, false}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Add results = %v, want %v", got, want)
	}
	if want := []drop{{1, "queue_full"}, {1, "queue_full"}}; !reflect.DeepEqual(drops.get(), want) {
		t.Fatalf("drops = %v, want %v", drops.get(), want)
	}
	once.Do(func() { close(release) })
	closeWithin(t, w)
	want := []string{"{\"id\":1}\n", "{\"id\":2}\n", "{\"id\":3}\n", "{\"id\":4}\n"}
	if got := bodies(seen()); !reflect.DeepEqual(got, want) {
		t.Fatalf("bodies = %q, want %q", got, want)
	}
	if w.Sent() != 4 || w.Dropped() != 2 {
		t.Fatalf("sent %d dropped %d, want 4 and 2", w.Sent(), w.Dropped())
	}
}

// Rows still queued when Close is called are all sent (the flush interval would never fire).
func TestCloseFlushesQueued(t *testing.T) {
	srv, _, seen := fakeServer(t, ok)
	w := newWriter(t, Config{URL: srv.URL, Table: "events", BatchRows: 100, FlushInterval: time.Hour})
	for i := 1; i <= 5; i++ {
		w.Add(row{i})
	}
	closeWithin(t, w)
	want := []string{"{\"id\":1}\n{\"id\":2}\n{\"id\":3}\n{\"id\":4}\n{\"id\":5}\n"}
	if got := bodies(seen()); !reflect.DeepEqual(got, want) {
		t.Fatalf("bodies = %q, want %q", got, want)
	}
	if w.Sent() != 5 || w.Dropped() != 0 {
		t.Fatalf("sent %d dropped %d, want 5 and 0", w.Sent(), w.Dropped())
	}
}

// Close with an expired context while the server holds a batch: the batch in flight (2 rows) and the
// rows still queued (a batch of 2, then 1) are counted dropped as shutdown, no further request is
// sent, and Close returns the context's error.
func TestCloseExpiredContextCountsShutdown(t *testing.T) {
	release := make(chan struct{})
	srv, arrived, seen := fakeServer(t, func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	var drops dropLog
	w := newWriter(t, Config{URL: srv.URL, Table: "events", QueueSize: 10, BatchRows: 2, FlushInterval: time.Hour, Dropped: drops.hook})
	t.Cleanup(func() { close(release) })

	w.Add(row{1})
	w.Add(row{2})
	waitRequest(t, arrived)
	for i := 3; i <= 5; i++ {
		if !w.Add(row{i}) {
			t.Fatalf("Add(%d) = false", i)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := w.Close(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Close = %v, want context.Canceled", err)
	}
	if want := []drop{{2, "shutdown"}, {2, "shutdown"}, {1, "shutdown"}}; !reflect.DeepEqual(drops.get(), want) {
		t.Fatalf("drops = %v, want %v", drops.get(), want)
	}
	if w.Dropped() != 5 || w.Sent() != 0 {
		t.Fatalf("dropped %d sent %d, want 5 and 0", w.Dropped(), w.Sent())
	}
	if n := len(seen()); n != 1 {
		t.Fatalf("%d requests, want 1", n)
	}
}

// After Close, Add returns false and counts the row as shutdown; a second Close returns nil.
func TestAddAfterCloseAndCloseIdempotent(t *testing.T) {
	srv, _, seen := fakeServer(t, ok)
	var drops dropLog
	w := newWriter(t, Config{URL: srv.URL, Table: "events", Dropped: drops.hook})
	closeWithin(t, w)
	if w.Add(row{1}) {
		t.Fatal("Add after Close = true")
	}
	if want := []drop{{1, "shutdown"}}; !reflect.DeepEqual(drops.get(), want) {
		t.Fatalf("drops = %v, want %v", drops.get(), want)
	}
	if w.Dropped() != 1 {
		t.Fatalf("Dropped() = %d, want 1", w.Dropped())
	}
	if err := w.Close(context.Background()); err != nil {
		t.Fatalf("second Close = %v", err)
	}
	if n := len(seen()); n != 0 {
		t.Fatalf("%d requests, want 0", n)
	}
}

// A 5xx on every attempt: MaxRetries=2 sends the batch 3 times, then drops its 2 rows as http_5xx,
// and OnError sees each of the 3 failures.
func TestServerErrorRetriedThenDropped(t *testing.T) {
	srv, _, seen := fakeServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Code: 999. synthetic failure", http.StatusInternalServerError)
	})
	var drops dropLog
	var errMu sync.Mutex
	var errs []string
	w := newWriter(t, Config{URL: srv.URL, Table: "events", BatchRows: 2, MaxRetries: 2, RetryBackoff: time.Millisecond,
		Dropped: drops.hook, OnError: func(err error) { errMu.Lock(); errs = append(errs, err.Error()); errMu.Unlock() }})
	w.Add(row{1})
	w.Add(row{2})
	closeWithin(t, w)
	got := seen()
	if len(got) != 3 {
		t.Fatalf("%d attempts, want 3", len(got))
	}
	for i, r := range got {
		if r.body != "{\"id\":1}\n{\"id\":2}\n" {
			t.Fatalf("attempt %d body = %q", i, r.body)
		}
		// Every attempt of the batch carries the same deduplication token.
		if tok := r.query.Get("insert_deduplication_token"); !tokenRE.MatchString(tok) || tok != got[0].query.Get("insert_deduplication_token") {
			t.Fatalf("attempt %d token %q, attempt 0 %q", i, tok, got[0].query.Get("insert_deduplication_token"))
		}
	}
	if want := []drop{{2, "http_5xx"}}; !reflect.DeepEqual(drops.get(), want) {
		t.Fatalf("drops = %v, want %v", drops.get(), want)
	}
	errMu.Lock()
	defer errMu.Unlock()
	wantErr := "clickhouse insert: http 500: Code: 999. synthetic failure"
	if want := []string{wantErr, wantErr, wantErr}; !reflect.DeepEqual(errs, want) {
		t.Fatalf("errors = %q, want %q", errs, want)
	}
	if w.Sent() != 0 || w.Dropped() != 2 {
		t.Fatalf("sent %d dropped %d, want 0 and 2", w.Sent(), w.Dropped())
	}
}

// A 5xx then a 200: the batch is delivered on the retry, once, and nothing is dropped.
func TestServerErrorThenSuccess(t *testing.T) {
	var mu sync.Mutex
	n := 0
	srv, _, seen := fakeServer(t, func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		n++
		first := n == 1
		mu.Unlock()
		if first {
			w.WriteHeader(http.StatusBadGateway)
		}
	})
	var drops dropLog
	w := newWriter(t, Config{URL: srv.URL, Table: "events", MaxRetries: 3, RetryBackoff: time.Millisecond, Dropped: drops.hook})
	w.Add(row{1})
	closeWithin(t, w)
	if n := len(seen()); n != 2 {
		t.Fatalf("%d attempts, want 2", n)
	}
	if w.Sent() != 1 || w.Dropped() != 0 || len(drops.get()) != 0 {
		t.Fatalf("sent %d dropped %d drops %v, want 1, 0, none", w.Sent(), w.Dropped(), drops.get())
	}
}

// A 4xx is not retried, whatever MaxRetries is: one attempt, the rows dropped as http_4xx.
func TestClientErrorNotRetried(t *testing.T) {
	srv, _, seen := fakeServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	var drops dropLog
	w := newWriter(t, Config{URL: srv.URL, Table: "events", MaxRetries: 5, RetryBackoff: time.Millisecond, Dropped: drops.hook})
	w.Add(row{1})
	w.Add(row{2})
	w.Add(row{3})
	closeWithin(t, w)
	if n := len(seen()); n != 1 {
		t.Fatalf("%d attempts, want 1", n)
	}
	if want := []drop{{3, "http_4xx"}}; !reflect.DeepEqual(drops.get(), want) {
		t.Fatalf("drops = %v, want %v", drops.get(), want)
	}
	if w.Dropped() != 3 {
		t.Fatalf("Dropped() = %d, want 3", w.Dropped())
	}
}

// A redirect is never followed (following a 302 would turn the POST into a GET elsewhere), even with
// a caller's client: one request, the rows dropped as http_other.
func TestRedirectNotFollowed(t *testing.T) {
	srv, _, seen := fakeServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	})
	var drops dropLog
	w := newWriter(t, Config{URL: srv.URL, Table: "events", MaxRetries: 2, HTTP: srv.Client(), Dropped: drops.hook})
	w.Add(row{1})
	closeWithin(t, w)
	got := seen()
	if len(got) != 1 || got[0].method != http.MethodPost {
		t.Fatalf("requests = %+v, want one POST", got)
	}
	if want := []drop{{1, "http_other"}}; !reflect.DeepEqual(drops.get(), want) {
		t.Fatalf("drops = %v, want %v", drops.get(), want)
	}
}

// A transport error (nothing listening) is retried, then dropped as transport; the errors OnError sees
// do not carry the request URL (its query names the table and the settings).
func TestTransportErrorRetriedAndRedacted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(ok))
	addr := srv.URL
	srv.Close()
	var drops dropLog
	var errMu sync.Mutex
	var errs []string
	w := newWriter(t, Config{URL: addr, Table: "events", MaxRetries: 1, RetryBackoff: time.Millisecond, Dropped: drops.hook,
		OnError: func(err error) { errMu.Lock(); errs = append(errs, err.Error()); errMu.Unlock() }})
	w.Add(row{1})
	closeWithin(t, w)
	if want := []drop{{1, "transport"}}; !reflect.DeepEqual(drops.get(), want) {
		t.Fatalf("drops = %v, want %v", drops.get(), want)
	}
	errMu.Lock()
	defer errMu.Unlock()
	if len(errs) != 2 {
		t.Fatalf("%d errors, want 2 (first attempt and one retry): %q", len(errs), errs)
	}
	for _, e := range errs {
		if !strings.HasPrefix(e, "clickhouse insert: ") || strings.Contains(e, "INSERT") || strings.Contains(e, "query=") ||
			strings.Contains(e, "async_insert") {
			t.Fatalf("error carries the request URL or lacks the prefix: %q", e)
		}
	}
}

// A row that does not marshal to a JSON object is refused at Add and counted as marshal; nothing is
// queued or sent for it.
func TestAddRejectsNonObjects(t *testing.T) {
	srv, _, seen := fakeServer(t, ok)
	var drops dropLog
	w := newWriter(t, Config{URL: srv.URL, Table: "events", Dropped: drops.hook})
	var nilRow *row
	for _, r := range []any{func() {}, make(chan int), "text", 42, []int{1}, nil, nilRow} {
		if w.Add(r) {
			t.Fatalf("Add(%T) = true", r)
		}
	}
	if !w.Add(map[string]int{"id": 9}) {
		t.Fatal("Add(map) = false")
	}
	closeWithin(t, w)
	if w.Dropped() != 7 {
		t.Fatalf("Dropped() = %d, want 7", w.Dropped())
	}
	for _, d := range drops.get() {
		if d != (drop{1, "marshal"}) {
			t.Fatalf("drop %v, want {1 marshal}", d)
		}
	}
	if got := bodies(seen()); !reflect.DeepEqual(got, []string{"{\"id\":9}\n"}) {
		t.Fatalf("bodies = %q", got)
	}
}

// New refuses a table name that is not an identifier (so the query text can only be the INSERT), a
// URL that is not absolute http(s) or that carries credentials (without echoing them), and negative
// settings; it accepts database.table.
func TestNewValidates(t *testing.T) {
	for _, table := range []string{"", "t; SELECT 1", "t FORMAT", "t FORMAT CSV", "1t", "a.b.c", "a.", ".a", "t\n",
		"`t`", "t-1", "db.t;", "évents"} {
		if _, err := New(Config{URL: "http://example.test", Table: table}); err == nil {
			t.Errorf("New accepted table %q", table)
		}
	}
	for _, u := range []string{"", "ftp://example.test", "example.test:8123", "/relative", "http://", "http://%zz"} {
		if _, err := New(Config{URL: u, Table: "events"}); err == nil {
			t.Errorf("New accepted URL %q", u)
		}
	}
	_, err := New(Config{URL: "https://writer:s3cret-pw@example.test", Table: "events"}) //nolint:gosec // G101: a synthetic credential New must refuse
	if err == nil || strings.Contains(err.Error(), "s3cret-pw") {
		t.Errorf("credentialed URL: err = %v", err)
	}
	for _, cfg := range []Config{{QueueSize: -1}, {BatchRows: -1}, {BatchBytes: -1}, {MaxRetries: -1},
		{FlushInterval: -1}, {RetryBackoff: -1}, {RequestTimeout: -1}} {
		cfg.URL, cfg.Table = "http://example.test", "events"
		if _, err := New(cfg); err == nil {
			t.Errorf("New accepted %+v", cfg)
		}
	}
	for _, table := range []string{"events", "_t1", "db1.events", "Db_2.T_3"} {
		w, err := New(Config{URL: "http://example.test", Table: table})
		if err != nil {
			t.Errorf("New refused table %q: %v", table, err)
			continue
		}
		if err := w.Close(context.Background()); err != nil {
			t.Errorf("Close: %v", err)
		}
	}
}
