package beacon

import (
	"math"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// The two /api/track/batch event kinds that do not go through the tracker service: `impression`
// (Tracker.impressions, a direct ClickHouse insert into `impressions`, one event to many rows) and
// `feed` (feedEventsRecorder, a sampled, buffered direct insert into `feedEvents`).
//
// 🔴 Every list here is a COPY, pinned like trackbatch_arms.go's: gen.ts records the Node values in
// vectors.json (`trackBatch.sinks`), TestTrackBatchSinkConstants pins these copies against it, and
// src/server/beacon/__tests__/beacon-go-track-batch-vectors.test.ts pins vectors.json against the
// live Node constants.

// TableImpressions is Tracker.impressions' table, TableFeedEvents FEED_EVENTS_TABLE.
const (
	TableImpressions = "impressions"
	TableFeedEvents  = "feedEvents"
)

// IMPRESSION_ENTITY_TYPES, IMPRESSION_SURFACES and IMPRESSION_ENTITIES_MAX (track.schema.ts).
var (
	impressionEntityTypes = []string{"Image", "Model", "Post", "Article", "Collection", "Bounty", "BountyEntry", "User", "Announcement"}
	impressionSurfaces    = []string{"home", "images", "videos", "posts", "models", "articles", "collections", "bounties", "search", "user", "hubs", "challenges", "3d-models", "ecosystems", "tag", "tools", "comics", "crucibles", "events", "other"}
)

const impressionEntitiesMax = 250

// The impression `surface` a value outside IMPRESSION_SURFACES (or none) becomes: `.catch('other')`.
const impressionSurfaceCatch = "other"

// FEED_EVENT_TYPES, FEED_EVENT_FEEDS and FEED_EVENT_INDEX_MAX (src/shared/constants/feed-events.constants.ts).
var (
	feedEventTypes = []string{"load", "seen", "click"}
	feedEventFeeds = []string{"models", "images", "posts", "articles", "search"}
)

const feedEventIndexMax = 10000

// trackSessionKeyMax is the `sessionKey` bound both schemas share: z.string().min(1).max(32).
const trackSessionKeyMax = 32

// The feed schema's other string bounds: `page` .max(200), `sort` .max(64), a filter key .max(64).
const (
	feedPageMax      = 200
	feedSortMax      = 64
	feedFilterKeyMax = 64
)

// int32Max is the `.max(2_147_483_647)` of a feed event's entity ids.
const int32Max = 2_147_483_647

// POINT_ENTITY_TYPES (src/server/events/points/hooks.ts): the impression entity types
// hattedImpressionEntities considers.
var pointEntityTypes = []string{"Image", "Model", "Article"}

// scoredEvent is one registered event with `scoring` (src/server/events): the window in which its
// points engine runs, eventPointsWindow — from `previewFrom ?? startDate` to `endDate +
// scoring.finalizeAfterMs`, in epoch milliseconds.
type scoredEvent struct {
	name     string
	from, to int64
}

// scoredEvents are the registered events with scoring, as gen.ts records them.
var scoredEvents = []scoredEvent{
	// birthday2026: previewFrom 2026-10-09T00:00Z, endDate 2026-12-01T00:00Z + 24 h.
	{name: "birthday2026", from: 1791504000000, to: 1796169600000},
}

// EventPointsMargin widens every scored window on both sides. The Node engine refreshes its loaded
// events every 30 s (STATE_REFRESH_MS) and keeps the last load through failed refreshes, so a server
// can still hold an event a little past its window; an hour covers that with room to spare, and the
// cost of the margin is only fallbacks.
const EventPointsMargin = time.Hour

// eventPointsMayAward reports whether hattedImpressionEntities could return anything at t: some
// scored event's window (widened by EventPointsMargin) holds t. Outside every window the engine has
// no loaded event, so isHattedEntity is false for every entity and no batch awards view points.
// Inside one, this service cannot tell which entities wear a hat (the hat map is loaded from Redis
// and followed through a stream), so it does not try: see ReasonTrackImpressionEventPoints.
func eventPointsMayAward(t time.Time) bool {
	ms := t.UnixMilli()
	margin := EventPointsMargin.Milliseconds()
	for _, e := range scoredEvents {
		if ms >= e.from-margin && ms <= e.to+margin {
			return true
		}
	}
	return false
}

var (
	impressionEntityTypeSet = set(impressionEntityTypes...)
	impressionSurfaceSet    = set(impressionSurfaces...)
	feedEventTypeSet        = set(feedEventTypes...)
	feedEventFeedSet        = set(feedEventFeeds...)
	pointEntityTypeSet      = set(pointEntityTypes...)
)

// impressionEvent is one accepted impression: Tracker.impressions' rows, minus the actor.
type impressionEvent struct {
	sessionKey string
	surface    string
	entities   []impressionEntity
	// pointEligible: an entity is of a POINT_ENTITY_TYPES type, so hattedImpressionEntities could
	// pick it.
	pointEligible bool
}

type impressionEntity struct {
	entityType string
	entityID   float64
}

// isSessionKey is the shared `sessionKey` schema: a string of 1..32 UTF-16 units.
func isSessionKey(v jsvalue.Value) bool {
	if v.Kind != jsvalue.String {
		return false
	}
	n := jsvalue.UTF16Len(v.S)
	return n >= 1 && n <= trackSessionKeyMax
}

// isPositiveInt is z.number().int().positive() (zod 4: a safe integer above 0), with an optional
// inclusive upper bound (0: none).
func isPositiveInt(v jsvalue.Value, upper float64) bool {
	if !isFiniteNumber(v) || math.Trunc(v.N) != v.N || math.Abs(v.N) > maxSafeInteger || v.N <= 0 {
		return false
	}
	return upper == 0 || v.N <= upper
}

// isIntInRange is z.number().int().min(lo).max(hi).
func isIntInRange(v jsvalue.Value, lo, hi float64) bool {
	return isFiniteNumber(v) && math.Trunc(v.N) == v.N && math.Abs(v.N) <= maxSafeInteger && v.N >= lo && v.N <= hi
}

// parseImpressionEvent is trackImpressionSchema: `sessionKey` (1..32), `surface` (an
// IMPRESSION_SURFACES value, anything else or nothing caught as 'other') and `entities` (1..250
// objects, each `entityType` an IMPRESSION_ENTITY_TYPES value and `entityId` a positive safe
// integer; other keys stripped). Keys outside the shape are stripped.
func parseImpressionEvent(data jsvalue.Value) (impressionEvent, bool) {
	if !data.IsPlainObject() {
		return impressionEvent{}, false
	}
	key, ok := data.O.Get("sessionKey")
	if !ok || !isSessionKey(key) {
		return impressionEvent{}, false
	}
	ev := impressionEvent{sessionKey: key.S, surface: impressionSurfaceCatch}
	if s, ok := data.O.Get("surface"); ok && isEnum(s, impressionSurfaceSet) {
		ev.surface = s.S
	}
	ents, ok := data.O.Get("entities")
	if !ok || ents.Kind != jsvalue.Array || len(ents.A) == 0 || len(ents.A) > impressionEntitiesMax {
		return impressionEvent{}, false
	}
	ev.entities = make([]impressionEntity, 0, len(ents.A))
	for _, e := range ents.A {
		if !e.IsPlainObject() {
			return impressionEvent{}, false
		}
		t, ok1 := e.O.Get("entityType")
		id, ok2 := e.O.Get("entityId")
		if !ok1 || !ok2 || !isEnum(t, impressionEntityTypeSet) || !isPositiveInt(id, 0) {
			return impressionEvent{}, false
		}
		if pointEntityTypeSet[t.S] {
			ev.pointEligible = true
		}
		ev.entities = append(ev.entities, impressionEntity{entityType: t.S, entityID: id.N})
	}
	return ev, true
}

// rows are Tracker.impressions' rows for a viewer: trackMany with skipActorMeta, so each is
// `{userId, ...{entityType, entityId, sessionKey, surface}}`.
func (ev impressionEvent) rows(userID float64) [][]byte {
	out := make([][]byte, 0, len(ev.entities))
	for _, e := range ev.entities {
		row := jsvalue.NewObject()
		row.Set("userId", jsvalue.NumberValue(userID))
		row.Set("entityType", jsvalue.StringValue(e.entityType))
		row.Set("entityId", jsvalue.NumberValue(e.entityID))
		row.Set("sessionKey", jsvalue.StringValue(ev.sessionKey))
		row.Set("surface", jsvalue.StringValue(ev.surface))
		out = append(out, jsvalue.Stringify(jsvalue.ObjectValue(row)))
	}
	return out
}

// parseFeedEvent is trackFeedSchema's acceptance; it returns the event's sessionKey, the one field
// this service reads (see TrackBatch: a feed event is answered here only when its session is not
// sampled, and then it writes nothing). `event`, `feed` enums; `sessionKey` 1..32; `page` a string
// of at most 200; `sort` an optional string of at most 64; `pageIndex` and `position` optional ints
// in 0..FEED_EVENT_INDEX_MAX; `filters` an optional record of strings under keys of at most 64 (zod's
// record skips a `__proto__` key, whatever its value); `entityType` an optional
// IMPRESSION_ENTITY_TYPES value; `entityId` an optional positive int up to 2^31-1; `seenIds` an
// optional array of at most 250 of those. Other keys are stripped.
func parseFeedEvent(data jsvalue.Value) (string, bool) {
	if !data.IsPlainObject() {
		return "", false
	}
	o := data.O
	if v, ok := o.Get("event"); !ok || !isEnum(v, feedEventTypeSet) {
		return "", false
	}
	key, ok := o.Get("sessionKey")
	if !ok || !isSessionKey(key) {
		return "", false
	}
	if v, ok := o.Get("feed"); !ok || !isEnum(v, feedEventFeedSet) {
		return "", false
	}
	if v, ok := o.Get("page"); !ok || v.Kind != jsvalue.String || jsvalue.UTF16Len(v.S) > feedPageMax {
		return "", false
	}
	// An absent key and an explicit `undefined` are the same thing to zod; JSON has no undefined, so
	// only absence reaches here.
	if v, ok := o.Get("sort"); ok && (v.Kind != jsvalue.String || jsvalue.UTF16Len(v.S) > feedSortMax) {
		return "", false
	}
	for _, k := range []string{"pageIndex", "position"} {
		if v, ok := o.Get(k); ok && !isIntInRange(v, 0, feedEventIndexMax) {
			return "", false
		}
	}
	if v, ok := o.Get("filters"); ok {
		if !v.IsPlainObject() {
			return "", false
		}
		for _, k := range v.O.Keys() {
			if k == "__proto__" {
				continue
			}
			fv, _ := v.O.Get(k)
			if jsvalue.UTF16Len(k) > feedFilterKeyMax || fv.Kind != jsvalue.String {
				return "", false
			}
		}
	}
	if v, ok := o.Get("entityType"); ok && !isEnum(v, impressionEntityTypeSet) {
		return "", false
	}
	if v, ok := o.Get("entityId"); ok && !isPositiveInt(v, int32Max) {
		return "", false
	}
	if v, ok := o.Get("seenIds"); ok {
		if v.Kind != jsvalue.Array || len(v.A) > impressionEntitiesMax {
			return "", false
		}
		for _, id := range v.A {
			if !isPositiveInt(id, int32Max) {
				return "", false
			}
		}
	}
	return key.S, true
}

// HashToUnit is hashToUnit (src/server/clickhouse/sampled-row-buffer.ts): 32-bit FNV-1a over the
// key's UTF-16 code units, as a fraction of 2^32. A feed event's session is recorded when this is
// below the sample rate.
func HashToUnit(key string) float64 {
	h := uint32(0x811c9dc5)
	for _, u := range jsvalue.Units(key) {
		h ^= uint32(u)
		h *= 0x01000193
	}
	return float64(h) / 0x1_0000_0000
}

// feedSessionKept is the recorder's `keeps(sessionKey)`: sampleRate > 0 and the key hashes under it
// (`until` is always Infinity for feed events).
func feedSessionKept(sessionKey string, rate float64) bool {
	return rate > 0 && HashToUnit(sessionKey) < rate
}

// ParseSampleRate is parseSampleRate (feed-events.service.ts) over a Flipt variant key:
// Number(key), kept when finite and above 0, capped at 1; anything else is 0 (off).
func ParseSampleRate(variantKey string) float64 {
	n := jsvalue.StringToNumber(variantKey)
	if math.IsInf(n, 0) || math.IsNaN(n) || n <= 0 {
		return 0
	}
	return math.Min(n, 1)
}

// FeedEventsSampleRateFlag is FEED_EVENTS_SAMPLE_RATE_FLAG: the Flipt variant whose key is the share of
// browser sessions the feed events recorder keeps.
const FeedEventsSampleRateFlag = "feed-events-sample-rate"
