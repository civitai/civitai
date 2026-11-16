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
)

// MissCaches lists every MissXxx label, for seeding the counter.
var MissCaches = []string{MissUserCosmetics, MissImageFrames, MissEventDecorations}

// MissCompute is how hydration answers a miss on the per-entity caches Node fills on read (user
// cosmetics, image frames, event decorations): with the Node lookup's own query,
// batched once per page and cache, instead of falling back. A Sources without one falls back on
// those misses (FEED_GO_COMPUTE_MISSES=false).
//
// Each computed entry is built as the Node lookup builds it, packed exactly as Node's cache writer
// packs `{...result, cachedAt}` (or the `{[idKey]: id, notFound: true, cachedAt}` marker), and read
// back through the same decoder as a cache hit, so a computed miss and a later hit of what Node
// wrote for it hydrate identically.
type MissCompute struct {
	// WriteBack (FEED_GO_CACHE_WRITEBACK, default off) writes each computed entry where, and as, the
	// Node lookup writes it: same key, same msgpackr bytes, same expiry. Only for a miss Node would
	// write too (no key, or an undecodable value; never inside a bust's debounce window or after a
	// failed read), and as SET NX: a key another writer filled since the read is never overwritten.
	// The frame and event-decoration lookups then read Primary, as Node's do (entityDB).
	WriteBack bool
	// Primary is the primary database (DATABASE_URL, Node's dbWrite), required with WriteBack: the
	// frame and event-decoration lookups write what they read, so they must not read a lagging replica
	// (an unequipped or withheld frame would be cached again for a day).
	Primary Querier
	// FrameNegative mirrors the `frame-cache-negative` flag (FEED_GO_FRAME_CACHE_NEGATIVE): whether the
	// frame cache's notFound markers are live. Off, a marker is read as a miss and none is written,
	// as Node does while the flag is off.
	FrameNegative bool

	// flight coalesces concurrent lookups of one cache and id set; recent keeps answers for a few
	// seconds with write-back off (lookupShared).
	flight   singleflight.Group
	recentMu sync.Mutex
	recent   map[recentKey]recentEntry
	// beforeFlight, when set (tests), runs just before a lookup joins or starts its flight.
	beforeFlight func()
	// Observe counts computed miss ids: cache is a MissXxx label, result "computed" or "error".
	Observe func(cache, result string, n int)
	// Now stamps `cachedAt` / `_populatedAt` (time.Now when nil).
	Now func() time.Time
}

