package hydrate

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// MissGallerySettings is the `model:gallery-settings:<modelId>` entry getGallerySettingsByModelId
// writes back on a miss (src/server/services/model.service.ts): the FEED_GO_CACHE_WRITEBACK name under
// which a gallery-settings miss the hold gates compute (GalleryHolds) is built in full and written
// where, and as, Node writes it.
const MissGallerySettings = "gallery-settings"

// GallerySettingsTTL is the entry's expiry: `redis.set(cacheKey, ..., { EX: CacheTTL.week })`.
const GallerySettingsTTL = 7 * 24 * time.Hour

// GallerySettingsKey is the entry's key (`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${id}`) under the cache
// key prefix: the one spelling of it, for the reader (feed.GalleryStore) and the write-back alike.
func GallerySettingsKey(prefix string, modelID int) string {
	return prefix + "model:gallery-settings:" + strconv.Itoa(modelID)
}

// gallerySettingsNone is the `none` marker Node writes for a model with no settings that is not held:
// `toJson({ none: true, hiddenTags: [], hiddenUsers: [], hiddenImages: {}, pinnedPosts: {} })`.
const gallerySettingsNone = `{"none":true,"hiddenTags":[],"hiddenUsers":[],"hiddenImages":{},"pinnedPosts":{}}`

// The rebuild's reads (getGallerySettingsByModelId): the model (`getModel` selecting id, userId,
// gallerySettings, minor, sfwOnly; its jsonb as the text Prisma parses), getGalleryHiddenPreferences'
// Tag and User findMany (`{ id: { in } }` selecting id and name / id and username, on dbRead), and
// getCreatorGalleryHiddenUserIds (src/server/services/creator-gallery-hidden-users.service.ts), here
// batched over the creators. None has an ORDER BY, as in Node.
const (
	sqlGallerySettingsModel      = `SELECT id, "userId", "gallerySettings"::text AS "gallerySettings", minor, "sfwOnly" FROM "Model" WHERE id = ANY($1::int[])`
	sqlGalleryHiddenTags         = `SELECT id, name FROM "Tag" WHERE id = ANY($1::int[])`
	sqlGalleryHiddenUsers        = `SELECT id, username FROM "User" WHERE id = ANY($1::int[])`
	sqlCreatorGalleryHiddenUsers = `SELECT h."creatorId", h."userId" FROM "CreatorGalleryHiddenUser" h JOIN "User" u ON u.id = h."userId" AND u."deletedAt" IS NULL WHERE h."creatorId" = ANY($1::int[])`
)

// galleryModel is one model row the rebuild reads.
type galleryModel struct {
	id, userID     int
	settings       any // the stored gallerySettings, as JSON.parse reads it (nil for SQL or JSON null)
	minor, sfwOnly bool
}

// galleryHoldsWritten is GalleryHolds with the gallery settings written back (MissGallerySettings in
// the computation's WriteBack): each absent key is rebuilt exactly as getGallerySettingsByModelId
// rebuilds it (gallerySettingsEntries), written with SET NX for a week, and its hold read off the
// rebuilt entry. flagged is whether a recent write flagged any of ids: the models are then read from
// the primary, as getDbWithoutLag reads them. Concurrent calls for the same models share one rebuild
// and one write (singleflight); nothing is kept in process (a written entry answers the repeats).
func (s *Sources) galleryHoldsWritten(ctx context.Context, ids []int, flagged bool) (map[int]jspack.Obj, error) {
	c := s.Compute
	// A flagged rebuild never shares a flight: the flight key is the ids alone, so a caller that saw
	// the flag must not join an unflagged caller's replica rebuild (nor the reverse). Flags are rare.
	run := c.lookupShared
	if flagged {
		run = func(ctx context.Context, _ string, ids []int, lookup func(context.Context, []int) (map[int]jspack.Obj, error)) (map[int]jspack.Obj, error) {
			return lookup(ctx, ids)
		}
	}
	return run(ctx, MissGallerySettings, ids, func(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
		entries, holds, err := s.gallerySettingsEntries(ctx, ids, flagged)
		if err != nil {
			return nil, err
		}
		writes := make([]packedWrite, 0, len(entries))
		out := make(map[int]jspack.Obj, len(entries))
		for _, id := range ids {
			entry, ok := entries[id]
			if !ok {
				continue // no row: Node answers null and writes nothing
			}
			key := GallerySettingsKey(s.Packed.Prefix, id)
			writes = append(writes, packedWrite{cache: MissGallerySettings, id: id, key: key, val: entry, ttl: GallerySettingsTTL})
			h := holds[id]
			out[id] = jspack.Obj{{K: "held", V: h.Held}, {K: "level", V: h.Level}}
		}
		s.writePacked(ctx, writes)
		return out, nil
	})
}

