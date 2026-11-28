package tracker

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
)

func noSleep(context.Context, time.Duration) {}

// The retry policy is sendWithRetry's: 3 attempts, a 4xx ends it, a 5xx or a network error retries.
func TestSendRetryPolicy(t *testing.T) {
	cases := []struct {
		name     string
		statuses []int
		result   string
		attempts int32
	}{
		{"ok first", []int{204}, ResultOK, 1},
		{"5xx then ok", []int{503, 200}, ResultOK, 2},
		{"5xx thrice", []int{500, 502, 503}, ResultFailed, 3},
		{"4xx is final", []int{400}, ResultRejected, 1},
		{"5xx then 4xx", []int{500, 422}, ResultRejected, 2},
		{"3xx is retried like a 5xx", []int{304, 304, 304}, ResultFailed, 3},
	}
	for _, c := range cases {
		var n atomic.Int32
		var gotPath, gotType, gotBody string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			i := n.Add(1) - 1
			b, _ := io.ReadAll(r.Body)
			gotPath, gotType, gotBody = r.URL.Path, r.Header.Get("Content-Type"), string(b)
			w.WriteHeader(c.statuses[min(int(i), len(c.statuses)-1)])
		}))
		cl := &Client{BaseURL: srv.URL + "/", HTTP: srv.Client(), Sleep: noSleep}
		got := cl.Send(context.Background(), beacon.Write{Table: "views", Body: []byte(`{"a":1}`)})
		srv.Close()
		if got != c.result || n.Load() != c.attempts {
			t.Errorf("%s: %s after %d attempts, want %s after %d", c.name, got, n.Load(), c.result, c.attempts)
		}
		if gotPath != "/track/views" || gotType != "application/json" || gotBody != `{"a":1}` {
			t.Errorf("%s: POST %s (%s) %q", c.name, gotPath, gotType, gotBody)
		}
	}
}

func TestSendNetworkErrorIsRetried(t *testing.T) {
	var slept []time.Duration
	cl := &Client{BaseURL: "http://127.0.0.1:1", Sleep: func(_ context.Context, d time.Duration) { slept = append(slept, d) }}
	if got := cl.Send(context.Background(), beacon.Write{Table: "views"}); got != ResultFailed || len(slept) != 2 {
		t.Fatalf("%s, slept %v", got, slept)
	}
	if slept[0] < 250*time.Millisecond || slept[0] >= 500*time.Millisecond || slept[1] < 500*time.Millisecond || slept[1] >= 750*time.Millisecond {
		t.Fatalf("delays %v outside backoffDelay's ranges", slept)
	}
}

func TestDelay(t *testing.T) {
	if Delay(2, 0) != 250*time.Millisecond || Delay(3, 0) != 500*time.Millisecond || Delay(3, 0.5) != 625*time.Millisecond {
		t.Fatal("Delay")
	}
}

// The queue: rows are sent by the workers, a full queue drops and counts, Close drains and then drops.
func TestQueue(t *testing.T) {
	release := make(chan struct{})
	var got atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
		got.Add(1)
		w.WriteHeader(200)
	}))
	defer srv.Close()
	var mu sync.Mutex
	results := map[string]int{}
	cl := &Client{BaseURL: srv.URL, HTTP: srv.Client(), Sleep: noSleep, Record: func(table, result string) {
		mu.Lock()
		results[table+":"+result]++
		mu.Unlock()
	}}
	cl.Start(1, 1)
	w := beacon.Write{Table: "pageViews", Body: []byte("{}")}
	// One row in flight (the worker blocks on the server), one queued, the rest dropped.
	deadline := time.Now().Add(5 * time.Second)
	accepted := 0
	for i := 0; i < 50 && time.Now().Before(deadline); i++ {
		if cl.Enqueue(w) {
			accepted++
		}
		time.Sleep(time.Millisecond)
	}
	if accepted < 1 || accepted > 3 {
		t.Fatalf("accepted %d rows into a queue of 1 with one worker", accepted)
	}
	close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := cl.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if cl.Enqueue(w) {
		t.Fatal("a closed client accepted a row")
	}
	mu.Lock()
	defer mu.Unlock()
	if results["pageViews:ok"] != accepted || int(got.Load()) != accepted || results["pageViews:dropped"] != 50-accepted+1 {
		t.Fatalf("results %v, sent %d, accepted %d", results, got.Load(), accepted)
	}
}

