// Package chwrite is a ClickHouse INSERT client over the HTTP interface: rows a caller hands it are
// queued in memory, batched, and sent as one INSERT ... FORMAT JSONEachRow per batch, from a single
// background goroutine. It is not wired into the server yet: nothing in this module constructs a
// Writer, so it has no effect on what the service does.
//
// It is a separate package from chread on purpose. chread promises it is read-only by construction
// (every query a GET, which ClickHouse runs read-only); a writer needs POST, so it lives here, and
// chread stays a package that cannot write.
//
// Insert-only by construction: every request is a POST whose query parameter is exactly
// "INSERT INTO <table> FORMAT JSONEachRow", where <table> is checked by New to be an identifier
// (optionally database.table), so the query text can be nothing but that INSERT. The body is the
// batch's rows, one JSON object per line; ClickHouse reads everything after the FORMAT clause as data
// in that format, never as SQL.
//
// The caller never waits on ClickHouse. Add marshals the row and puts it on a queue bounded both in
// rows (QueueSize) and in bytes (QueueBytes) with a non-blocking send: a full queue drops the row
// (counted, reason ReasonQueueFull), it does not apply back-pressure, and the memory it holds is
// bounded however large the rows are. A batch that fails (after its retries, for a 5xx or transport
// error) is dropped and its rows counted, through Config.Dropped and Writer.Dropped.
//
// Delivery is at least once across retries, not exactly once: an attempt that times out or loses its
// connection may still have been written, and its retry then writes the rows again (and a batch whose
// last such attempt landed is counted dropped although it was written). Every attempt of one batch
// carries the same insert_deduplication_token (random per Writer, then a batch counter) with
// async_insert_deduplicate=1, so a table with insert deduplication enabled keeps one copy; on a table
// without it, a retried batch can be duplicated. Keep RequestTimeout above the server's async flush
// wait so a slow but successful insert is not retried.
//
// Settings sent with every INSERT: async_insert=1 (the server buffers small inserts from many pods
// into larger parts, rather than creating a part per batch) and wait_for_async_insert=1. The latter
// makes the response report whether the rows were actually written: with 0 the server answers as
// soon as the data is in its buffer, so a failure while flushing that buffer (a type mismatch, a
// missing column) would never reach this client and the dropped count would read zero while rows
// were being lost. The cost is that each POST waits for the server's async flush (its
// async_insert_busy_timeout); that wait is on the background goroutine, never the caller's, and only
// bounds throughput at one batch in flight per Writer.
//
// The background goroutine starts in New, so a Writer can never be built and fed but not started;
// Close must be called to flush the queue and end it.
package chwrite

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Drop reasons: the fixed set Config.Dropped is called with.
const (
	// ReasonQueueFull: Add found the queue full.
	ReasonQueueFull = "queue_full"
	// ReasonMarshal: the row did not marshal to a JSON object (json.Marshal failed, or the row is
	// not an object: a string, number, array or null is not a JSONEachRow row).
	ReasonMarshal = "marshal"
	// ReasonHTTP4xx: ClickHouse answered 4xx (bad data, unknown table, auth). Not retried.
	ReasonHTTP4xx = "http_4xx"
	// ReasonHTTPOther: ClickHouse answered a non-2xx status below 400 (a redirect, which is never
	// followed: following one could turn the POST into a GET). Not retried.
	ReasonHTTPOther = "http_other"
	// ReasonHTTP5xx: ClickHouse answered 5xx on every attempt.
	ReasonHTTP5xx = "http_5xx"
	// ReasonTransport: the request failed without a response (connect, timeout) on every attempt.
	ReasonTransport = "transport"
	// ReasonShutdown: Add after Close, or a row still queued or in flight when Close's context ended.
	ReasonShutdown = "shutdown"
)

// Defaults for zero Config fields.
const (
	DefaultQueueSize      = 10000
	DefaultQueueBytes     = 64 << 20
	DefaultBatchRows      = 1000
	DefaultBatchBytes     = 1 << 20
	DefaultFlushInterval  = time.Second
	DefaultRetryBackoff   = 200 * time.Millisecond
	DefaultRequestTimeout = 10 * time.Second
	// maxBackoff caps the doubling retry wait.
	maxBackoff = 5 * time.Second
)

