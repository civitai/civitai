// Package tracker sends beacon rows to the ClickHouse tracker service the way the Node Tracker does
// (src/server/clickhouse/tracker.ts send/sendWithRetry): POST `${CLICKHOUSE_TRACKER_URL}/track/<table>`
// with the row as `application/json`, up to 3 attempts, a 4xx ends it (the payload was refused), a
// 5xx or a network failure is retried after 250 ms·2^(attempt-2) plus up to 250 ms of jitter.
//
// Like the Node path it is fire-and-forget: the beacon's response never waits for the tracker. Unlike
// it, the backlog is bounded (a queue of Queue rows, drained by Workers goroutines): a full queue
// drops the row and counts it, where Node would keep piling up promises.
package tracker

import (
	"bytes"
	"context"
	"io"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
)

// The write results (beacon_go_tracker_writes_total{result}).
const (
	ResultOK       = "ok"
	ResultRejected = "rejected" // a 4xx: not retried, as in Node
	ResultFailed   = "failed"   // 5xx or network, all attempts spent
	ResultDropped  = "dropped"  // the queue was full, or the client is closed
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
	// Sleep waits between attempts (tests replace it).
	Sleep func(ctx context.Context, d time.Duration)

	queue  chan beacon.Write
	wg     sync.WaitGroup
	mu     sync.RWMutex
	closed bool
}

// Start starts workers draining a queue of the given size.
func (c *Client) Start(workers, queue int) {
	c.queue = make(chan beacon.Write, max(queue, 1))
	for range max(workers, 1) {
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			for w := range c.queue {
				c.record(w.Table, c.Send(context.Background(), w))
			}
		}()
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

// Close stops accepting rows and waits (until ctx ends) for the queued ones to be sent.
func (c *Client) Close(ctx context.Context) error {
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
		return nil
	case <-ctx.Done():
		return ctx.Err()
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

// Send posts one row with sendWithRetry's policy and returns its result.
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
