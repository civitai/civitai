package hydrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/trace"
	"golang.org/x/sync/singleflight"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// The per-entity caches whose misses this service computes (the `cache` label of
// feed_go_cache_miss_total).
const (
	MissUserCosmetics    = "user-cosmetics"    // userCosmeticCache
	MissImageFrames      = "image-frames"      // cosmeticEntityCaches.Image
	MissEventDecorations = "event-decorations" // eventDecorationEntityCaches.Image
	MissTagIDs           = "tag-ids"           // tagIdsForImagesCache
	MissModelFrames      = "model-frames"      // cosmeticEntityCaches.Model (model.getAll)
	MissModelDecorations = "model-decorations" // eventDecorationEntityCaches.Model (model.getAll)
	MissVersionImages    = "version-images"    // imagesForModelVersionsCache (model.getAll)
	MissModelData        = "model-data"        // dataForModelsCache (model.getAll)
	MissModelTags        = "model-tags"        // modelTagCache (model.getAll)
	MissOfficialModels   = "official-models"   // getOfficialModelIds' fetchThroughCache entry (model.getAll)
	MissImageTags        = "image-tags"        // imageTagsCache (image.getInfinite with include 'tags'; never written)
)

// MissCaches lists every MissXxx label, for seeding the counter. A label that is also a page cache
// (PageCaches) or a model.getAll cache is the same string as that cache's probe label: the probe reads
// this list to tell a miss Go answers from one it falls back on (Sources.MissReason).
var MissCaches = []string{MissUserCosmetics, MissImageFrames, MissEventDecorations, MissImageMeta, MissTagIDs, MissModelFrames,
	MissModelDecorations, MissVersionImages, MissModelData, MissModelTags, MissOfficialModels, MissMetrics, MissImageTags}

// MissCompute is how hydration answers a miss on the per-entity caches Node fills on read: with the
// Node lookup's own query, batched once per page and cache, instead of falling back. A Sources
// without one falls back on those misses (FEED_GO_COMPUTE_MISSES=false).
//
// Each computed entry is built as the Node lookup builds it, packed exactly as Node's cache writer
// packs `{...result, cachedAt}` (or the `{[idKey]: id, notFound: true, cachedAt}` marker), and read
// back through the same decoder as a cache hit, so a computed miss and a later hit of what Node
// wrote for it hydrate identically. The image meta (meta.go) is the exception: its misses are
// neither written back nor kept in process (see memoized).
type MissCompute struct {
	// WriteBack (FEED_GO_CACHE_WRITEBACK, default none) is the caches whose computed entries are
	// written where, and as, the Node lookup writes them: same key, same msgpackr bytes, same expiry.
	// A cache not in it is never written (nor its locks taken). Only for a miss Node would write too
	// (no key, or an undecodable value; never inside a bust's debounce window or after a failed read),
	// and as SET NX: a key another writer filled since the read is never overwritten. A written-back
	// frame or event-decoration lookup (image and model) reads Primary, as Node's does (entityDB); the
	// user-cosmetics and tag-ids lookups read the replica either way, as Node's fetch does (dbRead); a
	// written-back version-images or model-data lookup reads Primary for a version or model a recent
	// write flagged, as Node's lag-aware reads do (lagAwareDB). The model-tags and official-models
	// lookups read the replica, as Node's fetch does (dbRead).
	WriteBack WriteSet
	// Primary is the primary database (DATABASE_URL, Node's dbWrite), required when WriteBack holds a
	// PrimaryCaches cache: the frame and event-decoration lookups write what they read, so they must
	// not read a lagging replica (an unequipped or withheld frame would be cached again for a day).
	Primary Querier
	// ObserveWrite counts cache writes (feed_go_cache_writes_total): cache is a WriteCaches label,
	// result one of WriteResults.
	ObserveWrite func(cache, result string, n int)
	// WriteLog logs each cache write, rate-limited (FEED_GO_CACHE_WRITE_LOG_PER_MIN); nil logs none.
	WriteLog *WriteLog
	// WriteTimeout bounds a request's write-back, run detached from the request (writeContext): the
	// total time its round trips wait under WithWriteBudget; 0 is cacheWriteTimeout. Tests shorten it.
	WriteTimeout time.Duration
	// FrameNegative mirrors the `frame-cache-negative` flag (FEED_GO_FRAME_CACHE_NEGATIVE): whether the
	// frame cache's notFound markers are live. Off, a marker is read as a miss and none is written,
	// as Node does while the flag is off. It is one flag for every entity's frame cache, so it
	// governs the model frames too.
	FrameNegative bool
	// TagGate is getImageTagGateIds (src/server/redis/image-tag-gate-ids.ts): every tag id a browsing
	// rule can hide content by (the blocked browsing tags and every addon's excludedTagIds, live and
	// default). The tag-ids lookup asks for it only when a row needs it (a Rekognition tag on an image
	// WD14 also tagged); an error, or no TagGate, then fails that lookup (tag-ids-miss-failed) where
	// Node, which rebuilds the blocked list from the database on a cache miss, would have had one.
	TagGate func(context.Context) (map[int]bool, error)
	// ClickHouse is the reader the image metric-hash misses are computed with (imagemetrics.go:
	// MetricService's populate, its query and, with MissMetrics written back, its locks and writes).
	// nil (no FEED_GO_CLICKHOUSE_HOST / FEED_GO_CLICKHOUSE_USERNAME) leaves those misses falling back
	// (`metrics-miss`).
	ClickHouse ClickHouse
	// MetricsTimeout bounds one page's metrics lookup (FEED_GO_CLICKHOUSE_TIMEOUT_MS), held to at most
	// metricsTimeoutMax (under Node's own budget); past it the page falls back (`metrics-miss-failed`).
	MetricsTimeout time.Duration
	// MetricsLockWait bounds the metrics lookup's wait on a populate lock another process holds
	// (FEED_GO_METRICS_LOCK_WAIT_MS; not positive: defaultMetricsLockWait, 500 ms). Past it the page
	// falls back (`metrics-miss-failed`). It bounds only that wait, never this lookup's own ClickHouse
	// read (MetricsTimeout's); a MetricsTimeout that ends first still ends the wait.
	MetricsLockWait time.Duration
	// waitSleep, when set (tests), replaces the timer between lock-wait reads (sleepLockWait): called
	// with the delay, it returns nil to read next or an error to end the wait.
	waitSleep func(ctx context.Context, d time.Duration) error
	// Tracer spans the waits on work this computation did not start (spans.go): a lookup that joins
	// another caller's in-flight one, and the metrics lookup's wait on another process's populate
	// lock. nil (tracing off) spans nothing; with it set, only under a recording span.
	Tracer trace.Tracer

	// flight coalesces concurrent lookups of one cache and id set; recent keeps answers for a few
	// seconds for a cache not written back (lookupShared).
	flight   singleflight.Group
	recentMu sync.Mutex
	recent   map[recentKey]recentEntry
	// lastSweep is when remember last scanned recent for expired entries; sweeps counts the scans
	// (tests read it).
	lastSweep time.Time
	sweeps    int
	// beforeFlight, when set (tests), runs just before a lookup joins or starts its flight.
	beforeFlight func()
	// afterFlight, when set (tests), runs just after a lookup's flight returns, before its answer is
	// read.
	afterFlight func()
	// Observe counts computed miss ids: cache is a MissXxx label, result "computed" or "error".
	Observe func(cache, result string, n int)
	// Now stamps `cachedAt` / `_populatedAt` (time.Now when nil).
	Now func() time.Time
}

