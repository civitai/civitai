package hydrate

import (
	"context"
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

// imageResourcesFrom is imageResourcesCache.fetch for the public images endpoint (`includeBaseModel`)
// over the cache's answer got for (unique) image ids: per image, its resources in cached order. An
// image the lookup found none for is cached as a notFound marker and is absent from the result (Node:
// `imageResources[id]` undefined). A miss falls back: the lookup picks a replica by write lag
// (getDbWithoutLagBatch), which this service cannot.
func imageResourcesFrom(imageIDs []int, got map[int]Entry) (map[int][]ImageResource, error) {
	out := map[int][]ImageResource{}
	if miss := Missing(imageIDs, got); len(miss) > 0 {
		return nil, fallback.Safef("image-resources-miss", "%d ids", len(miss))
	}
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