// gallerySettingsEntries rebuilds the gallery-settings entry of each of ids that has a Model row, as
// getGallerySettingsByModelId does, and returns its bytes (what `toJson` writes) and its hold:
//
//   - `sfwHeld = minor || sfwOnly`; a model whose stored settings are falsy and that is not held gets
//     the `none` marker;
//   - otherwise `{ ...preferences, creatorHiddenUserIds, sfwHeld }`, preferences being
//     getGalleryHiddenPreferences over the stored settings (with `level: heldGalleryLevel(stored.level,
//     model)` for a held model): hiddenTags and hiddenUsers looked up from the stored `tags` / `users`
//     ids on the replica (dbRead), `hiddenImages` and `pinnedPosts` as stored (`{}` when absent),
//     `level ?? allBrowsingLevelsFlag`; creatorHiddenUserIds from the primary (`fresh: true`).
//
// The model is read from the replica, or from the primary when flagged (getDbWithoutLag). A stored
// value Node would reject or coerce (a held level that is not an int32 JSON number or null, `tags` or
// `users` that are not a list of integers) is an error: the request falls back and Node rebuilds it.
//
// The bytes are JSON.stringify's: members in JS property order (jspack.FromJSON keeps a jsonb's
// stored order with integer-like keys first), numbers as JS writes them. They differ from Node's only
// where superjson.Plain does (U+2028/U+2029 escaped, an invalid UTF-8 byte replaced), which decode to
// the same value.
func (s *Sources) gallerySettingsEntries(ctx context.Context, ids []int, flagged bool) (map[int][]byte, map[int]GalleryHold, error) {
	primary := s.Compute.Primary
	if primary == nil {
		return nil, nil, fmt.Errorf("gallery settings: write-back needs the primary database")
	}
	modelDB := s.Replica
	if flagged {
		modelDB = primary
	}
	models, err := s.readGalleryModels(ctx, modelDB, ids)
	if err != nil {
		return nil, nil, err
	}

	// The ids each built entry looks up, batched over the page's models.
	type built struct {
		model      galleryModel
		stored     jspack.Obj
		tags       []int
		users      []int
		level      any
		hold       GalleryHold
		hasEntries bool // not the none marker
	}
	var builds []built
	var tagIDs, userIDs, creators []int
	for _, m := range models {
		b := built{model: m, hold: GalleryHold{Held: m.minor || m.sfwOnly}}
		if !jsTruthy(m.settings) && !b.hold.Held {
			builds = append(builds, b)
			continue
		}
		b.hasEntries = true
		// `(model.gallerySettings ?? {})` destructured: any value other than an object yields none of
		// its members.
		b.stored, _ = m.settings.(jspack.Obj)
		if b.tags, err = galleryIDList(b.stored, "tags"); err != nil {
			return nil, nil, fmt.Errorf("gallery settings: model %d: %w", m.id, err)
		}
		if b.users, err = galleryIDList(b.stored, "users"); err != nil {
			return nil, nil, fmt.Errorf("gallery settings: model %d: %w", m.id, err)
		}
		stored, _ := b.stored.Get("level")
		if b.hold.Held {
			lvl, err := heldStoredLevel(stored)
			if err != nil {
				return nil, nil, fmt.Errorf("gallery settings: model %d: %w", m.id, err)
			}
			b.hold.Level = HeldGalleryLevel(lvl, m.minor, m.sfwOnly)
			b.level = float64(b.hold.Level)
		} else if stored == nil {
			b.level = float64(browsing.AllLevels) // `level ?? allBrowsingLevelsFlag`
		} else {
			b.level = stored
		}
		tagIDs = append(tagIDs, b.tags...)
		userIDs = append(userIDs, b.users...)
		creators = append(creators, m.userID)
		builds = append(builds, b)
	}

	tags, err := s.galleryNamedRows(ctx, s.Replica, sqlGalleryHiddenTags, Unique(tagIDs), "name")
	if err != nil {
		return nil, nil, err
	}
	users, err := s.galleryNamedRows(ctx, s.Replica, sqlGalleryHiddenUsers, Unique(userIDs), "username")
	if err != nil {
		return nil, nil, err
	}
	hidden, err := s.creatorHiddenUsers(ctx, primary, Unique(creators))
	if err != nil {
		return nil, nil, err
	}

	entries := make(map[int][]byte, len(builds))
	holds := make(map[int]GalleryHold, len(builds))
	for _, b := range builds {
		holds[b.model.id] = b.hold
		if !b.hasEntries {
			entries[b.model.id] = []byte(gallerySettingsNone)
			continue
		}
		hiddenImages, ok := b.stored.Get("hiddenImages")
		if !ok {
			hiddenImages = jspack.Obj{}
		}
		pinnedPosts, ok := b.stored.Get("pinnedPosts")
		if !ok {
			pinnedPosts = jspack.Obj{}
		}
		creatorHidden := hidden[b.model.userID]
		if creatorHidden == nil {
			creatorHidden = []int{}
		}
		v := superjson.Object{
			{Key: "hiddenTags", Val: tags.of(b.tags, "name")},
			{Key: "hiddenUsers", Val: users.of(b.users, "username")},
			{Key: "hiddenImages", Val: plainValue(hiddenImages)},
			{Key: "level", Val: plainValue(b.level)},
			{Key: "pinnedPosts", Val: plainValue(pinnedPosts)},
			{Key: "creatorHiddenUserIds", Val: creatorHidden},
			{Key: "sfwHeld", Val: b.hold.Held},
		}
		raw, err := superjson.Plain(v)
		if err != nil {
			return nil, nil, fmt.Errorf("gallery settings: model %d: %w", b.model.id, err)
		}
		entries[b.model.id] = raw
	}
	return entries, holds, nil
}

