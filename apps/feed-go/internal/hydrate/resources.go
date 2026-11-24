package hydrate

import (
	"context"
	"fmt"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// More cache keys (REDIS_KEYS in packages/civitai-redis/src/client.ts), without the per-id suffix.
const (
	// KeyImageResources is imageResourcesCache (src/server/redis/caches.ts): per image, the model
	// versions it used.
	KeyImageResources = "packed:caches:image-resources"
	// KeyPostVersion and KeyVersionModel are the gallery hold's post→version and version→model caches
	// (createPostVersionCache / createVersionModelCache in src/server/services/model.service.ts),
	// keyed under REDIS_KEYS.MODEL.GALLERY_SETTINGS.
	KeyPostVersion  = "model:gallery-settings:post-version"
	KeyVersionModel = "model:gallery-settings:version-model"
)

// TTLs of the two hold caches. Both are built with staleWhileRevalidate off, so an entry past its TTL
// is a miss (looked up again), never served stale.
const (
	ttlPostVersion  = time.Hour
	ttlVersionModel = 7 * 24 * time.Hour
)

// ImageResource is one ImageResourceCacheItem, the fields the public images endpoint reads.
type ImageResource struct {
	ModelVersionID int
	Detected       bool
	ModelType      any
	BaseModel      any
}

// MissImageResources is the image-resources cache's `cache` label of feed_go_cache_miss_total and of
// the Go-first probe (imageResourcesCache, read by the public images endpoint only).
const MissImageResources = "image-resources"

// ImageResourceUseWriteFlag is the Node app's FLIPT_FEATURE_FLAGS.IMAGE_RESOURCE_USE_WRITE: while it
// is on, imageResourcesCache's lookup reads the primary for every miss (src/server/redis/caches.ts).
const ImageResourceUseWriteFlag = "image-resource-use-write"

// imageResourcesFrom is imageResourcesCache.fetch for the public images endpoint (`includeBaseModel`)
// over the cache's answer got (writable: the misses Node's fetch would write, PackedRead.read) for
// (unique) image ids: per image, its resources in cached order. An image the lookup found none for
// is cached as a notFound marker and is absent from the result (Node: `imageResources[id]`
// undefined). A miss is computed from the replica when s computes it (imageResourcesComputed), else
// it falls back (`image-resources-miss`); see computeImageResources.
func (s *Sources) imageResourcesFrom(ctx context.Context, imageIDs []int, got map[int]Entry, writable map[int]bool) (map[int][]ImageResource, error) {
	out := map[int][]ImageResource{}
	for id, e := range got {
		if e.NotFound {
			continue
		}
		list, ok := ResourcesFrom(e.Value)
		if !ok {
			return nil, fallback.New("image-resources-shape")
		}
		out[id] = list
	}
	miss := Missing(imageIDs, got)
	if len(miss) == 0 {
		return out, nil
	}
	if err := s.computeImageResources(ctx, miss, writable, out); err != nil {
		return nil, err
	}
	return out, nil
}

// imageResourcesComputed reports whether s answers an image-resources miss itself: with the miss
// computation and a replica, and only while the Node app's lookup reads the replica too, i.e. while
// ImageResourceUseWriteFlag is known to be off (MissCompute.ImageResourcesFromReplica). An unread
// flag (no reader, no successful read, or one older than the reader's staleness bound) is not off.
func (s *Sources) imageResourcesComputed() bool {
	return s != nil && s.Compute != nil && s.Replica != nil && s.Compute.ImageResourcesFromReplica != nil &&
		s.Compute.ImageResourcesFromReplica()
}

// sqlImageResources is imageResourcesCache's lookupFn query (src/server/redis/caches.ts), its joins,
// columns and filter unchanged (the IN list as `= ANY`, the enum and text columns as text), so the
// replica plans it as Node's lookup is planned and returns each image's rows in the same order: the
// query has no ORDER BY, and the order is the cached order (`modelVersionIds`, and the first
// Checkpoint's `baseModel`).
const sqlImageResources = `SELECT ir."imageId", ir."modelVersionId", ir.strength, ir.detected, m.id AS "modelId", m.name AS "modelName", m.type::text AS "modelType", mv.name AS "versionName", mv."baseModel"::text AS "baseModel", m.poi, m.minor
FROM "ImageResourceNew" ir
JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
JOIN "Model" m ON mv."modelId" = m.id
WHERE ir."imageId" = ANY($1::int[])`

// computeImageResources answers the image-resources misses miss into out as imageResourcesCache's
// lookupFn answers them on a plain fetch (an image with no row is absent, as its notFound marker
// is), or falls back (`image-resources-miss`) where that lookup would not read what this service
// reads:
//
//   - not imageResourcesComputed: no computation, or ImageResourceUseWriteFlag not known off (on, the
//     lookup reads the primary, dbWrite);
//   - a miss Node's fetch would not write back (writable false: a bust's `{debounce: true}` marker, or
//     a read that failed): a bust follows a resource write, the case a replica is most likely not to
//     show yet, so Node decides;
//   - any missed image carrying the `imageResource` lag flag, or a flag read that fails: the lookup
//     reads getDbWithoutLagBatch('imageResource', ids), the primary for a flagged id (lagFlagged, the
//     keys and value test lagAwareDB reads). Nothing in the Node app sets that flag today, so this
//     reads no flag in practice, at one pipeline per page with a miss.
//
// Then one query over every miss on the replica (sqlImageResources). A failed query falls back
// (`image-resources-miss-failed`). Nothing is written back and nothing is kept in process: the entry
// stays a miss until Node fills it. Each computed page counts its missed ids in s.Compute.Observe
// (MissImageResources, "computed" or "error"). Under a Go-first probe (WithPresence) the misses are
// recorded with their one lookup and answered as no entry, without a query.
func (s *Sources) computeImageResources(ctx context.Context, miss []int, writable map[int]bool, out map[int][]ImageResource) error {
	if !s.imageResourcesComputed() {
		return fallback.Safef("image-resources-miss", "%d ids", len(miss))
	}
	for _, id := range miss {
		if !writable[id] {
			return fallback.Safef("image-resources-miss", "%d ids", len(miss))
		}
	}
	if p := presenceOf(ctx); p != nil {
		p.recordComputed(MissImageResources, len(miss))
		return nil
	}
	if flagged, err := s.lagFlagged(ctx, "imageResource", miss); flagged || err != nil {
		return fallback.Safef("image-resources-miss", "%d ids", len(miss))
	}
	found, err := s.lookupImageResources(ctx, miss)
	if err != nil {
		s.Compute.observe(MissImageResources, "error", len(miss))
		return fallback.Wrap("image-resources-miss-failed", err)
	}
	s.Compute.observe(MissImageResources, "computed", len(miss))
	for id, list := range found {
		out[id] = list
	}
	return nil
}

// lookupImageResources runs sqlImageResources over ids on the replica: per image with a row, its
// resources in row order.
func (s *Sources) lookupImageResources(ctx context.Context, ids []int) (map[int][]ImageResource, error) {
	rows, err := s.Replica.Query(ctx, sqlImageResources, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	out := make(map[int][]ImageResource, len(ids))
	for _, m := range maps {
		id, ok := Int(m["imageId"])
		if !ok {
			return nil, fmt.Errorf("image resources: imageId %v", m["imageId"])
		}
		mv, ok := Int(m["modelVersionId"])
		if !ok {
			return nil, fmt.Errorf("image resources: modelVersionId %v", m["modelVersionId"])
		}
		detected, _ := m["detected"].(bool)
		out[id] = append(out[id], ImageResource{ModelVersionID: mv, Detected: detected, ModelType: m["modelType"], BaseModel: Wire(m["baseModel"])})
	}
	return out, nil
}

// ResourcesFrom reads the `resources` array of one cached ImageResourcesCacheItem.
func ResourcesFrom(m map[string]any) ([]ImageResource, bool) {
	raw, ok := m["resources"].([]any)
	if !ok {
		return nil, false
	}
	out := make([]ImageResource, 0, len(raw))
	for _, r := range raw {
		rm, ok := r.(map[string]any)
		if !ok {
			return nil, false
		}
		mv, ok := Int(rm["modelVersionId"])
		if !ok {
			return nil, false
		}
		detected, _ := rm["detected"].(bool)
		out = append(out, ImageResource{ModelVersionID: mv, Detected: detected, ModelType: rm["modelType"], BaseModel: Wire(rm["baseModel"])})
	}
	return out, true
}

// PostVersions is postVersionCache().fetch: each post's model version id (0 = none). A post the cache
// does not hold (or holds past its TTL) is read from the replica, as the cache's lookupFn reads it; a
// post found nowhere is absent (cacheNotFound is off for this cache).
func (s *Sources) PostVersions(ctx context.Context, postIDs []int) (map[int]int, error) {
	return s.idPairs(ctx, KeyPostVersion, ttlPostVersion, "modelVersionId", postIDs,
		`SELECT id, "modelVersionId" FROM "Post" WHERE id = ANY($1::int[])`)
}

// VersionModels is versionModelCache().fetch: each version's model id. A version found nowhere is
// absent.
func (s *Sources) VersionModels(ctx context.Context, versionIDs []int) (map[int]int, error) {
	return s.idPairs(ctx, KeyVersionModel, ttlVersionModel, "modelId", versionIDs,
		`SELECT id, "modelId" FROM "ModelVersion" WHERE id = ANY($1::int[])`)
}

func (s *Sources) idPairs(ctx context.Context, key string, ttl time.Duration, field string, ids []int, sql string) (map[int]int, error) {
	ids = Unique(ids)
	out := make(map[int]int, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	got := s.Packed.Get(ctx, key, ids, ttl)
	var miss []int
	for _, id := range ids {
		e, ok := got[id]
		// staleWhileRevalidate off: a stale entry is refetched, a (legacy) notFound marker too.
		if !ok || e.Stale || e.NotFound {
			miss = append(miss, id)
			continue
		}
		v, _ := Int(e.Value[field]) // a null version is 0
		out[id] = v
	}
	if len(miss) == 0 {
		return out, nil
	}
	rows, err := s.Replica.Query(ctx, sql, miss)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	for _, m := range maps {
		id, _ := Int(m["id"])
		v, _ := Int(m[field])
		out[id] = v
	}
	return out, nil
}

// UserIDByUsername is findUserIdByUsername's first read (`User.username = $1` on the replica).
func (s *Sources) UserIDByUsername(ctx context.Context, username string) (int, bool, error) {
	rows, err := s.Replica.Query(ctx, `SELECT id FROM "User" WHERE username = $1 LIMIT 1`, username)
	if err != nil {
		return 0, false, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil || len(maps) == 0 {
		return 0, false, err
	}
	id, ok := Int(maps[0]["id"])
	return id, ok, nil
}

// TagIDByName is the tag lookup by name the model feeds share (`dbRead.tag.findUnique({ where: {
// name } })` in getModelsRaw, for model.getAll and /api/v1/models): one row of "Tag" on the replica.
// Tag.name is citext, so the match is case-insensitive there, as on Node's replica; the name is
// passed as the request gave it. found is false when no tag has the name (no filter is added).
func TagIDByName(ctx context.Context, db Querier, name string) (id int, found bool, err error) {
	rows, err := db.Query(ctx, `SELECT id FROM "Tag" WHERE name = $1 LIMIT 1`, name)
	if err != nil {
		return 0, false, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil || len(maps) == 0 {
		return 0, false, err
	}
	id, ok := Int(maps[0]["id"])
	if !ok {
		return 0, false, fmt.Errorf("tag %q: id %v is not an integer", name, maps[0]["id"])
	}
	return id, true, nil
}