// Config is where and how to write.
type Config struct {
	// URL is the HTTP(S) endpoint, e.g. https://host:8443. A path names the database, as chread reads
	// it; query parameters in it are sent with every insert (the ones this client sets win).
	URL string
	// Username and Password are HTTP basic auth: a dedicated INSERT-only login.
	Username, Password string
	// Table is the table inserted into: an identifier, [A-Za-z_][A-Za-z0-9_]*, optionally prefixed by
	// a database identifier and a dot. Required.
	Table string
	// QueueSize is how many marshalled rows wait for the background goroutine (0: DefaultQueueSize).
	// A row past it is dropped (ReasonQueueFull).
	QueueSize int
	// QueueBytes bounds the marshalled bytes waiting in the queue (0: DefaultQueueBytes). A row that
	// would take it past this is dropped (ReasonQueueFull); a single row larger than it never queues.
	QueueBytes int
	// BatchRows sends a batch once it holds this many rows (0: DefaultBatchRows).
	BatchRows int
	// BatchBytes bounds a batch's body: a row that would take it past this starts the next batch
	// (0: DefaultBatchBytes). A single row larger than it is sent alone.
	BatchBytes int
	// FlushInterval sends a batch at most this long after its first row was taken from the queue,
	// however few rows it holds (0: DefaultFlushInterval).
	FlushInterval time.Duration
	// MaxRetries is how many times a batch is re-sent after a 5xx or transport error, so a batch is
	// attempted at most MaxRetries+1 times. 0: no retry.
	MaxRetries int
	// RetryBackoff is the wait before the first retry, doubled for each later one up to 5s
	// (0: DefaultRetryBackoff). The wait ends early when Close's context ends.
	RetryBackoff time.Duration
	// RequestTimeout bounds one attempt (0: DefaultRequestTimeout).
	RequestTimeout time.Duration
	// HTTP is the client (nil: a dedicated one, whose idle connections Close closes). Its redirect
	// policy is replaced: a redirect is never followed.
	HTTP *http.Client
	// Dropped, when set, is called with each batch or row dropped, and why (one of the Reason
	// constants). It is called from Add's caller (queue_full, marshal, shutdown) and from the
	// background goroutine, so concurrently: it must be safe for that and must not block.
	Dropped func(n int, reason string)
	// OnError, when set, is called from the background goroutine with each failed attempt's error
	// (a retried one included). A transport error never carries the request URL. An HTTP error
	// carries up to 4 KiB of ClickHouse's answer, and ClickHouse quotes the offending input in a parse
	// error: treat the text as holding row data, and never log it where the rows may not go.
	OnError func(err error)
}

// Writer queues rows and inserts them in batches. Safe for concurrent use.
type Writer struct {
	endpoint   string
	user, pass string
	http       *http.Client
	ownHTTP    bool

	batchRows, batchBytes int
	queueBytes            int64
	// tokenPrefix and batchSeq make each batch's insert_deduplication_token (batchSeq: run's only).
	tokenPrefix      string
	batchSeq         uint64
	interval         time.Duration
	maxRetries       int
	backoff, timeout time.Duration
	onDrop           func(int, string)
	onError          func(error)

	// mu guards closed and the close of queue: Add holds it shared across its check and its
	// (non-blocking) send, so no row is sent on a closed queue or lands after the final drain.
	mu     sync.RWMutex
	closed bool
	queue  chan []byte

	// ctx is the background goroutine's: cancelled when Close's context ends first.
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once

	dropped atomic.Uint64
	sent    atomic.Uint64
	// queued is the marshalled bytes in the queue: added by Add, subtracted as run takes a row.
	queued atomic.Int64
}

