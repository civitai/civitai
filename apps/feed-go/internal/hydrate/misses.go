package hydrate

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// The per-entity caches whose misses this service computes (the `cache` label of
// feed_go_cache_miss_total).
const (
	MissUserCosmetics    = "user-cosmetics"    // userCosmeticCache
	MissImageFrames      = "image-frames"      // cosmeticEntityCaches.Image
	MissEventDecorations = "event-decorations" // eventDecorationEntityCaches.Image
	MissImageMetrics     = "image-metrics"     // MetricService over `metrics:Image:<id>`
)

// MissCaches lists every MissXxx label, for seeding the counter.
var MissCaches = []string{MissUserCosmetics, MissImageFrames, MissEventDecorations, MissImageMetrics}

// MissCompute is how hydration answers a miss on the per-entity caches Node fills on read (user
// cosmetics, image frames, event decorations, metric hashes): with the Node lookup's own query,
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
	WriteBack bool
	// FrameNegative mirrors the `frame-cache-negative` flag (FEED_GO_FRAME_CACHE_NEGATIVE): whether the
	// frame cache's notFound markers are live. Off, a marker is read as a miss and none is written,
	// as Node does while the flag is off.
	FrameNegative bool
	// Metrics answers metric-hash misses (MetricService's ClickHouse populate); nil = they fall back
	// (`metrics-miss`).
	Metrics MetricsSource
	// Observe counts computed miss ids: cache is a MissXxx label, result "computed" or "error".
	Observe func(cache, result string, n int)
	// Now stamps `cachedAt` / `_populatedAt` (time.Now when nil).
	Now func() time.Time
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
	records, err := lookup(ctx, miss)
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
	withheld, err := s.withheldCosmeticIDs(ctx, cids)
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

// sqlImageFrames is cosmeticEntityCaches.Image's lookupFn query. Node reads the primary (dbWrite);
// this service has the replica only (DESIGN.md §9).
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
	rows, err := s.Replica.Query(ctx, sqlImageFrames, ids)
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
	withheld, err := s.withheldCosmeticIDs(ctx, created)
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

// sqlImageEvents is eventDecorationEntityCaches.Image's lookupFn query (Node: the primary; here the
// replica, DESIGN.md §9).
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
	rows, err := s.Replica.Query(ctx, sqlImageEvents, ids)
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
// creator listing is withheld when it carries CosmeticFlag.Withheld. No ids, no query.
func (s *Sources) withheldCosmeticIDs(ctx context.Context, ids []int) (map[int]bool, error) {
	withheld := map[int]bool{}
	ids = Unique(ids)
	if len(ids) == 0 {
		return withheld, nil
	}
	rows, err := s.Replica.Query(ctx, sqlShopListings, ids)
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
	rows, err = s.Replica.Query(ctx, sqlTombstonedCosmetics, unlisted)
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
