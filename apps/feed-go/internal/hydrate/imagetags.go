package hydrate

import (
	"context"
	"fmt"
	"sort"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/safe"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The votable tags of `include: ['tags']` (getAllImagesUncaptured in src/server/services/image.service.ts):
// getImageTagsForImages reads imageTagsCache (src/server/redis/caches.ts), and for a signed-in viewer
// their own TagsOnImageVote rows are merged in as `vote`.

// imageTagsTTL is imageTagsCache's ttl (CacheTTL.hour). staleWhileRevalidate is off, so an entry is
// never read as stale (Redis expires it at the same EX), and its notFound markers get the same EX (no
// notFoundTtl).
const imageTagsTTL = time.Hour

// imageTagsSpec is imageTagsCache's write shape: cacheNotFound (default) on. It is computed on a miss
// but not in WriteCaches, so this service never writes it.
var imageTagsSpec = lookupSpec{cache: MissImageTags, reason: "image-tags-miss", key: KeyImageTags, idKey: "imageId",
	ttl: imageTagsTTL, notFoundTTL: imageTagsTTL}

// imageTagsOf is Page's image tags over the stage-1 read of imageTagsCache: its misses computed (with
// s.Compute), the viewer's votes read alongside (ImageTagVotes), then imageTagsFrom.
func (s *Sources) imageTagsOf(ctx context.Context, images []int, read *PackedRead, viewerID int) (map[int][]any, error) {
	var votes []ImageTagVote
	g, gctx := errgroup.WithContext(ctx)
	g.Go(safe.Go(func() (err error) { votes, err = s.ImageTagVotes(gctx, images, viewerID); return }))
	got, writable := read.read()
	fillErr := s.fillImageTags(ctx, images, got, writable)
	if err := g.Wait(); err != nil && fillErr == nil {
		return nil, err
	}
	if fillErr != nil {
		return nil, fillErr
	}
	return imageTagsFrom(images, got, votes)
}

// fillImageTags computes the image-tags misses of got (imageTagsCache.fetch's lookup); a no-op without
// s.Compute (a miss then falls back in imageTagsFrom).
func (s *Sources) fillImageTags(ctx context.Context, images []int, got map[int]Entry, writable map[int]bool) error {
	if s.Compute == nil {
		return nil
	}
	return s.fill(ctx, imageTagsSpec, images, got, writable, true, nil, s.lookupImageTags)
}

// sqlImageTags is listImageTagsForImages (packages/civitai-db-queries/src/hot-reads.db.ts), the
// imageTagsCache lookupFn's query, on the replica (the fetch's lookupFn(ids) reads kyselyRead). The
// view's `score` is numeric and its vote counts bigint, which @civitai/db/kysely parses as JS numbers:
// read as float8 / int8 here. Enum columns as text. Ordered score desc, then tagId asc (the view's own
// score column, not the cast).
const sqlImageTags = `SELECT it."imageId", it."tagId", it."tagName", it."tagType"::text AS "tagType", it.score::float8 AS score,
	it."upVotes", it."downVotes", it."tagNsfwLevel", it.automated, it."needsReview", it.concrete, it."lastUpvote",
	it.source::text AS source
	FROM "ImageTag" it WHERE it."imageId" = ANY($1::int[]) ORDER BY it.score DESC, it."tagId" ASC`

// imageTagColumns are imageTagCompositeSelect's keys in the order the lookup's rows carry them (the
// cached record's order; imageId is the record's own key).
var imageTagColumns = []string{"tagId", "tagName", "tagType", "score", "upVotes", "downVotes", "tagNsfwLevel",
	"automated", "needsReview", "concrete", "lastUpvote", "source"}

// lookupImageTags is imageTagsCache's lookupFn: per image with at least one ImageTag row,
// `{imageId, tags}` with the rows in query order; an image with none is absent (a notFound marker).
func (s *Sources) lookupImageTags(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlImageTags, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	order := []int{}
	perImage := map[int][]any{}
	for _, m := range maps {
		iid, ok := Int(m["imageId"])
		if !ok {
			return nil, fmt.Errorf("image tags: row %v", m)
		}
		if _, seen := perImage[iid]; !seen {
			order = append(order, iid)
		}
		rec := make(jspack.Obj, 0, len(imageTagColumns))
		for _, k := range imageTagColumns {
			v, err := imageTagValue(m[k])
			if err != nil {
				return nil, fmt.Errorf("image tags: %s: %w", k, err)
			}
			rec = append(rec, jspack.KV{K: k, V: v})
		}
		perImage[iid] = append(perImage[iid], rec)
	}
	out := make(map[int]jspack.Obj, len(order))
	for _, id := range order {
		out[id] = jspack.O("imageId", id, "tags", perImage[id])
	}
	return out, nil
}

// imageTagValue is one ImageTag column as the JS value the Node row holds (numbers as float64 or an
// integer, the timestamp as a Date, NULL as null).
func imageTagValue(v any) (any, error) {
	switch t := v.(type) {
	case nil, string, bool, float64, time.Time:
		return t, nil
	case int64:
		return t, nil
	case int32:
		return int64(t), nil
	case int16:
		return int64(t), nil
	case int:
		return int64(t), nil
	case float32:
		return float64(t), nil
	}
	return nil, fmt.Errorf("unexpected %T", v)
}

// ImageTagVote is one TagsOnImageVote row of the viewer.
type ImageTagVote struct {
	ImageID, TagID, Vote int
}

// sqlImageTagVotes is the handler's `tagsOnImageVote.findMany({where: {imageId: {in}, userId}, select:
// {imageId, tagId, vote}})` on the replica (dbRead).
const sqlImageTagVotes = `SELECT "imageId", "tagId", vote FROM "TagsOnImageVote" WHERE "imageId" = ANY($1::int[]) AND "userId" = $2`

// ImageTagVotes reads the viewer's votes on the images' tags; none for a signed-out viewer (Node does
// not query then).
func (s *Sources) ImageTagVotes(ctx context.Context, imageIDs []int, viewerID int) ([]ImageTagVote, error) {
	if viewerID == 0 || len(imageIDs) == 0 {
		return nil, nil
	}
	rows, err := s.Replica.Query(ctx, sqlImageTagVotes, Unique(imageIDs), viewerID)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	out := make([]ImageTagVote, 0, len(maps))
	for _, m := range maps {
		iid, ok1 := Int(m["imageId"])
		tid, ok2 := Int(m["tagId"])
		vote, ok3 := Int(m["vote"])
		if !ok1 || !ok2 || !ok3 {
			return nil, fmt.Errorf("image tag votes: row %v", m)
		}
		out = append(out, ImageTagVote{iid, tid, vote})
	}
	return out, nil
}

// imageTagRestKeys are the cached record's keys getImageTagsForImages spreads through unchanged, in the
// record's order (every key but the four it renames).
var imageTagRestKeys = []string{"score", "upVotes", "downVotes", "automated", "needsReview", "concrete", "lastUpvote", "source"}

// imageTagRenamed are the keys getImageTagsForImages destructures out of the record and re-adds under
// a new name, plus the keys it sets itself (an extra cached key of that name is overwritten).
var imageTagRenamed = map[string]bool{"tagId": true, "tagName": true, "tagType": true, "tagNsfwLevel": true,
	"imageId": true, "id": true, "type": true, "nsfwLevel": true, "name": true}

// imageTagsFrom is getImageTagsForImages over the cache's answer got for (unique) image ids, then the
// handler's vote merge and its `tagsByImageId` grouping: per image with at least one tag, its tags in
// cached order, each `{...rest, imageId, id: tagId, type: tagType, nsfwLevel: tagNsfwLevel, name:
// tagName}` plus `vote` (1 for a vote > 0, else -1) when the viewer voted on that tag. An image whose
// entry is a notFound marker, or holds no tags, is absent (Node: `tags: undefined`). An id got does not
// answer falls back (with Sources.Compute, fillImageTags has computed the misses first), and so does an
// entry Node's `.tags.map` would throw on (image-tags-shape).
func imageTagsFrom(imageIDs []int, got map[int]Entry, votes []ImageTagVote) (map[int][]any, error) {
	if miss := Missing(imageIDs, got); len(miss) > 0 {
		return nil, fallback.Safef("image-tags-miss", "%d ids", len(miss))
	}
	voteOf := make(map[[2]int]int, len(votes))
	for _, v := range votes {
		voteOf[[2]int{v.ImageID, v.TagID}] = v.Vote // `new Map(entries)`: a repeated pair keeps the last
	}
	out := map[int][]any{}
	for _, id := range imageIDs {
		e := got[id]
		if e.NotFound {
			continue
		}
		list, ok := e.Value["tags"].([]any)
		if !ok {
			return nil, fallback.Safef("image-tags-shape", "image entry")
		}
		tags := make([]any, 0, len(list))
		for _, t := range list {
			m, ok := t.(map[string]any)
			if !ok {
				return nil, fallback.Safef("image-tags-shape", "tag entry")
			}
			tags = append(tags, imageTagWire(id, m, voteOf))
		}
		if len(tags) > 0 {
			out[id] = tags
		}
	}
	return out, nil
}

// imageTagWire is one tag as getImageTagsForImages builds it (with the viewer's vote merged).
func imageTagWire(imageID int, m map[string]any, voteOf map[[2]int]int) superjson.Object {
	obj := make(superjson.Object, 0, len(m)+2)
	seen := map[string]bool{}
	for _, k := range imageTagRestKeys {
		if v, ok := m[k]; ok {
			obj = append(obj, superjson.Field{Key: k, Val: Wire(v)})
			seen[k] = true
		}
	}
	var extra []string
	for k := range m {
		if !seen[k] && !imageTagRenamed[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	for _, k := range extra {
		obj = append(obj, superjson.Field{Key: k, Val: Wire(m[k])})
	}
	get := func(k string) any {
		v, ok := m[k]
		if !ok {
			return superjson.Undefined{}
		}
		return Wire(v)
	}
	obj = append(obj,
		superjson.Field{Key: "imageId", Val: int64(imageID)},
		superjson.Field{Key: "id", Val: get("tagId")},
		superjson.Field{Key: "type", Val: get("tagType")},
		superjson.Field{Key: "nsfwLevel", Val: get("tagNsfwLevel")},
		superjson.Field{Key: "name", Val: get("tagName")},
	)
	if tid, ok := Int(m["tagId"]); ok {
		if vote, voted := voteOf[[2]int{imageID, tid}]; voted {
			v := int64(-1)
			if vote > 0 {
				v = 1
			}
			obj = append(obj, superjson.Field{Key: "vote", Val: v})
		}
	}
	return obj
}