// Recent lookups (caches not written back only): how long a computed entry answers repeat misses in
// this process, and how many entries are held at most.
const (
	recentTTL = 10 * time.Second
	recentMax = 50_000
)

// recentKey is one cache's id.
type recentKey struct {
	cache string
	id    int
}

// recentEntry is one id's lookup answer: its record, or found false (the lookup had no row).
type recentEntry struct {
	rec   jspack.Obj
	found bool
	until time.Time
}

// lookupShared is lookup(ids) with two in-process savings, so concurrent and repeated requests for
// the same cold ids stop repeating the same queries:
//
//   - concurrent calls for the same cache and id set share one lookup (singleflight; the first
//     caller's context runs it, so a joiner sees that caller's cancellation as its own error, and
//     a traced joiner gets a `miss lookup join` span for its wait, joinSpan);
//   - for a cache not written back, each answer (a record or "no row") is kept for recentTTL and
//     answers the next miss of that id without a query. For one written back nothing is kept: the
//     written cache entry answers repeats, and a kept answer could outlive the bust that should replace it. The
//     image meta is never kept either (memoized): Node keeps no per-pod copy of it, so a meta its
//     owner just hid is never served again, and its multi-KB values would crowd the cap.
//
// The records are shared between callers and must be treated as read-only.
func (c *MissCompute) lookupShared(ctx context.Context, cache string, ids []int,
	lookup func(context.Context, []int) (map[int]jspack.Obj, error)) (map[int]jspack.Obj, error) {
	out := make(map[int]jspack.Obj, len(ids))
	todo := ids
	if c.memoized(cache) {
		todo = c.fromRecent(cache, ids, out)
	}
	if len(todo) == 0 {
		return out, nil
	}
	sorted := slices.Clone(todo)
	slices.Sort(sorted)
	parts := make([]string, len(sorted))
	for i, id := range sorted {
		parts[i] = strconv.Itoa(id)
	}
	key := cache + ":" + strings.Join(parts, ",")
	if c.beforeFlight != nil {
		c.beforeFlight()
	}
	var v any
	var err error
	if c.traced(ctx) {
		v, err = c.tracedFlight(ctx, key, cache, todo, lookup)
	} else {
		v, err, _ = c.flight.Do(key, func() (any, error) { return c.flightLookup(ctx, cache, todo, lookup) })
	}
	if c.afterFlight != nil {
		c.afterFlight()
	}
	if err != nil {
		return nil, err
	}
	records, _ := v.(map[int]jspack.Obj)
	for _, id := range todo {
		if rec, ok := records[id]; ok {
			out[id] = rec
		}
	}
	return out, nil
}

// tracedFlight is the flight of a traced caller (c.traced): the same Do, noting whether this caller
// ran the flight. One that joined another caller's has spent the time waiting on a lookup spanned
// on THAT caller's context, so it gets a `miss lookup join` span of its own (joinSpan), from before
// it reached the flight. Kept apart from the untraced path so that path's closure is unchanged.
func (c *MissCompute) tracedFlight(ctx context.Context, key, cache string, ids []int,
	lookup func(context.Context, []int) (map[int]jspack.Obj, error)) (any, error) {
	start := time.Now()
	led := false
	v, err, _ := c.flight.Do(key, func() (any, error) {
		led = true
		return c.flightLookup(ctx, cache, ids, lookup)
	})
	if !led {
		c.joinSpan(ctx, cache, start, err)
	}
	return v, err
}

// flightLookup is the body of one flight: it runs inside singleflight, so a caller that arrives
// while it runs joins it. Both memo steps belong here, not around Do. singleflight drops the flight
// from its map BEFORE Do returns, so an answer remembered after Do leaves a window in which a new
// caller finds neither the flight nor the kept answer and queries again. Remembering inside the
// flight closes that window. A caller that missed recent and then reached Do just after an earlier
// flight ended starts a new flight, and the recheck here answers it from what that flight kept.
func (c *MissCompute) flightLookup(ctx context.Context, cache string, ids []int,
	lookup func(context.Context, []int) (map[int]jspack.Obj, error)) (map[int]jspack.Obj, error) {
	if !c.memoized(cache) {
		return lookup(ctx, ids)
	}
	kept := make(map[int]jspack.Obj, len(ids))
	rest := c.fromRecent(cache, ids, kept)
	if len(rest) == 0 {
		return kept, nil
	}
	records, err := lookup(ctx, rest)
	if err != nil {
		return nil, err
	}
	c.remember(cache, rest, records)
	if len(kept) == 0 {
		return records, nil
	}
	for id, rec := range records {
		kept[id] = rec
	}
	return kept, nil
}

// memoized is whether lookupShared keeps cache's answers in recent: for a cache not written back,
// except the image meta (imageMetaCache has no per-pod L1 in Node, deliberately: a hideMeta flip
// must not leave the old prompt served from a process's copy). The tag ids, the model frames, the
// model decorations and the version showcases are kept: none depends on the viewer (the showcase
// lookup reads no user, and the per-viewer image filter runs on every read), Node keeps tag ids in a
// per-pod L1 far longer than recentTTL, and a model frame or decoration is the same lookup the image
// ones keep.
func (c *MissCompute) memoized(cache string) bool {
	return !c.writes(cache) && cache != MissImageMeta
}

// fromRecent adds the kept, unexpired answers of ids to out and returns the ids it could not answer.
func (c *MissCompute) fromRecent(cache string, ids []int, out map[int]jspack.Obj) []int {
	now := c.now()
	c.recentMu.Lock()
	defer c.recentMu.Unlock()
	var todo []int
	for _, id := range ids {
		e, ok := c.recent[recentKey{cache, id}]
		if !ok || !now.Before(e.until) {
			todo = append(todo, id)
			continue
		}
		if e.found {
			out[id] = e.rec
		}
	}
	return todo
}

// recentSweepEvery is the least time between two scans of recent for expired entries.
const recentSweepEvery = time.Second

