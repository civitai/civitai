package hydrate

import (
	"context"
	"errors"
	"strconv"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// ImageFrames is getCosmeticsForEntity({entity: 'Image'}): the content-decoration cosmetic each image
// wears. The cached value is the raw lookup row `{cosmeticId, equippedToId, userData}`; the cache's
// appendFn joins it with the cosmetic record on every read, and that join is repeated here.
// A frame miss falls back: its lookup reads the primary and filters withheld creator cosmetics.
func (s *Sources) ImageFrames(ctx context.Context, imageIDs []int) (map[int]superjson.Object, error) {
	imageIDs = Unique(imageIDs)
	got := s.Packed.Get(ctx, KeyImageFrames, imageIDs, 0)
	if miss := Missing(imageIDs, got); len(miss) > 0 {
		return nil, fallback.Newf("image-frame-miss", "%d ids", len(miss))
	}
	var cosmeticIDs []int
	for _, e := range got {
		if e.NotFound {
			continue
		}
		if cid, ok := Int(e.Value["cosmeticId"]); ok {
			cosmeticIDs = append(cosmeticIDs, cid)
		}
	}
	cosmetics, err := s.Cosmetics(ctx, cosmeticIDs)
	if err != nil {
		return nil, err
	}
	out := map[int]superjson.Object{}
	for id, e := range got {
		if e.NotFound {
			continue
		}
		frame, ok := JoinFrame(e.Value, cosmetics)
		if !ok {
			// appendFn leaves a record whose cosmetic is gone un-joined; that shape is not ported.
			return nil, fallback.New("image-frame-cosmetic-missing")
		}
		out[id] = frame
	}
	return out, nil
}

// JoinFrame repeats the frame cache's appendFn and getCosmeticsForEntity's claimKey strip. The JS
// mutates the record in place (adds `id`, deletes `cosmeticId`, sets `data`, deletes a truthy
// `userData`), so a record whose userData is null keeps `userData: null`.
func JoinFrame(raw map[string]any, cosmetics map[int]superjson.Object) (superjson.Object, bool) {
	cid, _ := Int(raw["cosmeticId"])
	cosmetic, ok := cosmetics[cid]
	if !ok {
		return nil, false
	}
	data, _ := cosmetic.Get("data")
	userData := raw["userData"]
	if ud, ok := userData.(map[string]any); ok {
		if lights, ok := ud["lights"]; ok && truthyJS(lights) {
			merged := superjson.Object{}
			if dobj, ok := data.(superjson.Object); ok {
				merged = append(merged, dobj...)
			}
			merged.Set("lights", Wire(lights))
			data = merged
		}
	}
	obj := superjson.Object{{Key: "equippedToId", Val: Wire(raw["equippedToId"])}}
	if !truthyJS(userData) {
		obj = append(obj, superjson.Field{Key: "userData", Val: Wire(userData)})
	}
	obj = append(obj, superjson.Field{Key: "id", Val: int64(cid)}, superjson.Field{Key: "data", Val: data})
	return obj, true
}

// truthyJS is JS truthiness for decoded values.
func truthyJS(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case int64:
		return t != 0
	case uint64:
		return t != 0
	case float64:
		return t != 0
	}
	return true // objects and arrays
}

// EventDecorations is getEventDecorationsForEntity for the events visible to every viewer (see
// DESIGN.md: per-viewer event access is not ported; the visible set is configuration). Empty when no
// event is visible, as in Node. A miss falls back (its lookup reads the primary).
func (s *Sources) EventDecorations(ctx context.Context, imageIDs []int, visibleEvents map[string]bool) (map[int]superjson.Object, error) {
	out := map[int]superjson.Object{}
	imageIDs = Unique(imageIDs)
	if len(imageIDs) == 0 || len(visibleEvents) == 0 {
		return out, nil
	}
	got := s.Packed.Get(ctx, KeyImageEvents, imageIDs, 0)
	if miss := Missing(imageIDs, got); len(miss) > 0 {
		return nil, fallback.Newf("event-decoration-miss", "%d ids", len(miss))
	}
	for id, e := range got {
		if e.NotFound {
			continue
		}
		data, _ := e.Value["data"].(map[string]any)
		event, _ := data["event"].(string)
		if event == "" || !visibleEvents[event] {
			continue
		}
		out[id] = Pick(e.Value, "id", "name", "type", "source", "data", "equippedToId", "equippedToType")
	}
	return out, nil
}