// New validates cfg and starts the background goroutine. The URL must be absolute http or https;
// credentials in it are refused (they would be sent and logged with every request URL), use Username
// and Password.
func New(cfg Config) (*Writer, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil {
		// Not wrapped: url.Parse's error repeats the URL.
		return nil, errors.New("clickhouse url: not a URL")
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("clickhouse url: want an absolute http(s) URL")
	}
	if u.User != nil {
		return nil, errors.New("clickhouse url: credentials belong in Username / Password")
	}
	if !validTable(cfg.Table) {
		return nil, errors.New("clickhouse table: want an identifier or database.identifier ([A-Za-z_][A-Za-z0-9_]*)")
	}
	if cfg.QueueSize < 0 || cfg.QueueBytes < 0 || cfg.BatchRows < 0 || cfg.BatchBytes < 0 || cfg.MaxRetries < 0 ||
		cfg.FlushInterval < 0 || cfg.RetryBackoff < 0 || cfg.RequestTimeout < 0 {
		return nil, errors.New("clickhouse writer: negative size, count or duration")
	}

	q := u.Query()
	if db := strings.Trim(u.Path, "/"); db != "" {
		q.Set("database", db)
	}
	u.Path = "/"
	q.Set("async_insert", "1")
	// 1, not 0: see the package doc (a failed async flush must reach the dropped count).
	q.Set("wait_for_async_insert", "1")
	// With the per-batch insert_deduplication_token post adds: see the package doc.
	q.Set("async_insert_deduplicate", "1")
	q.Set("query", InsertQuery(cfg.Table))
	u.RawQuery = q.Encode()

	var hc http.Client
	own := cfg.HTTP == nil
	if own {
		hc.Transport = http.DefaultTransport.(*http.Transport).Clone()
	} else {
		hc = *cfg.HTTP
	}
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	var prefix [8]byte
	if _, err := rand.Read(prefix[:]); err != nil {
		return nil, fmt.Errorf("clickhouse writer: dedup token: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	w := &Writer{
		queueBytes:  int64(orDefault(cfg.QueueBytes, DefaultQueueBytes)),
		tokenPrefix: hex.EncodeToString(prefix[:]),
		endpoint:    u.String(),
		user:        cfg.Username,
		pass:        cfg.Password,
		http:        &hc,
		ownHTTP:     own,
		batchRows:   orDefault(cfg.BatchRows, DefaultBatchRows),
		batchBytes:  orDefault(cfg.BatchBytes, DefaultBatchBytes),
		interval:    orDefault(cfg.FlushInterval, DefaultFlushInterval),
		maxRetries:  cfg.MaxRetries,
		backoff:     orDefault(cfg.RetryBackoff, DefaultRetryBackoff),
		timeout:     orDefault(cfg.RequestTimeout, DefaultRequestTimeout),
		onDrop:      cfg.Dropped,
		onError:     cfg.OnError,
		queue:       make(chan []byte, orDefault(cfg.QueueSize, DefaultQueueSize)),
		ctx:         ctx,
		cancel:      cancel,
		done:        make(chan struct{}),
	}
	go w.run()
	return w, nil
}

func orDefault[T int | time.Duration](v, def T) T {
	if v == 0 {
		return def
	}
	return v
}

// InsertQuery is the query text sent for table: "INSERT INTO <table> FORMAT JSONEachRow". table must
// already have passed New's check.
func InsertQuery(table string) string {
	return "INSERT INTO " + table + " FORMAT JSONEachRow"
}

// validTable is whether s is ident or ident.ident, ident being [A-Za-z_][A-Za-z0-9_]*.
func validTable(s string) bool {
	db, table, dotted := strings.Cut(s, ".")
	if !dotted {
		return validIdent(s)
	}
	return validIdent(db) && validIdent(table)
}

func validIdent(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '_', c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z':
		case c >= '0' && c <= '9' && i > 0:
		default:
			return false
		}
	}
	return true
}

// Add marshals row and queues it, without ever blocking on ClickHouse or on a full queue. It returns
// whether the row was queued; a row that was not is counted as dropped: ReasonMarshal when it does
// not marshal to a JSON object, ReasonQueueFull when the queue is full, ReasonShutdown after Close.
func (w *Writer) Add(row any) bool {
	b, err := json.Marshal(row)
	if err != nil || len(b) == 0 || b[0] != '{' {
		w.drop(1, ReasonMarshal)
		return false
	}
	// The reason is decided under the lock and counted after it, so the Dropped hook never runs
	// while Close waits for the lock.
	if reason := w.enqueue(b); reason != "" {
		w.drop(1, reason)
		return false
	}
	return true
}

// enqueue puts b on the queue, or says why not ("" when queued).
func (w *Writer) enqueue(b []byte) string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if w.closed {
		return ReasonShutdown
	}
	n := int64(len(b))
	if w.queued.Add(n) > w.queueBytes {
		w.queued.Add(-n)
		return ReasonQueueFull
	}
	select {
	case w.queue <- b:
		return ""
	default:
		w.queued.Add(-n)
		return ReasonQueueFull
	}
}

// Dropped is how many rows have been dropped, for every reason, so far.
func (w *Writer) Dropped() uint64 { return w.dropped.Load() }

// Sent is how many rows ClickHouse has acknowledged (a 2xx answer to their batch) so far.
func (w *Writer) Sent() uint64 { return w.sent.Load() }

func (w *Writer) drop(n int, reason string) {
	w.dropped.Add(uint64(n)) //nolint:gosec // n is a row count, never negative
	if w.onDrop != nil {
		w.onDrop(n, reason)
	}
}