// remember keeps the answers for ids. Near recentMax the expired entries are dropped first, by a
// scan of the whole map that runs at most once per recentSweepEvery: a map full of live entries is
// not rescanned on every call (each scan holds recentMu and would free nothing). An answer that does
// not fit is not kept, so while the map stays full new ids are skipped until a later sweep frees
// room; an id already held is refreshed.
func (c *MissCompute) remember(cache string, ids []int, records map[int]jspack.Obj) {
	now := c.now()
	until := now.Add(recentTTL)
	c.recentMu.Lock()
	defer c.recentMu.Unlock()
	if c.recent == nil {
		c.recent = map[recentKey]recentEntry{}
	}
	if len(c.recent)+len(ids) > recentMax && (c.lastSweep.IsZero() || now.Sub(c.lastSweep) >= recentSweepEvery) {
		c.lastSweep = now
		c.sweeps++
		for k, e := range c.recent {
			if !now.Before(e.until) {
				delete(c.recent, k)
			}
		}
	}
	for _, id := range ids {
		if _, held := c.recent[recentKey{cache, id}]; !held && len(c.recent) >= recentMax {
			continue
		}
		rec, found := records[id]
		c.recent[recentKey{cache, id}] = recentEntry{rec: rec, found: found, until: until}
	}
}

func (c *MissCompute) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *MissCompute) observe(cache, result string, n int) {
	if c.Observe != nil && n > 0 {
		c.Observe(cache, result, n)
	}
}

// entityDB is the database the frame and event-decoration lookups (image and model) of cache read.
// Node reads the primary (dbWrite, src/server/redis/caches.ts) and caches what it reads for a day.
// With cache written back this service writes what it reads too, so it reads the primary as well;
// otherwise nothing it reads is cached, and the replica's lag only affects this one answer.
func (s *Sources) entityDB(cache string) (Querier, error) {
	if !s.Compute.writes(cache) {
		return s.Replica, nil
	}
	if s.Compute.Primary == nil {
		return nil, errors.New("write-back needs the primary database")
	}
	return s.Compute.Primary, nil
}

// lookupSpec is one createCachedObject cache's write shape (src/server/redis/caches.ts).
type lookupSpec struct {
	cache  string // MissXxx label
	reason string // the cache's miss fallback reason; a failed computation is `<reason>-failed`
	key    string
	idKey  string
	// ttl is a value's EX: resolveCacheExpiry(ttl, staleWhileRevalidate, staleWhileRevalidateTtl)
	// (packages/civitai-redis/src/cached-array.ts): `ttl` where staleWhileRevalidate is off,
	// `ttl + (staleWhileRevalidateTtl ?? ttl)` where it is on.
	ttl time.Duration
	// notFoundTTL is a notFound marker's EX (`notFoundTtl ?? EX`).
	notFoundTTL time.Duration
	// probeLooksUp: under a Go-first probe (WithPresence) the miss is looked up, read-only, instead of
	// answered as "no entry", because its answer decides which rows the page keeps (a model with no
	// showcase image is dropped, so "no entry" would page on past where a serve stops).
	probeLooksUp bool
}

// tagIDsTTL is tagIdsForImagesCache's ttl: an entry whose cachedAt is older is stale, and Node's
// fetch revalidates it (staleWhileRevalidate is on) — a bust (invalidate) backdates cachedAt so it
// is. The tag-ids reads mark entries past it Stale (fillTagIDs).
const tagIDsTTL = 8 * time.Hour

// tagIDsEX is tagIdsForImagesCache's EX: the 8h ttl plus the 1h staleWhileRevalidateTtl, so 9h; no
// notFoundTtl, so its markers get the same.
const tagIDsEX = tagIDsTTL + time.Hour

// versionImagesTTL is imagesForModelVersionsCache's ttl (CacheTTL.day): staleWhileRevalidate is on (the
// default), so an entry whose cachedAt is older is revalidated by Node's fetch, as the tag ids are.
const versionImagesTTL = ttlDay

// versionImagesEX is its EX: resolveCacheExpiry(day, true, undefined) = the ttl twice. Its markers
// get notFoundTtl, CacheTTL.xs (a minute): an empty answer read between publish and ingestion must not
// keep the model out of feeds for long.
const (
	versionImagesEX         = 2 * versionImagesTTL
	versionImagesNotFoundEX = time.Minute
)

var (
	// userCosmeticCache: ttl a day, cacheNotFound (default) on, no notFoundTtl.
	userCosmeticsSpec = lookupSpec{cache: MissUserCosmetics, reason: "user-cosmetics-miss", key: KeyUserCosmetics, idKey: "userId", ttl: ttlDay, notFoundTTL: ttlDay}
	// cosmeticEntityCaches.Image: ttl a day, notFoundTtl an hour, cacheNotFound the flag.
	frameSpec = lookupSpec{cache: MissImageFrames, reason: "image-frame-miss", key: KeyImageFrames, idKey: "equippedToId", ttl: ttlDay, notFoundTTL: time.Hour}
	// cosmeticEntityCaches.Model: the same createCachedObject options as the Image one.
	modelFrameSpec = lookupSpec{cache: MissModelFrames, reason: "model-frame-miss", key: KeyModelFrames, idKey: "equippedToId", ttl: ttlDay, notFoundTTL: time.Hour}
	// eventDecorationEntityCaches.Image: ttl a day, notFoundTtl an hour, cacheNotFound on.
	eventSpec = lookupSpec{cache: MissEventDecorations, reason: "event-decoration-miss", key: KeyImageEvents, idKey: "equippedToId", ttl: ttlDay, notFoundTTL: time.Hour}
	// eventDecorationEntityCaches.Model: the same createCachedObject options as the Image one.
	modelEventSpec = lookupSpec{cache: MissModelDecorations, reason: "model-decoration-miss", key: KeyModelEvents, idKey: "equippedToId", ttl: ttlDay, notFoundTTL: time.Hour}
	// tagIdsForImagesCache: see tagIDsEX; cacheNotFound (default) on.
	tagIDsSpec = lookupSpec{cache: MissTagIDs, reason: "tag-ids-miss", key: KeyTagIDs, idKey: "imageId", ttl: tagIDsEX, notFoundTTL: tagIDsEX}
	// imagesForModelVersionsCache: see versionImagesEX; cacheNotFound (default) on.
	versionImagesSpec = lookupSpec{cache: MissVersionImages, reason: "model-images-miss", key: KeyVersionImages, idKey: "modelVersionId",
		ttl: versionImagesEX, notFoundTTL: versionImagesNotFoundEX, probeLooksUp: true}
)

// missSpecs are the computed caches' write shapes, one per cache fill runs for; their reasons are
// the fallbacks those misses raise without a computation (Sources.MissReason).
var missSpecs = []lookupSpec{userCosmeticsSpec, frameSpec, modelFrameSpec, eventSpec, modelEventSpec, tagIDsSpec, versionImagesSpec,
	modelDataSpec, modelTagsSpec, officialModelsSpec, imageTagsSpec}