// blockingTracker answers nothing until release is called (or the test ends); entered receives once
// per request.
func blockingTracker(t *testing.T) (srv *httptest.Server, entered chan struct{}, release func()) {
	t.Helper()
	entered, gate := make(chan struct{}, 16), make(chan struct{})
	var once sync.Once
	release = func() { once.Do(func() { close(gate) }) }
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		entered <- struct{}{}
		<-gate
		w.WriteHeader(200)
	}))
	t.Cleanup(func() {
		release()
		srv.Close()
	})
	return srv, entered, release
}

// When Close's grace period ends, a row still queued (never sent) and the row inside the running
// POST are each counted as dropped and reported per table; when that POST ends later, its row is
// not counted a second time.
func TestCloseCountsTheRowsItAbandonsAsDropped(t *testing.T) {
	srv, entered, release := blockingTracker(t)
	var mu sync.Mutex
	results := map[string]int{}
	cl := &Client{BaseURL: srv.URL, HTTP: srv.Client(), Sleep: noSleep, Record: func(table, result string) {
		mu.Lock()
		results[table+":"+result]++
		mu.Unlock()
	}}
	cl.Start(1, 10)
	if !cl.Enqueue(beacon.Write{Table: "views", Body: []byte("{}")}) {
		t.Fatal("first row refused")
	}
	<-entered // the worker holds the first row in a POST that does not answer
	for range 4 {
		if !cl.Enqueue(beacon.Write{Table: "pageViews", Body: []byte("{}")}) {
			t.Fatal("a row was refused by a queue with room")
		}
	}
	if d := cl.Depth(); d != 4 {
		t.Fatalf("Depth %d with 4 rows waiting behind one in flight, want 4", d)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	a, err := cl.Close(ctx)
	if err == nil {
		t.Fatal("Close returned nil with a POST still running")
	}
	if a.InFlight != 1 || a.Dropped["pageViews"] != 4 || a.Dropped["views"] != 1 || len(a.Dropped) != 2 || a.Total() != 5 {
		t.Fatalf("abandoned %+v (total %d), want pageViews 4 + views 1 of which 1 in flight", a, a.Total())
	}
	if d := cl.Depth(); d != 0 {
		t.Fatalf("Depth %d after Close gave up, want 0", d)
	}
	// Close cancelled the running POST, and if the tracker answers it anyway its row was already
	// counted as dropped, so no ok.
	release()
	cl.wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if results["pageViews:dropped"] != 4 || results["views:dropped"] != 1 || len(results) != 2 {
		t.Fatalf("results %v, want the 4 waiting rows and the 1 in-flight row dropped, nothing else", results)
	}
}

// A worker that takes a row after Close has given up sends nothing and counts the row as dropped.
func TestAWorkerSendsNothingOnceCloseHasGivenUp(t *testing.T) {
	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		posts.Add(1)
		w.WriteHeader(200)
	}))
	defer srv.Close()
	var mu sync.Mutex
	results := map[string]int{}
	cl := &Client{BaseURL: srv.URL, HTTP: srv.Client(), Sleep: noSleep, Record: func(table, result string) {
		mu.Lock()
		results[table+":"+result]++
		mu.Unlock()
	}}
	cl.abandoned.Store(true)
	cl.Start(1, 4)
	cl.Enqueue(beacon.Write{Table: "views", Body: []byte("{}")})
	cl.mu.Lock()
	cl.closed = true
	close(cl.queue)
	cl.mu.Unlock()
	cl.wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if posts.Load() != 0 || results["views:dropped"] != 1 || len(results) != 1 {
		t.Fatalf("posts %d, results %v; want no POST and the row dropped", posts.Load(), results)
	}
}

