package hydrate

import (
	"context"
	"strconv"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// frameCosmeticIDs is getCosmeticsForEntity({entity: 'Image'})'s first half over the frame cache's
// answer got for (unique) ids: the cosmetic ids to join (unordered, possibly repeated). The cached value
// is the raw lookup row `{cosmeticId, equippedToId, userData}`; the cache's appendFn joins it with the
// cosmetic record on every read, and joinFrames repeats that join. An id got does not answer falls
// back; with Sources.Compute, fillFrames has computed every miss into got before this runs.
func frameCosmeticIDs(imageIDs []int, got map[int]Entry) ([]int, error) {
	if miss := Missing(imageIDs, got); len(miss) > 0 {
		return nil, fallback.Safef("image-frame-miss", "%d ids", len(miss))
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
	return cosmeticIDs, nil
}

// joinFrames is the frame lookup's second half: each frame joined with its cosmetic record. cosmetics
// is cosmeticsFrom's answer for (at least) the ids frameCosmeticIDs returned; a record is a pure
// function of its id, so extra ids change nothing.
func joinFrames(got map[int]Entry, cosmetics map[int]superjson.Object) (map[int]superjson.Object, error) {
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

// VisibleEventDecorations is decorationsForEvents over the event-decoration cache's answer: an entry
// whose `data.event` is a string naming a visible event (isEventDecorationData), picked field by
// field so the wearer's `userId` (and any stale extra field) is not sent. An id the cache did not
// answer falls back (with Sources.Compute, fillEvents has computed the misses into got first).
func VisibleEventDecorations(imageIDs []int, got map[int]Entry, visibleEvents map[string]bool) (map[int]superjson.Object, error) {
	if miss := Missing(imageIDs, got); len(miss) > 0 {
		return nil, fallback.Safef("event-decoration-miss", "%d ids", len(miss))
	}
	out := map[int]superjson.Object{}
	for id, e := range got {
		if e.NotFound {
			continue
		}
		// The ordered record (an ordered cache): `data` keeps the key order Node's answer has.
		rec := e.Ordered()
		data, _ := ObjectField(rec, "data").(superjson.Object)
		event, ok := ObjectField(data, "event").(string)
		if !ok || !visibleEvents[event] {
			continue
		}
		out[id] = PickOrdered(rec, "id", "name", "type", "source", "data", "equippedToId", "equippedToType")
	}
	return out, nil
}

// Thumbnail is a video's thumbnail image (thumbnailCache value).
type Thumbnail struct {
	URL        any
	NsfwLevel  int
	HasNsfwKey bool
	// Width and Height are the thumbnail's own dimensions (the public images endpoint publishes them).
	Width  any
	Height any
	// Servable is a "blockMarked" field that is exactly false; true, null or no field is not servable.
	Servable bool
	// OwnerMediaAllowed is an "ownerMediaAllowed" field that is exactly true.
	OwnerMediaAllowed bool
}

// sqlThumbnailMiss is the thumbnail cache's two lookups as one statement (thumbnailRowsSql over the
// videos' thumbnailId): every row, with its block marker as "blockMarked".
var sqlThumbnailMiss = `
		SELECT t.id, t.url, t.width, t.height, t."nsfwLevel", cast(t.metadata->'parentId' as int) "parentId",
			` + HasBlockMarkerSQL("t") + ` AS "blockMarked"
		FROM "Image" t
		WHERE t.id IN (
			SELECT cast(metadata->'thumbnailId' as int) FROM "Image" WHERE id = ANY($1::int[]) AND type = 'video'
		)`

// thumbnailsFrom is getThumbnailsForImages(videoIds) over the cache's answer got for (unique) video ids
// (stale entries served). The miss path is the cache's own two queries, on the replica.
func (s *Sources) thumbnailsFrom(ctx context.Context, videoIDs []int, got map[int]Entry) (map[int]Thumbnail, error) {
	out := map[int]Thumbnail{}
	for id, e := range got {
		if !e.NotFound {
			out[id] = thumbFrom(e.Value)
		}
	}
	miss := Missing(videoIDs, got)
	if len(miss) == 0 {
		return out, nil
	}
	rows, err := s.Replica.Query(ctx, sqlThumbnailMiss, miss)
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
	marked, isBool := m["blockMarked"].(bool)
	return Thumbnail{URL: m["url"], NsfwLevel: n, HasNsfwKey: ok, Width: Wire(m["width"]), Height: Wire(m["height"]), Servable: isBool && !marked}
}

// Metrics is one image's metric counts (MetricService over `metrics:Image:<id>` hashes).
type Metrics map[string]int

// metricHashKey is cacheKeys.metric (event-engine-common/utils/cache-keys.ts); never namespace-prefixed.
func metricHashKey(id int) string { return "metrics:Image:" + strconv.Itoa(id) }

func metricsReadFailed(err error) error { return fallback.Wrap("metrics-read-failed", err) }

// MetricsFromHashes is the per-id half of ImageMetrics: hashes[i] is the `metrics:Image:<ids[i]>`
// hash as HGETALL returned it. An empty hash (no key) falls back; any other hash is an entry, a
// `notFound` marker as an entry with no counts.
func MetricsFromHashes(ids []int, hashes []map[string]string) (map[int]Metrics, error) {
	out := make(map[int]Metrics, len(ids))
	for i, id := range ids {
		hash := hashes[i]
		if len(hash) == 0 {
			return nil, fallback.New("metrics-miss")
		}
		m, ok := ParseMetricHash(hash)
		if !ok {
			m = Metrics{} // notFound: known, every count 0 (see above)
		}
		out[id] = m
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

// tagIDsFrom is tagIdsForImagesCache.fetch over the cache's answer got for (unique) image ids: per
// image, the `tags` id array. An id got does not answer falls back (with Sources.Compute, fillTagIDs
// has computed the misses into got first). Read with tagIDsTTL; stale entries are revalidated before
// this runs (revalidateStaleTagIDs).
func tagIDsFrom(imageIDs []int, got map[int]Entry) (map[int]any, error) {
	if miss := Missing(imageIDs, got); len(miss) > 0 {
		return nil, fallback.Safef("tag-ids-miss", "%d ids", len(miss))
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