// Close stops accepting rows (Add then returns false), sends everything still queued, and waits for
// the batch in flight, its retries included. If ctx ends first, the request in flight is abandoned
// and every row not yet acknowledged is counted dropped (ReasonShutdown); Close still waits for the
// background goroutine to finish counting (no I/O is attempted by then) and returns ctx's error.
// Idempotent: a later call waits for the same end (its own ctx ending first cuts the flush short
// the same way) and returns nil.
func (w *Writer) Close(ctx context.Context) error {
	first := false
	w.closeOnce.Do(func() {
		first = true
		w.mu.Lock()
		w.closed = true
		close(w.queue)
		w.mu.Unlock()
	})
	var err error
	select {
	case <-w.done:
	case <-ctx.Done():
		w.cancel()
		<-w.done
		err = ctx.Err()
	}
	w.cancel()
	if first && w.ownHTTP {
		w.http.CloseIdleConnections()
	}
	if !first {
		return nil
	}
	return err
}

// run is the background goroutine: it batches the queue by rows, bytes and time and sends each
// batch, one at a time, until the queue is closed and drained.
func (w *Writer) run() {
	defer close(w.done)
	var (
		batch  bytes.Buffer
		n      int
		timer  *time.Timer
		timerC <-chan time.Time
	)
	flush := func() {
		if timer != nil {
			timer.Stop()
			timer, timerC = nil, nil
		}
		if n == 0 {
			return
		}
		w.send(bytes.Clone(batch.Bytes()), n)
		batch.Reset()
		n = 0
	}
	for {
		select {
		case row, ok := <-w.queue:
			if !ok {
				flush()
				return
			}
			w.queued.Add(-int64(len(row)))
			if n > 0 && batch.Len()+len(row)+1 > w.batchBytes {
				flush()
			}
			if n == 0 {
				timer = time.NewTimer(w.interval)
				timerC = timer.C
			}
			batch.Write(row)
			batch.WriteByte('\n')
			n++
			if n >= w.batchRows || batch.Len() >= w.batchBytes {
				flush()
			}
		case <-timerC:
			timer, timerC = nil, nil
			flush()
		}
	}
}

// send posts one batch of n rows, retrying a 5xx or transport error up to maxRetries times with a
// doubling backoff, and counts the rows as sent or dropped.
func (w *Writer) send(body []byte, n int) {
	w.batchSeq++
	token := w.tokenPrefix + "-" + strconv.FormatUint(w.batchSeq, 10)
	wait := w.backoff
	for attempt := 0; ; attempt++ {
		if w.ctx.Err() != nil {
			w.drop(n, ReasonShutdown)
			return
		}
		reason, err := w.post(body, token)
		if err == nil {
			w.sent.Add(uint64(n)) //nolint:gosec // n is a row count, never negative
			return
		}
		if w.ctx.Err() != nil {
			// Abandoned by Close: whatever the attempt reported, the cause is the shutdown.
			w.drop(n, ReasonShutdown)
			return
		}
		if w.onError != nil {
			w.onError(err)
		}
		retryable := reason == ReasonHTTP5xx || reason == ReasonTransport
		if !retryable || attempt >= w.maxRetries {
			w.drop(n, reason)
			return
		}
		t := time.NewTimer(wait)
		select {
		case <-t.C:
		case <-w.ctx.Done():
			t.Stop()
			w.drop(n, ReasonShutdown)
			return
		}
		wait = min(wait*2, maxBackoff)
	}
}

// maxErrorBody bounds how much of an error response is read.
const maxErrorBody = 4 << 10

// post sends body once. A nil error is a 2xx; otherwise reason is the drop reason the failure maps to.
func (w *Writer) post(body []byte, token string) (reason string, err error) {
	ctx, cancel := context.WithTimeout(w.ctx, w.timeout)
	defer cancel()
	target := w.endpoint + "&insert_deduplication_token=" + url.QueryEscape(token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return ReasonTransport, fmt.Errorf("clickhouse insert: %w", redact(err))
	}
	if w.user != "" {
		req.SetBasicAuth(w.user, w.pass)
	}
	resp, err := w.http.Do(req)
	if err != nil {
		return ReasonTransport, fmt.Errorf("clickhouse insert: %w", redact(err))
	}
	defer func() { _ = resp.Body.Close() }()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return "", nil
	case resp.StatusCode >= 500:
		reason = ReasonHTTP5xx
	case resp.StatusCode >= 400:
		reason = ReasonHTTP4xx
	default:
		reason = ReasonHTTPOther
	}
	return reason, fmt.Errorf("clickhouse insert: http %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
}

// redact drops the request URL (it carries the query) from a transport error.
func redact(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