// specReason is the fallback reason of the named cache's lookup spec ("" for none).
func specReason(cache string) string {
	for _, sp := range missSpecs {
		if sp.cache == cache {
			return sp.reason
		}
	}
	return ""
}

// packedWrite is one cache write: SET key val EX ttl NX, or without NX when overwrite (a stale
// entry revalidated under its lock, as Node's refill overwrites it). cache and id name it in the
// write counter and log (id 0: a key with no per-id suffix).
type packedWrite struct {
	cache     string
	id        int
	key       string
	val       []byte
	ttl       time.Duration
	overwrite bool
}

// fill answers the ids of ids that got does not, with lookup (the Node lookupFn, batched: one call
// for every miss), adding each answer to got as the entry Node would have cached: the record, or a
// notFound marker for an id the lookup found nothing for. writable says which misses Node would
// write back (PackedRead.read); writeNotFound whether the cache writes markers; replace which
// misses are stale entries being revalidated (revalidateStale): their value is written without NX,
// as Node's refill overwrites the stale entry, while their marker keeps NX (Node's marker write is
// always NX, so it never replaces the stale value).
func (s *Sources) fill(ctx context.Context, spec lookupSpec, ids []int, got map[int]Entry, writable map[int]bool, writeNotFound bool,
	replace map[int]bool, lookup func(context.Context, []int) (map[int]jspack.Obj, error)) error {
	miss := Missing(ids, got)
	if len(miss) == 0 {
		return nil
	}
	p := presenceOf(ctx)
	if p != nil {
		// A Go-first probe running a serving path (model.getAll): the miss is one Go answers, so it is
		// recorded, with its one lookup query, and answered as "no entry" without being looked up,
		// unless its answer decides the page's rows (probeLooksUp): then it is looked up, on the
		// replica, outside the shared flights and the memo. The probe never writes, and is not counted
		// in Observe.
		p.recordComputed(spec.cache, len(miss))
		if !spec.probeLooksUp {
			for _, id := range miss {
				got[id] = Entry{NotFound: true}
			}
			return nil
		}
	}
	c := s.Compute
	var records map[int]jspack.Obj
	var err error
	if p != nil {
		records, err = lookup(ctx, miss)
	} else {
		records, err = c.lookupShared(ctx, spec.cache, miss, lookup)
	}
	if err != nil {
		if p == nil {
			c.observe(spec.cache, "error", len(miss))
		}
		return fallback.Wrap(spec.reason+"-failed", err)
	}
	now := c.now()
	var writes []packedWrite
	for _, id := range miss {
		rec, found := records[id]
		val, ttl := jspack.O(spec.idKey, id, "notFound", true, "cachedAt", now), spec.notFoundTTL
		if found {
			val, ttl = append(append(make(jspack.Obj, 0, len(rec)+1), rec...), jspack.KV{K: "cachedAt", V: now}), spec.ttl
		}
		b := jspack.Pack(val)
		e, st := decodeBytes(b, 0, now)
		if st != stateEntry {
			return fmt.Errorf("%s: a computed entry for %d does not decode", spec.cache, id)
		}
		got[id] = e
		if p == nil && c.writes(spec.cache) && (writable[id] || replace[id]) && (found || writeNotFound) {
			writes = append(writes, packedWrite{cache: spec.cache, id: id, key: s.Packed.key(spec.key, id), val: b, ttl: ttl,
				overwrite: found && replace[id]})
		}
	}
	if p != nil {
		return nil
	}
	c.observe(spec.cache, "computed", len(miss))
	s.writePacked(ctx, writes)
	return nil
}

// fillUserCosmetics computes the user-cosmetics misses of got (userCosmeticCache.fetch's lookup); a
// no-op without s.Compute (the miss then falls back in userCosmeticsFrom).
func (s *Sources) fillUserCosmetics(ctx context.Context, users []int, got map[int]Entry, writable map[int]bool) error {
	if s.Compute == nil {
		return nil
	}
	return s.fill(ctx, userCosmeticsSpec, users, got, writable, true, nil, s.lookupUserCosmetics)
}

// fillFrames computes the frame misses of got (cosmeticEntityCaches.Image.fetch's lookup). While
// frame-cache-negative is off (FrameNegative false) a notFound marker is a miss too, as Node's fetch
// ignores markers then, and none is written; an id whose marker was read is never written (it is
// not writable: the marker holds the key, and a write is SET NX).
func (s *Sources) fillFrames(ctx context.Context, images []int, got map[int]Entry, writable map[int]bool) error {
	return s.fillEntityFrames(ctx, frameSpec, s.lookupImageFrames, images, got, writable)
}

// fillModelFrames is fillFrames for the models' frames (cosmeticEntityCaches.Model.fetch's lookup,
// model.getAll): the same lookup over `equippedToType = 'Model'`, the same frame-cache-negative rule.
func (s *Sources) fillModelFrames(ctx context.Context, models []int, got map[int]Entry, writable map[int]bool) error {
	return s.fillEntityFrames(ctx, modelFrameSpec, s.lookupModelFrames, models, got, writable)
}

func (s *Sources) fillEntityFrames(ctx context.Context, spec lookupSpec, lookup func(context.Context, []int) (map[int]jspack.Obj, error),
	ids []int, got map[int]Entry, writable map[int]bool) error {
	if s.Compute == nil {
		return nil
	}
	if !s.Compute.FrameNegative {
		for id, e := range got {
			if e.NotFound {
				delete(got, id)
			}
		}
	}
	return s.fill(ctx, spec, ids, got, writable, s.Compute.FrameNegative, nil, lookup)
}

// fillTagIDs computes the tag-ids misses of got (tagIdsForImagesCache.fetch's lookup), got read with
// tagIDsTTL; a no-op without s.Compute (a miss then falls back in tagIDsFrom, a stale entry is
// served). A stale entry is revalidated as Node's fetch revalidates it (revalidateStale).
func (s *Sources) fillTagIDs(ctx context.Context, images []int, got map[int]Entry, writable map[int]bool) error {
	return s.fillSWR(ctx, tagIDsSpec, images, got, writable, s.lookupTagIDs)
}

// fillVersionImages computes the version-images misses of got (imagesForModelVersionsCache.fetch's
// lookup), got read with versionImagesTTL; a no-op without s.Compute (a miss then falls back in
// VersionImages, a stale entry is served). A stale entry is revalidated as the tag ids' are.
func (s *Sources) fillVersionImages(ctx context.Context, versions []int, got map[int]Entry, writable map[int]bool) error {
	return s.fillSWR(ctx, versionImagesSpec, versions, got, writable, s.lookupVersionImages)
}

