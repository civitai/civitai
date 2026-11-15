package tracker

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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
	if err := cl.Close(ctx); err != nil {
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