// Recent lookups (write-back off only): how long a computed entry answers repeat misses in this
// process, and how many entries are held at most.
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
//     caller's context runs it, so a joiner sees that caller's cancellation as its own error);
//   - with write-back off, each answer (a record or "no row") is kept for recentTTL and answers the
//     next miss of that id without a query. With write-back on nothing is kept: the written cache
//     entry answers repeats, and a kept answer could outlive the bust that should replace it.
//
// The records are shared between callers and must be treated as read-only.
func (c *MissCompute) lookupShared(ctx context.Context, cache string, ids []int,
	lookup func(context.Context, []int) (map[int]jspack.Obj, error)) (map[int]jspack.Obj, error) {
	out := make(map[int]jspack.Obj, len(ids))
	todo := ids
	if !c.WriteBack {
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
	if c.beforeFlight != nil {
		c.beforeFlight()
	}
	v, err, _ := c.flight.Do(cache+":"+strings.Join(parts, ","), func() (any, error) { return lookup(ctx, todo) })
	if err != nil {
		return nil, err
	}
	records, _ := v.(map[int]jspack.Obj)
	for _, id := range todo {
		if rec, ok := records[id]; ok {
			out[id] = rec
		}
	}
	if !c.WriteBack {
		c.remember(cache, todo, records)
	}
	return out, nil
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

// remember keeps the answers for ids. At recentMax the expired entries are dropped first; an answer
// that still does not fit is not kept.
func (c *MissCompute) remember(cache string, ids []int, records map[int]jspack.Obj) {
	now := c.now()
	until := now.Add(recentTTL)
	c.recentMu.Lock()
	defer c.recentMu.Unlock()
	if c.recent == nil {
		c.recent = map[recentKey]recentEntry{}
	}
	if len(c.recent)+len(ids) > recentMax {
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

// entityDB is the database the frame and event-decoration lookups read. Node reads the primary
// (dbWrite, src/server/redis/caches.ts) and caches what it reads for a day. With WriteBack on this
// service writes what it reads too, so it reads the primary as well; with it off nothing it reads is
// cached, and the replica's lag only affects this one answer.
func (s *Sources) entityDB() (Querier, error) {
	if !s.Compute.WriteBack {
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
	// ttl is a value's EX: `ttl`, as staleWhileRevalidate is off on all three caches.
	ttl time.Duration
	// notFoundTTL is a notFound marker's EX (`notFoundTtl ?? ttl`).
	notFoundTTL time.Duration
}

var (
	// userCosmeticCache: ttl a day, cacheNotFound (default) on, no notFoundTtl.
	userCosmeticsSpec = lookupSpec{cache: MissUserCosmetics, reason: "user-cosmetics-miss", key: KeyUserCosmetics, idKey: "userId", ttl: ttlDay, notFoundTTL: ttlDay}
	// cosmeticEntityCaches.Image: ttl a day, notFoundTtl an hour, cacheNotFound the flag.
	frameSpec = lookupSpec{cache: MissImageFrames, reason: "image-frame-miss", key: KeyImageFrames, idKey: "equippedToId", ttl: ttlDay, notFoundTTL: time.Hour}
	// eventDecorationEntityCaches.Image: ttl a day, notFoundTtl an hour, cacheNotFound on.
	eventSpec = lookupSpec{cache: MissEventDecorations, reason: "event-decoration-miss", key: KeyImageEvents, idKey: "equippedToId", ttl: ttlDay, notFoundTTL: time.Hour}
)

// packedWrite is one cache write: SET key val EX ttl NX.
type packedWrite struct {
	key string
	val []byte
	ttl time.Duration
}

// fill answers the ids of ids that got does not, with lookup (the Node lookupFn, batched: one call
// for every miss), adding each answer to got as the entry Node would have cached: the record, or a
// notFound marker for an id the lookup found nothing for. writable says which misses Node would
// write back (PackedRead.read); writeNotFound whether the cache writes markers.
func (s *Sources) fill(ctx context.Context, spec lookupSpec, ids []int, got map[int]Entry, writable map[int]bool, writeNotFound bool,
	lookup func(context.Context, []int) (map[int]jspack.Obj, error)) error {
	miss := Missing(ids, got)
	if len(miss) == 0 {
		return nil
	}
	c := s.Compute
	records, err := c.lookupShared(ctx, spec.cache, miss, lookup)
	if err != nil {
		c.observe(spec.cache, "error", len(miss))
		return fallback.Newf(spec.reason+"-failed", "%v", err)
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
		if c.WriteBack && writable[id] && (found || writeNotFound) {
			writes = append(writes, packedWrite{key: s.Packed.key(spec.key, id), val: b, ttl: ttl})
		}
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
	return s.fill(ctx, userCosmeticsSpec, users, got, writable, true, s.lookupUserCosmetics)
}

// fillFrames computes the frame misses of got (cosmeticEntityCaches.Image.fetch's lookup). While
// frame-cache-negative is off (FrameNegative false) a notFound marker is a miss too, as Node's fetch
// ignores markers then, and none is written; an id whose marker was read is never written (it is
// not writable: the marker holds the key, and a write is SET NX).
func (s *Sources) fillFrames(ctx context.Context, images []int, got map[int]Entry, writable map[int]bool) error {
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
	return s.fill(ctx, frameSpec, images, got, writable, s.Compute.FrameNegative, s.lookupImageFrames)
}

// fillEvents computes the event-decoration misses of got (eventDecorationEntityCaches.Image.fetch's
// lookup); a no-op without s.Compute.
func (s *Sources) fillEvents(ctx context.Context, images []int, got map[int]Entry, writable map[int]bool) error {
	if s.Compute == nil {
		return nil
	}
	return s.fill(ctx, eventSpec, images, got, writable, true, s.lookupImageEvents)
}

// writePacked sends writes in one pipeline, best effort: Node swallows a failed cache write too (the
// lookup has already answered).
func (s *Sources) writePacked(ctx context.Context, writes []packedWrite) {
	if len(writes) == 0 || s.Packed.Redis == nil {
		return
	}
	_, _ = s.Packed.Redis.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, w := range writes {
			p.SetNX(ctx, w.key, w.val, w.ttl)
		}
		return nil
	})
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

// sqlImageFrames is cosmeticEntityCaches.Image's lookupFn query, on entityDB (Node: the primary).
const sqlImageFrames = `SELECT uc."cosmeticId", uc."equippedToId", uc."data"::text AS "userData", c."createdById"
		FROM "UserCosmetic" uc
		JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
		WHERE uc."equippedToId" = ANY($1::int[])
		  AND uc."equippedToType" = 'Image'::"CosmeticEntity"
		  AND jsonb_typeof(c.data->'event') IS DISTINCT FROM 'string'`

// lookupImageFrames is cosmeticEntityCaches.Image's lookupFn: per image, the raw frame row
// `{cosmeticId, equippedToId, userData}` (the last row per image, as Object.fromEntries keeps it),
// without frames whose creator cosmetic is withheld. The cosmetic join is the cache's appendFn,
// which runs on every read (joinFrames).
func (s *Sources) lookupImageFrames(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	db, err := s.entityDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, sqlImageFrames, ids)
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

// sqlImageEvents is eventDecorationEntityCaches.Image's lookupFn query, on entityDB (Node: the
// primary). Its cosmetic records come from cosmeticCache, which Node reads from the replica.
const sqlImageEvents = `SELECT uc."cosmeticId", uc."equippedToId", uc."userId"
		FROM "UserCosmetic" uc
		JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
		WHERE uc."equippedToId" = ANY($1::int[])
		  AND uc."equippedToType" = 'Image'::"CosmeticEntity"
		  AND jsonb_typeof(c.data->'event') = 'string'`

// lookupImageEvents is eventDecorationEntityCaches.Image's lookupFn: per image, the event decoration
// it wears `{id, name, type, source, data, equippedToId, equippedToType, userId}`, built from the
// cosmetic record (cosmeticCache.fetch); a row whose cosmetic is found nowhere, or whose data is not
// event decoration data, is skipped. The last row per image wins.
func (s *Sources) lookupImageEvents(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	db, err := s.entityDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, sqlImageEvents, ids)
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
			"data", data, "equippedToId", eid, "equippedToType", "Image", "userId", uid)
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