// fillSWR is fill for a staleWhileRevalidate cache (markers written): the stale entries of got are
// revalidated first (revalidateStale), and the locks taken released after the writes.
func (s *Sources) fillSWR(ctx context.Context, spec lookupSpec, ids []int, got map[int]Entry, writable map[int]bool,
	lookup func(context.Context, []int) (map[int]jspack.Obj, error)) error {
	if s.Compute == nil {
		return nil
	}
	replace, locks := s.revalidateStale(ctx, spec, got)
	if err := s.fill(ctx, spec, ids, got, writable, true, replace, lookup); err != nil {
		return err
	}
	s.releaseLocks(ctx, locks)
	return nil
}

// tagIDsLockKey is fetch's revalidation lock for one tag-ids entry (lockKey).
func (s *Sources) tagIDsLockKey(id int) string { return s.lockKey(KeyTagIDs, id) }

// lockKey is fetch's revalidation lock for one entry of the cache at key,
// `${REDIS_KEYS.CACHE_LOCKS}:${key}:${id}`: both halves namespace-prefixed (applyCacheKeyPrefix
// prefixes every leaf of the key table).
func (s *Sources) lockKey(key string, id int) string {
	return s.Packed.Prefix + "cache-lock:" + s.Packed.key(key, id)
}

// cacheLockTTL is the revalidation lock's EX (setNxKeepTtlWithEx(…, '1', 10)).
const cacheLockTTL = 10 * time.Second

// revalidateStale is fetch's stale-while-revalidate step over the answer got of spec's cache (Stale
// entries, read with its ttl), removing from got the stale ids to look up again:
//
//   - the cache written back, as Node: each stale id takes the revalidation lock Node's fetch takes (SET NX EX
//     10); an id whose lock is held elsewhere, or whose lock write failed, keeps its stale entry
//     (served, as Node serves it), and one whose lock is taken is looked up and its value written
//     over the stale one (replace). The locks taken are returned for releaseLocks;
//   - the cache not written back: every stale id is looked up (nothing is written, so no lock guards a write),
//     so a busted entry is never served past its backdated stamp;
//   - under a Go-first probe (WithPresence): every stale id is a miss (recorded by fill), no lock.
func (s *Sources) revalidateStale(ctx context.Context, spec lookupSpec, got map[int]Entry) (map[int]bool, []string) {
	key := spec.key
	stale := make([]int, 0, len(got))
	for id, e := range got {
		if e.Stale {
			stale = append(stale, id)
		}
	}
	if len(stale) == 0 {
		return nil, nil
	}
	if presenceOf(ctx) != nil || !s.Compute.writes(spec.cache) || s.Packed.Redis == nil {
		for _, id := range stale {
			delete(got, id)
		}
		return nil, nil
	}
	slices.Sort(stale)
	cmds := make([]*redis.BoolCmd, len(stale))
	_, _ = s.Packed.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, id := range stale {
			cmds[i] = p.SetNX(ctx, s.lockKey(key, id), "1", cacheLockTTL)
		}
		return nil
	})
	replace := map[int]bool{}
	var locks []string
	for i, id := range stale {
		if ok, err := cmds[i].Result(); err != nil || !ok {
			continue // held by another revalidation, or the lock write failed: serve the stale entry
		}
		delete(got, id)
		replace[id] = true
		locks = append(locks, s.lockKey(key, id))
	}
	return replace, locks
}

// releaseLocks deletes the revalidation locks taken, best effort, after the writes (Node deletes
// them after its write; a failed delete leaves the lock to its 10 s expiry). A failed lookup leaves
// them to expire, as Node's does. Like the writes it follows, it runs detached from the request
// (writeContextFloor): a request that ended after its writes still releases its locks, and one whose
// write budget is spent still gets lockReleaseFloor for the release (a lock left held keeps others
// serving stale, or the official models empty, until it expires).
func (s *Sources) releaseLocks(ctx context.Context, locks []string) {
	if len(locks) == 0 {
		return
	}
	ctx, cancel := s.Compute.writeContextFloor(ctx, lockReleaseFloor)
	defer cancel()
	// One DEL per key: the locks of different ids live in different cluster slots.
	_, _ = s.Packed.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, k := range locks {
			p.Del(ctx, k)
		}
		return nil
	})
}

// fillEvents computes the event-decoration misses of got (eventDecorationEntityCaches.Image.fetch's
// lookup); a no-op without s.Compute.
func (s *Sources) fillEvents(ctx context.Context, images []int, got map[int]Entry, writable map[int]bool) error {
	if s.Compute == nil {
		return nil
	}
	return s.fill(ctx, eventSpec, images, got, writable, true, nil, s.lookupImageEvents)
}

// fillModelEvents is fillEvents for the models' decorations (eventDecorationEntityCaches.Model.fetch's
// lookup, model.getAll): the same lookup over `equippedToType = 'Model'`; a no-op without s.Compute.
func (s *Sources) fillModelEvents(ctx context.Context, models []int, got map[int]Entry, writable map[int]bool) error {
	if s.Compute == nil {
		return nil
	}
	return s.fill(ctx, modelEventSpec, models, got, writable, true, nil, s.lookupModelEvents)
}

// writePacked sends writes in one pipeline, best effort: Node swallows a failed cache write too (the
// lookup has already answered). The pipeline runs detached from the request, under its own bound
// (writeContext), so a request that ends first does not cancel entries already computed. Each write
// is counted and logged with its result (recordWrite), an error with its text.
func (s *Sources) writePacked(ctx context.Context, writes []packedWrite) {
	if len(writes) == 0 || s.Packed.Redis == nil {
		return
	}
	wctx, cancel := s.Compute.writeContext(ctx)
	defer cancel()
	cmds := make([]redis.Cmder, len(writes))
	_, _ = s.Packed.Redis.Pipelined(wctx, func(p redis.Pipeliner) error {
		for i, w := range writes {
			if w.overwrite {
				cmds[i] = p.Set(wctx, w.key, w.val, w.ttl)
				continue
			}
			cmds[i] = p.SetNX(wctx, w.key, w.val, w.ttl)
		}
		return nil
	})
	for i, w := range writes {
		s.Compute.recordWrite(ctx, w.cache, w.key, w.id, packedWriteResult(cmds[i]), cmds[i].Err())
	}
}

// packedWriteResult is one SET's result: error when it failed, nx_lost for a SET NX that found the key
// held (go-redis answers that as false, or as redis.Nil), written otherwise.
func packedWriteResult(cmd redis.Cmder) string {
	nx, isNX := cmd.(*redis.BoolCmd)
	err := cmd.Err()
	switch {
	case isNX && errors.Is(err, redis.Nil):
		return WriteNXLost
	case err != nil:
		return WriteError
	case isNX && !nx.Val():
		return WriteNXLost
	}
	return WriteWritten
}