// Thumbnail is a video's thumbnail image (thumbnailCache value).
type Thumbnail struct {
	URL        any
	NsfwLevel  int
	HasNsfwKey bool
}

// Thumbnails is getThumbnailsForImages(videoIds). The miss path is the cache's own two queries.
func (s *Sources) Thumbnails(ctx context.Context, videoIDs []int) (map[int]Thumbnail, error) {
	videoIDs = Unique(videoIDs)
	out := map[int]Thumbnail{}
	if len(videoIDs) == 0 {
		return out, nil
	}
	got := s.Packed.Get(ctx, KeyThumbnails, videoIDs, ttlDay)
	for id, e := range got {
		if !e.NotFound {
			out[id] = thumbFrom(e.Value)
		}
	}
	miss := Missing(videoIDs, got)
	if len(miss) == 0 {
		return out, nil
	}
	rows, err := s.Replica.Query(ctx, `
		SELECT t.id, t.url, t.width, t.height, t."nsfwLevel", cast(t.metadata->'parentId' as int) "parentId"
		FROM "Image" t
		WHERE t.id IN (
			SELECT cast(metadata->'thumbnailId' as int) FROM "Image" WHERE id = ANY($1::int[]) AND type = 'video'
		)`, miss)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	for _, m := range maps {
		if parent, ok := Int(m["parentId"]); ok {
			out[parent] = thumbFrom(m)
		}
	}
	return out, nil
}

func thumbFrom(m map[string]any) Thumbnail {
	n, ok := Int(m["nsfwLevel"])
	return Thumbnail{URL: m["url"], NsfwLevel: n, HasNsfwKey: ok}
}

// Metrics is one image's metric counts (MetricService over `metrics:Image:<id>` hashes).
type Metrics map[string]int

// metricHashKey is cacheKeys.metric (event-engine-common/utils/cache-keys.ts); never namespace-prefixed.
func metricHashKey(id int) string { return "metrics:Image:" + strconv.Itoa(id) }

// ImageMetrics reads the watcher-fed metric hashes. An image with no hash at all is a miss and falls
// back (the Node path populates it from ClickHouse); a `notFound` marker means "no metrics", which is
// absent from the result exactly as in MetricService.parseCachedMetrics.
func (s *Sources) ImageMetrics(ctx context.Context, imageIDs []int) (map[int]Metrics, error) {
	imageIDs = Unique(imageIDs)
	out := map[int]Metrics{}
	if len(imageIDs) == 0 {
		return out, nil
	}
	cmds := make([]*redis.MapStringStringCmd, len(imageIDs))
	_, err := s.Cache.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, id := range imageIDs {
			cmds[i] = p.HGetAll(ctx, metricHashKey(id))
		}
		return nil
	})
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, fallback.Newf("metrics-read-failed", "%v", err)
	}
	for i, cmd := range cmds {
		hash, err := cmd.Result()
		if err != nil {
			return nil, fallback.Newf("metrics-read-failed", "%v", err)
		}
		if len(hash) == 0 {
			return nil, fallback.New("metrics-miss")
		}
		if m, ok := ParseMetricHash(hash); ok {
			out[imageIDs[i]] = m
		}
	}
	return out, nil
}

// ParseMetricHash is MetricService.parseCachedMetrics: every field but `notFound`/`_populatedAt` is a
// parseInt'd count; a hash with no metric field and `notFound: '1'` is "not found".
func ParseMetricHash(hash map[string]string) (Metrics, bool) {
	m := Metrics{}
	has := false
	for k, v := range hash {
		if k == "notFound" || k == "_populatedAt" {
			continue
		}
		n, _ := parseIntJS(v)
		m[k] = n
		has = true
	}
	if !has && hash["notFound"] == "1" {
		return nil, false
	}
	return m, true
}

