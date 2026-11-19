package hydrate

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"
)

// WriteCaches is every cache write-back can write (FEED_GO_CACHE_WRITEBACK's names), each the cache's
// `cache` label of feed_go_cache_miss_total and feed_go_cache_writes_total. The image meta
// (MissImageMeta) is computed but never written, so it is not one.
var WriteCaches = []string{MissUserCosmetics, MissImageFrames, MissEventDecorations, MissTagIDs, MissModelFrames,
	MissModelDecorations, MissVersionImages, MissModelData, MissModelTags, MissOfficialModels, MissMetrics}

// PrimaryCaches are the caches whose lookups read the primary database when written back: the frame
// and event-decoration lookups always (entityDB), the version-images and model-data lookups for an id
// a recent write flagged (lagAwareDB). The primary is opened only when one of them is written back.
var PrimaryCaches = []string{MissImageFrames, MissEventDecorations, MissModelFrames, MissModelDecorations,
	MissVersionImages, MissModelData}

// WriteSet is the caches write-back writes, by WriteCaches label. Empty (or nil): none, and this
// service writes no cache entry, lock or metric hash.
type WriteSet map[string]bool

// AllWrites is every cache in WriteCaches.
func AllWrites() WriteSet {
	w := WriteSet{}
	for _, c := range WriteCaches {
		w[c] = true
	}
	return w
}

// Any reports whether any cache is written back.
func (w WriteSet) Any() bool {
	for _, on := range w {
		if on {
			return true
		}
	}
	return false
}

// NeedsPrimary reports whether a cache in w reads the primary when written back (PrimaryCaches).
func (w WriteSet) NeedsPrimary() bool {
	for _, c := range PrimaryCaches {
		if w[c] {
			return true
		}
	}
	return false
}

// Names are the caches in w, sorted (the startup log, the write counter's seeding).
func (w WriteSet) Names() []string {
	out := make([]string, 0, len(w))
	for c, on := range w {
		if on {
			out = append(out, c)
		}
	}
	slices.Sort(out)
	return out
}

// ParseWriteBack reads FEED_GO_CACHE_WRITEBACK: a comma-separated list of WriteCaches names (any
// case; spaces around a name and empty items ignored). Empty is none. Any other name is an error,
// the old bool form (true, false, 1, 0, …) included, so a typo or a stale value never silently leaves
// a cache unwritten or writes every cache.
func ParseWriteBack(raw string) (WriteSet, error) {
	set := WriteSet{}
	for _, name := range strings.Split(strings.ToLower(raw), ",") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if !slices.Contains(WriteCaches, name) {
			return nil, fmt.Errorf("FEED_GO_CACHE_WRITEBACK: unknown cache %q (known: %s)", name, strings.Join(WriteCaches, ","))
		}
		set[name] = true
	}
	return set, nil
}

// The results of one cache write (feed_go_cache_writes_total's `result`): written (the key holds
// the value now), nx_lost (a SET NX that found the key filled by another writer since the read, so
// nothing was written) or error (the command failed).
const (
	WriteWritten = "written"
	WriteNXLost  = "nx_lost"
	WriteError   = "error"
)

// WriteResults lists every write result, for seeding the counter.
var WriteResults = []string{WriteWritten, WriteNXLost, WriteError}

// writes reports whether cache is written back. A nil computation writes nothing.
func (c *MissCompute) writes(cache string) bool {
	return c != nil && c.WriteBack[cache]
}

// recordWrite counts one cache write (ObserveWrite) and logs it (WriteLog), with err, the command's
// error, on an error line. id 0 is a key with no per-id suffix (the official models). A nil
// computation records nothing.
func (c *MissCompute) recordWrite(ctx context.Context, cache, key string, id int, result string, err error) {
	if c == nil {
		return
	}
	if c.ObserveWrite != nil {
		c.ObserveWrite(cache, result, 1)
	}
	c.WriteLog.writeErr(ctx, cache, key, id, result, err)
}