// When Close gives up, nothing more reaches the tracker: with two workers, one stuck in a POST past
// the grace period and one that took a row off the queue but had not published it as its flight
// (so Close's scan of the flights cannot see it) and is released only after Close returned, the
// stuck POST is cancelled with no retry, the released worker sends nothing, and each row is counted
// as dropped exactly once. The released worker has only the abandoned flag Close set to tell it
// Close gave up: without that flag it would send (here: on a cancelled context, so it records
// failed, and is observed, instead of dropped).
func TestCloseGivingUpStopsEveryWorker(t *testing.T) {
	var posts atomic.Int32
	entered, gate := make(chan struct{}, 16), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		entered <- struct{}{}
		select {
		case <-gate:
			w.WriteHeader(500) // a retryable answer, were the row still being sent
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() {
		close(gate)
		srv.Close()
	})
	var mu sync.Mutex
	results := map[string]int{}
	var observed atomic.Int32
	cl := &Client{BaseURL: srv.URL, HTTP: srv.Client(), Sleep: noSleep,
		Observe: func(string, time.Duration) { observed.Add(1) },
		Record: func(table, result string) {
			mu.Lock()
			results[table+":"+result]++
			mu.Unlock()
		}}
	// The second row taken off the queue is held between the take and the flight's publication.
	var takes atomic.Int32
	holding, held := make(chan struct{}), make(chan struct{})
	var heldOnce sync.Once
	releaseTaker := func() { heldOnce.Do(func() { close(held) }) }
	t.Cleanup(releaseTaker)
	cl.taken = func() {
		if takes.Add(1) == 2 {
			close(holding)
			<-held
		}
	}
	cl.Start(2, 10)
	cl.Enqueue(beacon.Write{Table: "views", Body: []byte("{}")})
	<-entered // one worker is inside a POST that does not answer
	cl.Enqueue(beacon.Write{Table: "pageViews", Body: []byte("{}")})
	<-holding // the other has taken that row and is held before publishing it

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the grace period is already over
	a, err := cl.Close(ctx)
	if err == nil {
		t.Fatal("Close returned nil with a POST still running")
	}
	if a.InFlight != 1 || a.Dropped["views"] != 1 || len(a.Dropped) != 1 {
		t.Fatalf("abandoned %+v, want the views row inside the running POST", a)
	}
	atClose := posts.Load()
	releaseTaker()
	finished := make(chan struct{})
	go func() {
		cl.wg.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("a worker was still sending 5s after Close gave up")
	}
	mu.Lock()
	defer mu.Unlock()
	if atClose != 1 || posts.Load() != atClose {
		t.Fatalf("%d POSTs when Close returned and %d after, want 1 and no further POST", atClose, posts.Load())
	}
	if results["views:dropped"] != 1 || results["pageViews:dropped"] != 1 || len(results) != 2 || observed.Load() != 0 {
		t.Fatalf("results %v, observed %d; want each row dropped once and nothing observed", results, observed.Load())
	}
}

// Observe sees each sent row once, with its table and a duration covering the POST, before Record.
func TestObserveTimesEachSentRow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(20 * time.Millisecond)
		w.WriteHeader(202)
	}))
	defer srv.Close()
	var mu sync.Mutex
	var seen, order []string
	var took []time.Duration
	cl := &Client{BaseURL: srv.URL, HTTP: srv.Client(), Sleep: noSleep,
		Observe: func(table string, d time.Duration) {
			mu.Lock()
			seen, took, order = append(seen, table), append(took, d), append(order, "observe")
			mu.Unlock()
		},
		Record: func(_, result string) {
			mu.Lock()
			order = append(order, result)
			mu.Unlock()
		}}
	cl.Start(1, 4)
	cl.Enqueue(beacon.Write{Table: "views", Body: []byte("{}")})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := cl.Close(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 || seen[0] != "views" || took[0] < 20*time.Millisecond {
		t.Fatalf("observed %v %v, want one views row of at least 20ms", seen, took)
	}
	if len(order) != 2 || order[0] != "observe" || order[1] != ResultOK {
		t.Fatalf("order %v, want observe then ok", order)
	}
}

