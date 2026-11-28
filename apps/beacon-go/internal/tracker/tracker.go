// Package tracker sends beacon rows to the ClickHouse tracker service the way the Node Tracker does
// (src/server/clickhouse/tracker.ts send/sendWithRetry): POST `${CLICKHOUSE_TRACKER_URL}/track/<table>`
// with the row as `application/json`, up to 3 attempts, a 4xx ends it (the payload was refused), a
// 5xx or a network failure is retried after 250 ms·2^(attempt-2) plus up to 250 ms of jitter.
//
// Like the Node path it is fire-and-forget: the beacon's response never waits for the tracker. Unlike
// it, the backlog is bounded (a queue of Queue rows, drained by Workers goroutines): a full queue
// drops the row and counts it, where Node would keep piling up promises. EnqueueAll queues a batch's
// rows all or none, so a caller can hand a batch the queue cannot take whole back to Node instead. When Close gives up, every
// row still queued and every row inside a POST that is still running is counted as dropped too (and
// reported back, per table), so every queued row ends in exactly one result; the running POSTs are
// then cancelled and no row starts another attempt.
package tracker

import (
	"bytes"
	"context"
	"io"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
)

// The write results (beacon_go_tracker_writes_total{result}).
const (
	ResultOK       = "ok"
	ResultRejected = "rejected" // a 4xx: not retried, as in Node
	ResultFailed   = "failed"   // 5xx or network, all attempts spent
	ResultDropped  = "dropped"  // the queue was full, the client is closed, or Close gave up on it
)

// Results lists every result, for seeding the counter.
var Results = []string{ResultOK, ResultRejected, ResultFailed, ResultDropped}

// MaxAttempts and BaseDelay are sendWithRetry's MAX_ATTEMPTS and baseDelayMs.
const (
	MaxAttempts = 3
	BaseDelay   = 250 * time.Millisecond
	// AttemptTimeout bounds one POST. The Node fire-and-forget path sets none (undici's 300 s header
	// timeout applies); a bounded queue needs one, or a hung tracker would stall every worker.
	AttemptTimeout = 10 * time.Second
)

// Client is the bounded fire-and-forget sender.
type Client struct {
	BaseURL string
	HTTP    *http.Client
	// Record is called once per row with its table and result.
	Record func(table, result string)
	// Observe, when set, is called once per row a worker sent, with its table and how long Send took
	// (every attempt and the waits between them), before Record.
	Observe func(table string, d time.Duration)
	// Sleep waits between attempts (tests replace it).
	Sleep func(ctx context.Context, d time.Duration)

	queue  chan beacon.Write
	wg     sync.WaitGroup
	mu     sync.RWMutex
	closed bool
	// flights holds, per worker, the row it is sending (nil when idle); abandoned is set once Close
	// has given up, after which a worker sends nothing more.
	flights   []atomic.Pointer[flight]
	abandoned atomic.Bool
	// stop is the context every worker sends on; cancel ends it when Close gives up, cutting the
	// running POSTs short and keeping a retry from starting.
	stop   context.Context
	cancel context.CancelFunc
	// taken, when set (tests only), is called after a worker takes a row off the queue and before it
	// publishes the row as its flight.
	taken func()
}

// flight is one row a worker took off the queue. settled is won by whoever records the row's one
// result: the worker when its send ends, or Close when it gives up while the send is still running.
type flight struct {
	table   string
	settled atomic.Bool
}

// Abandoned is what Close gave up on when its grace period ended. Every row in it was counted as
// dropped.
type Abandoned struct {
	// Dropped is per table: the rows still queued (never sent) plus the rows inside a POST that was
	// still running (whatever that POST returns is never recorded).
	Dropped map[string]int
	// InFlight is how many of those were inside a running POST.
	InFlight int
}

// Total is the number of rows Close gave up on.
func (a Abandoned) Total() int {
	n := 0
	for _, v := range a.Dropped {
		n += v
	}
	return n
}

// Start starts workers draining a queue of the given size.
func (c *Client) Start(workers, queue int) {
	c.queue = make(chan beacon.Write, max(queue, 1))
	c.flights = make([]atomic.Pointer[flight], max(workers, 1))
	c.stop, c.cancel = context.WithCancel(context.Background())
	for i := range c.flights {
		c.wg.Add(1)
		go func(slot *atomic.Pointer[flight]) {
			defer c.wg.Done()
			for w := range c.queue {
				if c.taken != nil {
					c.taken()
				}
				f := &flight{table: w.Table}
				slot.Store(f)
				// Close stores abandoned before it reads the slots and this reads it after the Store,
				// so a row taken in the instant Close gives up is seen by Close, by this check, or by
				// both; settled keeps it to one count.
				if c.abandoned.Load() {
					if f.settled.CompareAndSwap(false, true) {
						c.record(w.Table, ResultDropped)
					}
					slot.Store(nil)
					continue
				}
				start := time.Now()
				// Close settles this row before it cancels stop (it sees the flight stored above, or
				// this worker saw abandoned), so a send cut short by stop is never what gets recorded.
				result := c.Send(c.stop, w)
				if f.settled.CompareAndSwap(false, true) {
					if c.Observe != nil {
						c.Observe(w.Table, time.Since(start))
					}
					c.record(w.Table, result)
				}
				slot.Store(nil)
			}
		}(&c.flights[i])
	}
}