// jsonColumn is a json/jsonb column selected as text (`::text`), as Prisma hands it to the Node code.
func jsonColumn(v any) (any, error) {
	switch t := v.(type) {
	case nil:
		return nil, nil
	case string:
		return jspack.FromJSON(t)
	case []byte:
		return jspack.FromJSON(string(t))
	}
	return nil, fmt.Errorf("json column: unexpected %T", v)
}

// sqlUserCosmetics is userCosmeticCache's lookupFn (src/server/redis/caches.ts): the userCosmetic
// findMany `{userId: {in}, equippedAt: {not: null}, equippedToId: null}` selecting userId, cosmeticId,
// data, on the replica (dbRead), as Node reads it. Postgres plans `IN (…)` as `= ANY(…)`.
const sqlUserCosmetics = `SELECT "userId", "cosmeticId", "data"::text AS "data" FROM "UserCosmetic" WHERE "userId" = ANY($1::int[]) AND "equippedAt" IS NOT NULL AND "equippedToId" IS NULL`

// lookupUserCosmetics is userCosmeticCache's lookupFn: each user's equipped cosmetics, in row order,
// without the withheld creator cosmetics; a user with none is absent.
func (s *Sources) lookupUserCosmetics(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlUserCosmetics, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	type equipped struct {
		userID, cosmeticID int
		data               any
	}
	list := make([]equipped, 0, len(maps))
	cids := make([]int, 0, len(maps))
	for _, m := range maps {
		uid, _ := Int(m["userId"])
		cid, _ := Int(m["cosmeticId"])
		data, err := jsonColumn(m["data"])
		if err != nil {
			return nil, err
		}
		list = append(list, equipped{uid, cid, data})
		cids = append(cids, cid)
	}
	withheld, err := s.withheldCosmeticIDs(ctx, s.Replica, cids)
	if err != nil {
		return nil, err
	}
	order := []int{}
	perUser := map[int][]any{}
	for _, e := range list {
		if withheld[e.cosmeticID] {
			continue
		}
		if _, ok := perUser[e.userID]; !ok {
			order = append(order, e.userID)
		}
		perUser[e.userID] = append(perUser[e.userID], jspack.O("cosmeticId", e.cosmeticID, "data", e.data))
	}
	out := make(map[int]jspack.Obj, len(order))
	for _, uid := range order {
		out[uid] = jspack.O("userId", uid, "cosmetics", perUser[uid])
	}
	return out, nil
}

// sqlImageFrames and sqlModelFrames are cosmeticEntityCaches.Image's and .Model's lookupFn query
// (one query, `equippedToType` the entity), on entityDB (Node: the primary).
const (
	sqlImageFrames = `SELECT uc."cosmeticId", uc."equippedToId", uc."data"::text AS "userData", c."createdById"
		FROM "UserCosmetic" uc
		JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
		WHERE uc."equippedToId" = ANY($1::int[])
		  AND uc."equippedToType" = 'Image'::"CosmeticEntity"
		  AND jsonb_typeof(c.data->'event') IS DISTINCT FROM 'string'`
	sqlModelFrames = `SELECT uc."cosmeticId", uc."equippedToId", uc."data"::text AS "userData", c."createdById"
		FROM "UserCosmetic" uc
		JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
		WHERE uc."equippedToId" = ANY($1::int[])
		  AND uc."equippedToType" = 'Model'::"CosmeticEntity"
		  AND jsonb_typeof(c.data->'event') IS DISTINCT FROM 'string'`
)

// lookupImageFrames is cosmeticEntityCaches.Image's lookupFn: per image, the raw frame row
// `{cosmeticId, equippedToId, userData}` (the last row per image, as Object.fromEntries keeps it),
// without frames whose creator cosmetic is withheld. The cosmetic join is the cache's appendFn,
// which runs on every read (joinFrames).
func (s *Sources) lookupImageFrames(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	return s.lookupEntityFrames(ctx, MissImageFrames, sqlImageFrames, ids)
}

// lookupModelFrames is cosmeticEntityCaches.Model's lookupFn: lookupImageFrames over the models (the
// join is modelCosmetics').
func (s *Sources) lookupModelFrames(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	return s.lookupEntityFrames(ctx, MissModelFrames, sqlModelFrames, ids)
}

func (s *Sources) lookupEntityFrames(ctx context.Context, cache, sql string, ids []int) (map[int]jspack.Obj, error) {
	db, err := s.entityDB(cache)
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, sql, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	type frame struct {
		imageID, cosmeticID int
		userData            any
	}
	list := make([]frame, 0, len(maps))
	var created []int // only creator cosmetics can be withheld
	for _, m := range maps {
		cid, _ := Int(m["cosmeticId"])
		eid, _ := Int(m["equippedToId"])
		ud, err := jsonColumn(m["userData"])
		if err != nil {
			return nil, err
		}
		list = append(list, frame{eid, cid, ud})
		if m["createdById"] != nil {
			created = append(created, cid)
		}
	}
	withheld, err := s.withheldCosmeticIDs(ctx, db, created) // Node: getWithheldCosmeticIds(…, dbWrite)
	if err != nil {
		return nil, err
	}
	out := map[int]jspack.Obj{}
	for _, f := range list {
		if withheld[f.cosmeticID] {
			continue
		}
		out[f.imageID] = jspack.O("cosmeticId", f.cosmeticID, "equippedToId", f.imageID, "userData", f.userData)
	}
	return out, nil
}

// sqlImageTagRows is getImageTagRows (src/server/redis/image-tag-rows.ts), tagIdsForImagesCache's
// lookupFn query, on the replica (the fetch's lookupFn(ids) reads dbRead), its enum column as text.
const sqlImageTagRows = `SELECT "imageId", "source"::text AS "source", "tagId" FROM "TagsOnImageDetails" WHERE "imageId" = ANY($1::int[]) AND "disabled" = false`

// alwaysIncludeTags is `[...styleTags, ...subjectTags]` (src/libs/tags.ts).
var alwaysIncludeTags = map[string]bool{"anime": true, "cartoon": true, "comics": true, "manga": true,
	"man": true, "woman": true, "men": true, "women": true}