// cacheWriteTimeout bounds one write-back round trip (the entries' SETs, the revalidation locks'
// release), which runs detached from the request (writeContext). A healthy pipeline answers in
// milliseconds, so the bound only bites on a sick store; it is the default system-store read bound
// (REDIS_SYS_READ_TIMEOUT_MS, 1000 ms), below go-redis's default 3 s read timeout, so it also caps how
// long a page that already failed (and falls back) waits on its writes. The writes run inline on the
// computing goroutine, so a request handler still returns only after them, and a draining shutdown
// waits for them like any other in-flight work.
const cacheWriteTimeout = time.Second

// writeContext is the context of a write-back round trip: ctx's values (its span, so the write stays
// in the request's trace) without its cancellation or deadline, bounded by the computation's
// WriteTimeout (0: cacheWriteTimeout). The writes come after the lookup has answered, so a request
// that ends meanwhile (a sibling lookup failed and the page falls back, the client left, the budget
// ran out) no longer cancels entries already computed; they still land at most the bound later.
func (c *MissCompute) writeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	d := cacheWriteTimeout
	if c != nil && c.WriteTimeout > 0 {
		d = c.WriteTimeout
	}
	return context.WithTimeout(context.WithoutCancel(ctx), d)
}

// WriteLog writes one `cache write` line per cache write (written, nx_lost or error), so the keys a
// bad write filled can be found and purged: the cache, the key, the id (when the key has one) and the
// result, never the value. Lines are rate-limited per (cache, result) by a token bucket of PerMinute
// lines (refilled continuously, burst PerMinute), as server.EventLog limits its lines; a line carries
// `suppressed`, the lines its key dropped since its last one. feed_go_cache_writes_total counts every
// write either way. Its keys are closed sets (WriteCaches × WriteResults), so the buckets are bounded.
type WriteLog struct {
	Log *slog.Logger
	// PerMinute is FEED_GO_CACHE_WRITE_LOG_PER_MIN: lines per (cache, result) per minute; 0 = none.
	PerMinute int
	// Now is the clock (nil = time.Now).
	Now func() time.Time

	mu      sync.Mutex
	buckets map[writeLogKey]*writeLogBucket
}

type writeLogKey struct{ cache, result string }

type writeLogBucket struct {
	tokens     float64
	last       time.Time
	suppressed int
}

// allow takes a token from k's bucket: whether the line is written and, when it is, how many lines
// k dropped since its last one (then reset).
func (l *WriteLog) allow(k writeLogKey) (bool, int) {
	now := time.Now()
	if l.Now != nil {
		now = l.Now()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets == nil {
		l.buckets = map[writeLogKey]*writeLogBucket{}
	}
	b := l.buckets[k]
	if b == nil {
		b = &writeLogBucket{tokens: float64(l.PerMinute), last: now}
		l.buckets[k] = b
	}
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = min(float64(l.PerMinute), b.tokens+elapsed.Minutes()*float64(l.PerMinute))
	}
	b.last = now
	if b.tokens < 1 {
		b.suppressed++
		return false, 0
	}
	b.tokens--
	n := b.suppressed
	b.suppressed = 0
	return true, n
}

// write logs one cache write, within the limit. A nil log, or PerMinute <= 0, writes nothing.
func (l *WriteLog) write(ctx context.Context, cache, key string, id int, result string) {
	l.writeErr(ctx, cache, key, id, result, nil)
}

// writeErr is write, an error line also carrying err's text (`err`), so a failed write can be told
// apart (a timeout, a refused connection, a cluster redirect) from the log alone. The text is the
// store client's error, never the value.
func (l *WriteLog) writeErr(ctx context.Context, cache, key string, id int, result string, err error) {
	if l == nil || l.Log == nil || l.PerMinute <= 0 {
		return
	}
	ok, suppressed := l.allow(writeLogKey{cache, result})
	if !ok {
		return
	}
	attrs := []any{"cache", cache, "key", key}
	if id != 0 {
		attrs = append(attrs, "id", id)
	}
	attrs = append(attrs, "result", result)
	if result == WriteError && err != nil {
		attrs = append(attrs, "err", err.Error())
	}
	if suppressed > 0 {
		attrs = append(attrs, "suppressed", suppressed)
	}
	l.Log.InfoContext(ctx, "cache write", attrs...)
}