func (c *Client) record(table, result string) {
	if c.Record != nil {
		c.Record(table, result)
	}
}

// Enqueue queues a row without blocking; false (and a `dropped` count) when the queue is full or the
// client is closed.
func (c *Client) Enqueue(w beacon.Write) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.closed {
		c.record(w.Table, ResultDropped)
		return false
	}
	select {
	case c.queue <- w:
		return true
	default:
		c.record(w.Table, ResultDropped)
		return false
	}
}

// EnqueueAll queues every row of ws or none of them, without blocking: false when the client is
// closed or the queue has room for fewer than len(ws) rows, and then nothing is queued and nothing is
// counted (the caller hands the whole request to the Node app, which writes the rows). It holds the
// write lock, so no Enqueue or other EnqueueAll can queue a row between its room check and its
// sends; the workers only take rows off meanwhile, which only adds room, so no send below blocks.
func (c *Client) EnqueueAll(ws []beacon.Write) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || cap(c.queue)-len(c.queue) < len(ws) {
		return false
	}
	for _, w := range ws {
		c.queue <- w
	}
	return true
}

// Depth is the number of rows waiting in the queue (not counting the ones being sent).
func (c *Client) Depth() int { return len(c.queue) }

// Close stops accepting rows and waits (until ctx ends) for the queued ones to be sent. When ctx
// ends first, every row still waiting is taken off the queue and every row inside a POST that is
// still running is given up on; each is counted as dropped (uncounted it would be a silent loss: the
// process exits before that POST ends) and returned per table, with ctx's error; then the running
// POSTs are cancelled, so a row counted as dropped starts no further attempt.
func (c *Client) Close(ctx context.Context) (Abandoned, error) {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		close(c.queue)
	}
	c.mu.Unlock()
	done := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		c.cancel()
		return Abandoned{}, nil
	case <-ctx.Done():
		// When both are ready the select picks either; a drain that did finish is not a give-up.
		select {
		case <-done:
			c.cancel()
			return Abandoned{}, nil
		default:
		}
		a := Abandoned{Dropped: map[string]int{}}
		c.abandoned.Store(true)
		// The queue is closed, so this ends once it is empty; a worker finishing its POST takes the
		// next row in the meantime, and each row is received exactly once either way.
		for w := range c.queue {
			c.record(w.Table, ResultDropped)
			a.Dropped[w.Table]++
		}
		for i := range c.flights {
			if f := c.flights[i].Load(); f != nil && f.settled.CompareAndSwap(false, true) {
				c.record(f.table, ResultDropped)
				a.Dropped[f.table]++
				a.InFlight++
			}
		}
		// Only now: every row a worker is sending has been settled above, so cancelling cannot turn a
		// send into a recorded result, it only stops the POST and any retry.
		c.cancel()
		return a, ctx.Err()
	}
}

func (c *Client) sleep(ctx context.Context, d time.Duration) {
	if c.Sleep != nil {
		c.Sleep(ctx, d)
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// Delay is backoffDelay(attempt - 2, {baseMs: 250, jitterMs: 250}) for attempt 2 and 3, given a
// jitter fraction in [0, 1).
func Delay(attempt int, jitter float64) time.Duration {
	return BaseDelay<<(attempt-2) + time.Duration(jitter*float64(BaseDelay))
}

// Send posts one row with sendWithRetry's policy and returns its result. Once ctx is cancelled it
// starts no further attempt and returns failed.
func (c *Client) Send(ctx context.Context, w beacon.Write) string {
	url := strings.TrimRight(c.BaseURL, "/") + "/track/" + w.Table
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	for attempt := 1; attempt <= MaxAttempts; attempt++ {
		if attempt > 1 {
			c.sleep(ctx, Delay(attempt, rand.Float64())) //nolint:gosec // G404: retry jitter, not a secret
		}
		// A cancelled ctx (Close gave up on this row) starts no further attempt.
		if ctx.Err() != nil {
			return ResultFailed
		}
		status, err := c.post(ctx, client, url, w.Body)
		switch {
		case err == nil && status >= 200 && status < 300:
			return ResultOK
		case err == nil && status >= 400 && status < 500:
			return ResultRejected
		}
	}
	return ResultFailed
}

func (c *Client) post(ctx context.Context, client *http.Client, url string, body []byte) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, AttemptTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	return res.StatusCode, nil
}