// lookupTagIDs is tagIdsForImagesCache's lookupFn: per image with at least one enabled tag row,
// `{imageId, tags}` with the tag ids in row order, each kept when tagCache knows the tag, and a
// Rekognition label on an image WD14 also tagged kept only when it is a Moderation tag, nameless,
// one of alwaysIncludeTags, or a tag a browsing rule can hide content by (TagGate). An image whose
// tags are all dropped is `{imageId, tags: []}`; one with no row is absent.
func (s *Sources) lookupTagIDs(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlImageTagRows, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	type tagRow struct {
		imageID, tagID int
		source         string
	}
	list := make([]tagRow, 0, len(maps))
	tagIDs := make([]int, 0, len(maps))
	hasWD := map[int]bool{}
	for _, m := range maps {
		iid, ok := Int(m["imageId"])
		tid, ok2 := Int(m["tagId"])
		if !ok || !ok2 {
			return nil, fmt.Errorf("tag ids: row %v", m)
		}
		source, _ := m["source"].(string)
		list = append(list, tagRow{iid, tid, source})
		tagIDs = append(tagIDs, tid)
		if source == "WD14" {
			hasWD[iid] = true
		}
	}
	tags, err := s.tagRecords(ctx, Unique(tagIDs))
	if err != nil {
		return nil, err
	}
	var gate map[int]bool
	gateRead := false
	order := []int{}
	perImage := map[int][]any{}
	for _, r := range list {
		if _, seen := perImage[r.imageID]; !seen {
			order = append(order, r.imageID)
			perImage[r.imageID] = []any{}
		}
		tag, ok := tags[r.tagID]
		if !ok {
			continue
		}
		if r.source == "Rekognition" && hasWD[r.imageID] && tag.typ != "Moderation" && tag.name != "" && !alwaysIncludeTags[tag.name] {
			if !gateRead {
				if gate, err = s.Compute.tagGate(ctx); err != nil {
					return nil, err
				}
				gateRead = true
			}
			if !gate[r.tagID] {
				continue
			}
		}
		perImage[r.imageID] = append(perImage[r.imageID], r.tagID)
	}
	out := make(map[int]jspack.Obj, len(order))
	for _, id := range order {
		out[id] = jspack.O("imageId", id, "tags", perImage[id])
	}
	return out, nil
}

// tagGate is TagGate's answer; no TagGate is an error (the lookup cannot decide the row).
func (c *MissCompute) tagGate(ctx context.Context) (map[int]bool, error) {
	if c.TagGate == nil {
		return nil, errors.New("tag ids: no browsing tag gate configured")
	}
	gate, err := c.TagGate(ctx)
	if err != nil {
		return nil, fmt.Errorf("tag ids: browsing tag gate: %w", err)
	}
	return gate, nil
}

// tagRecord is the part of a tagCache record the tag-ids lookup reads.
type tagRecord struct{ name, typ string }

// sqlTagRecords is tagCache's lookupFn (the tag findMany by id) on the replica, the columns the
// tag-ids lookup reads, its enum column as text.
const sqlTagRecords = `SELECT id, name::text AS name, type::text AS type FROM "Tag" WHERE id = ANY($1::int[])`

// tagRecords is tagCache.fetch(ids) as the tag-ids lookup reads it: each tag's name and type, from
// the basic-tags cache (stale entries served; a notFound marker absent), the other ids from the
// replica. Nothing is written back (the shared tag cache is never written by this service).
func (s *Sources) tagRecords(ctx context.Context, ids []int) (map[int]tagRecord, error) {
	out := map[int]tagRecord{}
	if len(ids) == 0 {
		return out, nil
	}
	b := NewBatch()
	read := s.Packed.Queue(b, KeyBasicTags, ids, ttlDay)
	b.Exec(ctx)
	got := read.Entries()
	for id, e := range got {
		if e.NotFound {
			continue
		}
		name, _ := e.Value["name"].(string)
		typ, _ := e.Value["type"].(string)
		out[id] = tagRecord{name, typ}
	}
	miss := Missing(ids, got)
	if len(miss) == 0 {
		return out, nil
	}
	rows, err := s.Replica.Query(ctx, sqlTagRecords, miss)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	for _, m := range maps {
		id, _ := Int(m["id"])
		name, _ := m["name"].(string)
		typ, _ := m["type"].(string)
		out[id] = tagRecord{name, typ}
	}
	return out, nil
}

// sqlImageEvents and sqlModelEvents are eventDecorationEntityCaches.Image's and .Model's lookupFn
// query (one query, `equippedToType` the entity), on entityDB (Node: the primary). Their cosmetic
// records come from cosmeticCache, which Node reads from the replica.
const (
	sqlImageEvents = `SELECT uc."cosmeticId", uc."equippedToId", uc."userId"
		FROM "UserCosmetic" uc
		JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
		WHERE uc."equippedToId" = ANY($1::int[])
		  AND uc."equippedToType" = 'Image'::"CosmeticEntity"
		  AND jsonb_typeof(c.data->'event') = 'string'`
	sqlModelEvents = `SELECT uc."cosmeticId", uc."equippedToId", uc."userId"
		FROM "UserCosmetic" uc
		JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
		WHERE uc."equippedToId" = ANY($1::int[])
		  AND uc."equippedToType" = 'Model'::"CosmeticEntity"
		  AND jsonb_typeof(c.data->'event') = 'string'`
)

// lookupImageEvents is eventDecorationEntityCaches.Image's lookupFn: per image, the event decoration
// it wears `{id, name, type, source, data, equippedToId, equippedToType, userId}`, built from the
// cosmetic record (cosmeticCache.fetch); a row whose cosmetic is found nowhere, or whose data is not
// event decoration data, is skipped. The last row per image wins.
func (s *Sources) lookupImageEvents(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	return s.lookupEntityEvents(ctx, MissEventDecorations, sqlImageEvents, "Image", ids)
}

// lookupModelEvents is eventDecorationEntityCaches.Model's lookupFn: lookupImageEvents over the
// models, `equippedToType` 'Model' (Node: `entity as CosmeticEntity`).
func (s *Sources) lookupModelEvents(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	return s.lookupEntityEvents(ctx, MissModelDecorations, sqlModelEvents, "Model", ids)
}

func (s *Sources) lookupEntityEvents(ctx context.Context, cache, sql, entity string, ids []int) (map[int]jspack.Obj, error) {
	db, err := s.entityDB(cache)
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, sql, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	cids := make([]int, 0, len(maps))
	for _, m := range maps {
		cid, _ := Int(m["cosmeticId"])
		cids = append(cids, cid)
	}
	cosmetics, err := s.cosmeticRecords(ctx, Unique(cids))
	if err != nil {
		return nil, err
	}
	out := map[int]jspack.Obj{}
	for _, m := range maps {
		cid, _ := Int(m["cosmeticId"])
		eid, _ := Int(m["equippedToId"])
		uid, _ := Int(m["userId"])
		c, ok := cosmetics[cid]
		if !ok {
			continue
		}
		data, _ := c.Get("data")
		if !isEventDecorationData(data) {
			continue
		}
		get := func(k string) any {
			v, ok := c.Get(k)
			if !ok {
				return jspack.Undefined{}
			}
			return v
		}
		out[eid] = jspack.O("id", get("id"), "name", get("name"), "type", get("type"), "source", get("source"),
			"data", data, "equippedToId", eid, "equippedToType", entity, "userId", uid)
	}
	return out, nil
}

