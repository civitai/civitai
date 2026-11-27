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
	MissModelDecorations, MissVersionImages, MissModelData, MissModelTags, MissOfficialModels, MissMetrics,
	MissCreatorMemberships, MissGallerySettings}

// PrimaryCaches are the caches whose lookups read the primary database when written back: the frame
// and event-decoration lookups always (entityDB), the version-images and model-data lookups for an id
// a recent write flagged (lagAwareDB), and the gallery settings always (the creator's hidden users;
// the model too when flagged). The primary is opened only when one of them is written back.
var PrimaryCaches = []string{MissImageFrames, MissEventDecorations, MissModelFrames, MissModelDecorations,
	MissVersionImages, MissModelData, MissGallerySettings}

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
	c.WriteLog.write(ctx, cache, key, id, result, err)
}

// cacheWriteTimeout bounds a request's write-back (WithWriteBudget): the WALL time during which at
// least one of its round trips (the entries' SETs, the revalidation locks' release), run detached
// from the request (writeContext), is in flight adds up to at most this much, so a request that writes
// several caches in sequence, or in parallel, still waits at most this long on all of them together
// (plus timer slack, and lockReleaseFloor per lock release made after it is spent). A healthy
// pipeline answers in milliseconds, so the bound only bites on a sick store; it is the default
// system-store read bound (REDIS_SYS_READ_TIMEOUT_MS, 1000 ms), below go-redis's default 3 s read
// timeout, so it also caps how long a page that already failed (and falls back) waits on its writes.
// The writes run inline on the computing goroutine, so a request handler still returns only after
// them, and a draining shutdown waits for them like any other in-flight work.
const cacheWriteTimeout = time.Second

// lockReleaseFloor is the least a revalidation lock's release gets, even once the request's write
// budget is spent. A lock left held is not harmless the way a lost cache write is: until its 10 s
// expiry every other revalidation of that entry serves stale, and a reader of the official models
// with no cached entry answers an empty list. A healthy DEL answers in milliseconds, and a request
// releases at most a handful of lock sets (one per stale-while-revalidate fill, one for the official
// models), so the floor adds at most a few times this past the budget.
const lockReleaseFloor = 50 * time.Millisecond

// writeBudgetKey keys a request's write-back budget (WithWriteBudget).
type writeBudgetKey struct{}

// writeBudget is the write-back time one request has used, charged by WALL time: only the intervals
// in which at least one of its round trips is in flight count, once each however many overlap (the
// page's parallel fills write concurrently). It is time spent writing, not a deadline from the first
// write: a request that computes for seconds between two healthy writes still has (nearly) all of
// it.
type writeBudget struct {
	mu       sync.Mutex
	used     time.Duration // the closed busy intervals
	inFlight int
	busy     time.Time // when inFlight last went 0 → 1
}

// begin opens one round trip at now and returns what is left of bound: bound less the closed busy
// intervals and the open one. Every round trip in flight was given a timeout of at most what was
// left when it began, and the budget has been draining 1:1 since (it has been busy throughout), so
// no round trip outlives the moment the budget runs out (a lock release's floor aside).
func (b *writeBudget) begin(bound time.Duration, now time.Time) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inFlight == 0 {
		b.busy = now
	}
	b.inFlight++
	return bound - b.used - now.Sub(b.busy)
}

// end closes one round trip at now; the last one in flight closes the busy interval.
func (b *writeBudget) end(now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.inFlight--
	if b.inFlight == 0 {
		b.used += now.Sub(b.busy)
	}
}

// WithWriteBudget marks ctx as one request: every write-back round trip under it draws on one budget
// (cacheWriteTimeout, or MissCompute.WriteTimeout) instead of each taking its own bound, so N
// round trips against a sick store wait about one bound in total, not N. The server installs it
// once per computation; on a ctx that already carries one it returns ctx unchanged. Without it each
// round trip is bounded on its own.
func WithWriteBudget(ctx context.Context) context.Context {
	if _, ok := ctx.Value(writeBudgetKey{}).(*writeBudget); ok {
		return ctx
	}
	return context.WithValue(ctx, writeBudgetKey{}, &writeBudget{})
}

// writeContext is the context of a cache write's round trip (writeContextFloor with no floor).
func (c *MissCompute) writeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return c.writeContextFloor(ctx, 0)
}

// writeContextFloor is the context of a write-back round trip: ctx's values (its span, so the write
// stays in the request's trace) without its cancellation or deadline, bounded by what is left of the
// request's write budget (WithWriteBudget; the computation's WriteTimeout, 0: cacheWriteTimeout) but
// never below floor, or by that bound alone on a ctx without a budget. The returned cancel ends the
// round trip (charging the budget); once the budget is spent a round trip with no floor fails at once
// (counted error). The writes come after the lookup has answered, so a request that ends meanwhile (a
// sibling lookup failed and the page falls back, the client left, the budget ran out) no longer
// cancels entries already computed.
func (c *MissCompute) writeContextFloor(ctx context.Context, floor time.Duration) (context.Context, context.CancelFunc) {
	d := cacheWriteTimeout
	if c != nil && c.WriteTimeout > 0 {
		d = c.WriteTimeout
	}
	detached := context.WithoutCancel(ctx)
	b, ok := ctx.Value(writeBudgetKey{}).(*writeBudget)
	if !ok {
		return context.WithTimeout(detached, max(d, floor))
	}
	left := b.begin(d, time.Now())
	wctx, cancel := context.WithTimeout(detached, max(left, floor, 0))
	var once sync.Once
	return wctx, func() {
		cancel()
		once.Do(func() { b.end(time.Now()) })
	}
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

// write logs one cache write, within the limit. An error line also carries err's text (`err`), so a
// failed write can be told apart (a timeout, a refused connection, a cluster redirect) from the log
// alone; the text is the store client's error, never the value. err is ignored for any other result. A
// nil log, or PerMinute <= 0, writes nothing.
func (l *WriteLog) write(ctx context.Context, cache, key string, id int, result string, err error) {
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