// readGalleryModels reads the rebuild's Model rows of ids from db.
func (s *Sources) readGalleryModels(ctx context.Context, db Querier, ids []int) ([]galleryModel, error) {
	rows, err := db.Query(ctx, sqlGallerySettingsModel, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	out := make([]galleryModel, 0, len(maps))
	for _, m := range maps {
		id, ok1 := Int(m["id"])
		userID, ok2 := Int(m["userId"])
		minor, ok3 := m["minor"].(bool)
		sfwOnly, ok4 := m["sfwOnly"].(bool)
		if !ok1 || !ok2 || !ok3 || !ok4 {
			return nil, fmt.Errorf("gallery settings: model row %v", m)
		}
		settings, err := jsonColumn(m["gallerySettings"])
		if err != nil {
			return nil, fmt.Errorf("gallery settings: model %d: %w", id, err)
		}
		out = append(out, galleryModel{id: id, userID: userID, settings: settings, minor: minor, sfwOnly: sfwOnly})
	}
	return out, nil
}

// namedRows are a lookup's rows by id, in the order the database returned them (findMany without an
// orderBy hands Node the rows in that order).
type namedRows struct {
	order []int
	by    map[int]any // id -> the named column's value
}

// of is the rows of ids (the stored list), as `{ id, <col> }` objects in row order.
func (n namedRows) of(ids []int, col string) []any {
	out := []any{}
	if len(ids) == 0 {
		return out
	}
	want := make(map[int]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	for _, id := range n.order {
		if want[id] {
			out = append(out, superjson.Object{{Key: "id", Val: id}, {Key: col, Val: n.by[id]}})
		}
	}
	return out
}

// galleryNamedRows runs a hidden tags / users lookup over ids (none when ids is empty).
func (s *Sources) galleryNamedRows(ctx context.Context, db Querier, sql string, ids []int, col string) (namedRows, error) {
	out := namedRows{by: map[int]any{}}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := db.Query(ctx, sql, ids)
	if err != nil {
		return out, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return out, err
	}
	for _, m := range maps {
		id, ok := Int(m["id"])
		v := m[col]
		_, isStr := v.(string)
		if !ok || (v != nil && !isStr) {
			return out, fmt.Errorf("gallery settings: %s row %v", col, m)
		}
		if _, seen := out.by[id]; !seen {
			out.order = append(out.order, id)
		}
		out.by[id] = v
	}
	return out, nil
}

// creatorHiddenUsers is getCreatorGalleryHiddenUserIds(creator, { fresh: true }) for each creator, on
// db (the primary), in row order; a creator who hides nobody is absent.
func (s *Sources) creatorHiddenUsers(ctx context.Context, db Querier, creators []int) (map[int][]int, error) {
	out := map[int][]int{}
	if len(creators) == 0 {
		return out, nil
	}
	rows, err := db.Query(ctx, sqlCreatorGalleryHiddenUsers, creators)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	for _, m := range maps {
		creator, ok1 := Int(m["creatorId"])
		user, ok2 := Int(m["userId"])
		if !ok1 || !ok2 {
			return nil, fmt.Errorf("gallery settings: hidden user row %v", m)
		}
		out[creator] = append(out[creator], user)
	}
	return out, nil
}

// galleryIDList reads the stored `tags` / `users` as getGalleryHiddenPreferences does (`list &&
// list.length ? findMany({ where: { id: { in: list } } }) : []`): absent, falsy, or with no length
// (a number, a boolean, an object) is no lookup; a non-empty list must hold integers (Prisma rejects
// anything else), and a non-empty string is rejected the same way.
func galleryIDList(stored jspack.Obj, key string) ([]int, error) {
	v, _ := stored.Get(key)
	switch t := v.(type) {
	case []any:
		ids := make([]int, 0, len(t))
		for _, e := range t {
			f, ok := e.(float64)
			if !ok || f != math.Trunc(f) || f < math.MinInt32 || f > math.MaxInt32 {
				return nil, fmt.Errorf("stored %s holds %v", key, e)
			}
			ids = append(ids, int(f))
		}
		return ids, nil
	case string:
		if t != "" {
			return nil, fmt.Errorf("stored %s is a string", key)
		}
	}
	return nil, nil
}

// heldStoredLevel is storedGalleryLevel for a parsed value: `stored.level ?? 0` where only null,
// absent or an int32 JSON number is read; anything JS would coerce or truncate is an error.
func heldStoredLevel(v any) (int, error) {
	switch t := v.(type) {
	case nil:
		return 0, nil
	case float64:
		if t != math.Trunc(t) || t < math.MinInt32 || t > math.MaxInt32 {
			return 0, fmt.Errorf("stored level %v", t)
		}
		return int(t), nil
	}
	return 0, fmt.Errorf("stored level of type %T", v)
}

// plainValue is a JSON.parse value (jspack.FromJSON) as superjson.Plain writes it: objects keep their
// JS property order.
func plainValue(v any) any {
	switch t := v.(type) {
	case jspack.Obj:
		o := make(superjson.Object, 0, len(t))
		for _, kv := range t {
			o = append(o, superjson.Field{Key: kv.K, Val: plainValue(kv.V)})
		}
		return o
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = plainValue(e)
		}
		return out
	}
	return v
}