// isEventDecorationData is isEventDecorationData (src/shared/constants/event-decoration.constants.ts):
// an object whose `event` is a string.
func isEventDecorationData(data any) bool {
	o, ok := data.(jspack.Obj)
	if !ok {
		return false
	}
	ev, _ := o.Get("event")
	_, ok = ev.(string)
	return ok
}

// sqlCosmeticRecords is cosmeticCache's lookupFn (the cosmetic findMany selecting id, name, type,
// data, source, flags) on the replica, its json and enum columns as text.
const sqlCosmeticRecords = `SELECT id, name, type::text AS type, data::text AS data, source::text AS source, flags FROM "Cosmetic" WHERE id = ANY($1::int[])`

// cosmeticRecords is cosmeticCache.fetch(ids) as JS values (the cached record's members in their
// cached order, its `data` as cached): hits and stale entries from the cache, notFound markers
// absent, every other id from the replica. Node's fetch also writes those replica reads back to
// cosmetics2; this service does not (the shared cosmetic, user and picture miss paths never write).
func (s *Sources) cosmeticRecords(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	out := map[int]jspack.Obj{}
	if len(ids) == 0 {
		return out, nil
	}
	b := NewBatch()
	read := s.Packed.Queue(b, KeyCosmetics, ids, ttlDay)
	b.Exec(ctx)
	entries, _ := read.read()
	raw := read.raw()
	var miss []int
	for _, id := range ids {
		e, ok := entries[id]
		if !ok {
			miss = append(miss, id)
			continue
		}
		if e.NotFound {
			continue
		}
		v, err := jspack.Decode(raw[id])
		o, isObj := v.(jspack.Obj)
		if err != nil || !isObj {
			miss = append(miss, id)
			continue
		}
		rec := make(jspack.Obj, 0, len(o))
		for _, kv := range o {
			if kv.K != "cachedAt" {
				rec = append(rec, kv)
			}
		}
		out[id] = rec
	}
	if len(miss) == 0 {
		return out, nil
	}
	rows, err := s.Replica.Query(ctx, sqlCosmeticRecords, miss)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	for _, m := range maps {
		id, _ := Int(m["id"])
		data, err := jsonColumn(m["data"])
		if err != nil {
			return nil, err
		}
		flags, _ := Int(m["flags"])
		out[id] = jspack.O("id", id, "name", m["name"], "type", m["type"], "data", data, "source", m["source"], "flags", flags)
	}
	return out, nil
}

// cosmeticFlagWithheld is CosmeticFlag.Withheld (src/shared/constants/cosmetic-flags.constants.ts).
const cosmeticFlagWithheld = 1 << 2

const sqlShopListings = `SELECT si."cosmeticId", si."addedById", si.status::text AS status, si.meta::text AS meta, si."rejectionReason", c."createdById"
		FROM "CosmeticShopItem" si
		JOIN "Cosmetic" c ON c.id = si."cosmeticId"
		WHERE si."cosmeticId" = ANY($1::int[])`

const sqlTombstonedCosmetics = `SELECT id, flags FROM "Cosmetic" WHERE id = ANY($1::int[]) AND "createdById" IS NOT NULL`

// withheldCosmeticIDs is getWithheldCosmeticIds (src/server/services/creator-shop-withheld.ts): the
// creator-made cosmetics among ids that no holder may show. A cosmetic with a displayable listing by
// its creator is shown; one whose creator listings are all undisplayable is withheld; one with no
// creator listing is withheld when it carries CosmeticFlag.Withheld, read from db (the database its
// caller's lookup reads, as Node passes it). No ids, no query.
func (s *Sources) withheldCosmeticIDs(ctx context.Context, db Querier, ids []int) (map[int]bool, error) {
	withheld := map[int]bool{}
	ids = Unique(ids)
	if len(ids) == 0 {
		return withheld, nil
	}
	rows, err := db.Query(ctx, sqlShopListings, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	displayable := map[int]bool{}
	for _, m := range maps {
		cid, okC := Int(m["cosmeticId"])
		creator, okCreator := Int(m["createdById"])
		addedBy, okAdded := Int(m["addedById"])
		if !okC || !okCreator || !okAdded || addedBy != creator {
			continue
		}
		status, _ := m["status"].(string)
		var meta any
		if text, ok := m["meta"].(string); ok {
			if err := json.Unmarshal([]byte(text), &meta); err != nil {
				return nil, err
			}
		}
		if ListingDisplayable(status, meta, m["rejectionReason"]) {
			displayable[cid] = true
		} else {
			withheld[cid] = true
		}
	}
	for id := range displayable {
		delete(withheld, id)
	}
	var unlisted []int
	for _, id := range ids {
		if !displayable[id] && !withheld[id] {
			unlisted = append(unlisted, id)
		}
	}
	if len(unlisted) == 0 {
		return withheld, nil
	}
	rows, err = db.Query(ctx, sqlTombstonedCosmetics, unlisted)
	if err != nil {
		return nil, err
	}
	maps, err = rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	for _, m := range maps {
		id, _ := Int(m["id"])
		flags, _ := Int(m["flags"])
		if flags&cosmeticFlagWithheld != 0 {
			withheld[id] = true
		}
	}
	return withheld, nil
}

// displayedFields is DISPLAYED_FIELDS (packages/civitai-shared/src/knights-shop.ts).
var displayedFields = map[string]bool{"name": true, "description": true, "artwork": true, "offsets": true, "slug": true}

// ListingDisplayable is isListingDisplayable (packages/civitai-shared/src/knights-shop.ts) over a
// listing's status, its `meta` as json.Unmarshal decodes it, and its rejectionReason.
func ListingDisplayable(status string, meta any, rejectionReason any) bool {
	if status == "Published" {
		return true
	}
	m, _ := meta.(map[string]any)
	if truthyJS(m["takedown"]) {
		return false
	}
	if v, ok := m["displayApproved"]; ok {
		return truthyJS(v)
	}
	history, _ := m["history"].([]any)
	index := -1
	for i := len(history) - 1; i >= 0; i-- {
		if h, _ := history[i].(map[string]any); h["kind"] == "reviewed" {
			index = i
			break
		}
	}
	var approved bool
	if index >= 0 {
		h, _ := history[index].(map[string]any)
		approved = h["action"] == "approve"
	} else {
		reason, _ := rejectionReason.(string)
		approved = m["lastApprovedAmount"] != nil && reason == ""
	}
	if !approved {
		return false
	}
	for _, e := range history[index+1:] {
		h, _ := e.(map[string]any)
		changes, _ := h["changes"].([]any)
		for _, c := range changes {
			ch, _ := c.(map[string]any)
			if f, ok := ch["field"].(string); ok && displayedFields[f] {
				return false
			}
		}
	}
	return true
}