// parseIntJS approximates parseInt(v, 10) for the decimal strings the watcher writes.
func parseIntJS(s string) (int, bool) {
	end := 0
	if end < len(s) && (s[end] == '-' || s[end] == '+') {
		end++
	}
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	n, err := strconv.Atoi(s[:end])
	return n, err == nil
}

// Stats is toImageV2Stats(shapeImageMetrics(...)): `metric || null` then `?? 0`, i.e. a missing or
// zero count is 0; statsUnknown is true only when the image has no metrics entry at all.
func Stats(m Metrics, ok bool) superjson.Object {
	g := func(k string) int64 {
		if !ok {
			return 0
		}
		return int64(m[k])
	}
	return superjson.Object{
		{Key: "likeCountAllTime", Val: g("Like")},
		{Key: "laughCountAllTime", Val: g("Laugh")},
		{Key: "heartCountAllTime", Val: g("Heart")},
		{Key: "cryCountAllTime", Val: g("Cry")},
		{Key: "commentCountAllTime", Val: g("commentCount")},
		{Key: "collectedCountAllTime", Val: g("Collection")},
		{Key: "tippedAmountCountAllTime", Val: g("tippedAmount")},
		{Key: "dislikeCountAllTime", Val: int64(0)},
		{Key: "viewCountAllTime", Val: int64(0)},
		{Key: "statsUnknown", Val: !ok},
	}
}

// TagIDs is tagIdsForImagesCache.fetch: per image, the `tags` id array. A miss falls back (the lookup
// joins the tag cache and drops some Rekognition tags; not ported). The cache is served stale (8h ttl).
func (s *Sources) TagIDs(ctx context.Context, imageIDs []int) (map[int]any, error) {
	imageIDs = Unique(imageIDs)
	got := s.Packed.Get(ctx, KeyTagIDs, imageIDs, 0)
	if miss := Missing(imageIDs, got); len(miss) > 0 {
		return nil, fallback.Newf("tag-ids-miss", "%d ids", len(miss))
	}
	out := map[int]any{}
	for id, e := range got {
		if e.NotFound {
			continue
		}
		if tags, ok := e.Value["tags"]; ok {
			out[id] = Wire(tags)
		}
	}
	return out, nil
}

// Reactions is getUserReactionsForImages: the viewer's own reactions per image, as the wire array
// `[{userId, reaction}]` in row order.
func (s *Sources) Reactions(ctx context.Context, imageIDs []int, viewerID int) (map[int][]any, error) {
	out := map[int][]any{}
	if viewerID == 0 || len(imageIDs) == 0 {
		return out, nil
	}
	rows, err := s.Replica.Query(ctx, `SELECT "imageId", reaction FROM "ImageReaction" WHERE "imageId" = ANY($1::int[]) AND "userId" = $2`, Unique(imageIDs), viewerID)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	for _, m := range maps {
		id, _ := Int(m["imageId"])
		out[id] = append(out[id], superjson.Object{{Key: "userId", Val: int64(viewerID)}, {Key: "reaction", Val: m["reaction"]}})
	}
	return out, nil
}

// VisibleModel3DIDs is getVisibleModel3DIds: a linked Model3D id stays only when the viewer may see it
// (moderator, owner, or published and not deleted — model3d.visibility.ts).
func (s *Sources) VisibleModel3DIDs(ctx context.Context, ids []int, viewerID int, isModerator bool) (map[int]bool, error) {
	out := map[int]bool{}
	ids = Unique(ids)
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.Replica.Query(ctx, `SELECT id, "userId", status, "deletedAt" FROM "Model3D" WHERE id = ANY($1::int[])`, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	for _, m := range maps {
		id, _ := Int(m["id"])
		owner, _ := Int(m["userId"])
		status, _ := m["status"].(string)
		if isModerator || (viewerID != 0 && owner == viewerID) || (status == "Published" && m["deletedAt"] == nil) {
			out[id] = true
		}
	}
	return out, nil
}