// A row refused by a closed client is never observed: Observe times sends only.
func TestObserveSkipsDroppedRows(t *testing.T) {
	var observed atomic.Int32
	cl := &Client{BaseURL: "http://127.0.0.1:1", Sleep: noSleep,
		Observe: func(string, time.Duration) { observed.Add(1) }}
	cl.Start(1, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := cl.Close(ctx); err != nil {
		t.Fatal(err)
	}
	cl.Enqueue(beacon.Write{Table: "views"})
	if observed.Load() != 0 {
		t.Fatalf("observed %d rows, want 0", observed.Load())
	}
}

// idleClient is a Client with a queue of size rows and no workers, so nothing takes a row off and
// the queue's room is exactly what the test leaves.
func idleClient(size int, record func(table, result string)) *Client {
	return &Client{Record: record, queue: make(chan beacon.Write, size)}
}

// rows is n distinct rows: table "search", bodies tag-0 … tag-(n-1).
func rows(tag string, n int) []beacon.Write {
	ws := make([]beacon.Write, n)
	for i := range ws {
		ws[i] = beacon.Write{Table: "search", Body: []byte(tag + "-" + strconv.Itoa(i))}
	}
	return ws
}

// EnqueueAll is all or nothing at the queue's boundary: a batch one row bigger than the room queues
// nothing and counts nothing (the caller falls back to Node), a batch exactly the room's size is
// queued whole and in order.
func TestEnqueueAllIsAllOrNothing(t *testing.T) {
	cases := []struct {
		name    string
		size    int
		prefill int
		batch   int
		closed  bool
		ok      bool
		depth   int
	}{
		{"one slot short", 5, 3, 3, false, false, 3},
		{"exactly the room", 5, 2, 3, false, true, 5},
		{"the whole empty queue", 5, 0, 5, false, true, 5},
		{"one past the whole queue", 5, 0, 6, false, false, 0},
		{"full queue, one row", 5, 5, 1, false, false, 5},
		{"full queue, no rows", 5, 5, 0, false, true, 5},
		{"closed client", 5, 0, 1, true, false, 0},
	}
	for _, c := range cases {
		var recorded []string
		cl := idleClient(c.size, func(table, result string) { recorded = append(recorded, table+":"+result) })
		for _, w := range rows("pre", c.prefill) {
			if !cl.Enqueue(w) {
				t.Fatalf("%s: prefill refused", c.name)
			}
		}
		cl.closed = c.closed
		if got := cl.EnqueueAll(rows("batch", c.batch)); got != c.ok {
			t.Errorf("%s: EnqueueAll %v, want %v", c.name, got, c.ok)
		}
		if cl.Depth() != c.depth {
			t.Errorf("%s: depth %d, want %d", c.name, cl.Depth(), c.depth)
		}
		if len(recorded) != 0 {
			t.Errorf("%s: recorded %v, want nothing (a refused batch is Node's to write)", c.name, recorded)
		}
		var bodies []string
		for cl.Depth() > 0 {
			bodies = append(bodies, string((<-cl.queue).Body))
		}
		var want []string
		for i := 0; i < c.prefill; i++ {
			want = append(want, "pre-"+strconv.Itoa(i))
		}
		if c.ok {
			for i := 0; i < c.batch; i++ {
				want = append(want, "batch-"+strconv.Itoa(i))
			}
		}
		if strings.Join(bodies, ",") != strings.Join(want, ",") {
			t.Errorf("%s: queued %v, want %v", c.name, bodies, want)
		}
	}
}

// Concurrent batches cannot both pass the room check and then overflow: 40 batches of 7 rows race
// for a queue of 100, so exactly 14 are queued (98 rows, then 2 slots, too few for any other) and
// each one's rows sit together in its own order.
func TestEnqueueAllConcurrentBatches(t *testing.T) {
	const size, batches, per = 100, 40, 7
	cl := idleClient(size, nil)
	var wg sync.WaitGroup
	var accepted atomic.Int32
	start := make(chan struct{})
	for b := 0; b < batches; b++ {
		wg.Add(1)
		go func(b int) {
			defer wg.Done()
			<-start
			if cl.EnqueueAll(rows("b"+strconv.Itoa(b), per)) {
				accepted.Add(1)
			}
		}(b)
	}
	close(start)
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("EnqueueAll blocked: two batches passed the room check and overflowed the queue")
	}
	if accepted.Load() != 14 || cl.Depth() != 98 {
		t.Fatalf("accepted %d batches, depth %d; want 14 and 98", accepted.Load(), cl.Depth())
	}
	seen := map[string]bool{}
	for g := 0; g < 14; g++ {
		var tag string
		for i := 0; i < per; i++ {
			body := string((<-cl.queue).Body)
			cut := strings.LastIndexByte(body, '-')
			if i == 0 {
				tag = body[:cut]
				if seen[tag] {
					t.Fatalf("batch %s queued twice", tag)
				}
				seen[tag] = true
			}
			if body != tag+"-"+strconv.Itoa(i) {
				t.Fatalf("group %d row %d is %q, want %s-%d: a batch was split", g, i, body, tag, i)
			}
		}
	}
}
