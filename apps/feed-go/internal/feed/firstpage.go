package feed

import (
	"context"
	"sort"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// maxPinnedPosts is constants.modelGallery.maxPinnedPosts.
const maxPinnedPosts = 20

// fetchFunc is one getAllImages call (the Postgres path, whatever the page source is).
type fetchFunc func(ctx context.Context, q ImagesQuery) ([]Image, error)

// ImageResourceReader is getResourceIdsForImages (implemented by *GalleryStore).
type ImageResourceReader interface {
	ImageResources(ctx context.Context, imageIDs []int) (map[int][]int, error)
}

// firstPage is what the handler adds to a first page: the version's pinned posts and a sponsored
// post. Both are fetched with getAllImages whatever `image-index-feed` says.
type firstPage struct {
	pinned map[int][]Image
	// sponsored holds the sponsored post's approved images; empty = no sponsored post.
	sponsored []Image
}

// sponsoredPostID is `sponsored.length ? sponsoredPost?.postId : undefined` (0 = none).
func (f *firstPage) sponsoredPostID() int {
	if len(f.sponsored) == 0 {
		return 0
	}
	return f.sponsored[0].PostID
}

// firstPageArgs are the inputs of the handler's pinned and sponsored fetches.
type firstPageArgs struct {
	fetch      fetchFunc
	resources  ImageResourceReader
	promotions PromotionStore
	audience   PromotionAudience
	// viewer is nil when signed out (and for a banned session: see bannedSession).
	viewer *Viewer
	// bannedSession: a banned user's session, which Node still evaluates the flag for.
	bannedSession bool
	// q is the page's getAllImages query; the extra fetches drop its model scope and paging.
	q ImagesQuery
	// filtersAt is ResolveAddonFilters for this request at a browsing level. The pinned fetch runs at
	// the page's level and keeps q's filters; the sponsored fetch runs at its own level and takes these.
	filtersAt      func(level int) AddonFilters
	modelID        int
	modelVersionID int
	// pinnedIDs is the version's pinned post ids (gallery settings).
	pinnedIDs []int
	// browsingLevel / preCap are the input's levels after the held-level intersection.
	browsingLevel int
	preCap        *int
	now           time.Time
}

// extraQuery is the handler's `getAllImages({...input, modelVersionId: undefined, modelId:
// undefined, reviewId: undefined, postIds, limit})`: the request's filters, sort and period, no
// model scope and no cursor.
func extraQuery(q ImagesQuery, postIDs []int, limit int) ImagesQuery {
	x := q
	x.ModelID, x.ModelVersionID, x.Cursor, x.IDs, x.ThrowOnStatementTimeout = 0, 0, 0, nil, false
	x.PostIDs, x.Limit = postIDs, limit
	return x
}

// loadFirstPage runs the handler's first-page fetches, in its order: the pinned posts, then the
// sponsored post.
func loadFirstPage(ctx context.Context, a firstPageArgs) (*firstPage, error) {
	out := &firstPage{pinned: map[int][]Image{}}
	if len(a.pinnedIDs) > 0 {
		// Fetched whole (the ImageResourceNew join a version scope adds is an inner join, which
		// drops media with no resource rows) and narrowed to the version below.
		images, err := a.fetch(ctx, extraQuery(a.q, a.pinnedIDs, maxPinnedPosts*postImageLimit))
		if err != nil {
			return nil, err
		}
		if a.modelVersionID != 0 && len(images) > 0 {
			ids := make([]int, len(images))
			for i, img := range images {
				ids[i] = img.ID
			}
			res, err := a.resources.ImageResources(ctx, ids)
			if err != nil {
				return nil, err
			}
			images = filterPinnedToVersion(images, res, a.modelVersionID)
		}
		for _, img := range images {
			if img.PostID == 0 {
				continue
			}
			out.pinned[img.PostID] = append(out.pinned[img.PostID], img)
		}
	}

	if a.modelID == 0 || a.modelVersionID == 0 {
		return out, nil
	}
	on, known := a.audience.For(a.viewer, a.bannedSession)
	if known && !on {
		// getSponsoredGalleryPost returns before it reads anything.
		return out, nil
	}
	pick, err := SponsoredGalleryPost(ctx, a.promotions, a.modelID, a.modelVersionID, a.now)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if fallback.Reason(err) != "" {
			return nil, err
		}
		// Node's `.catch(() => undefined)` turns a failed lookup into no sponsored post, but this
		// service cannot tell whether Node's lookup failed too.
		return nil, fallback.Newf("sponsored-lookup", "%v", err)
	}
	if pick == nil {
		return out, nil
	}
	level := SponsoredBrowsingLevel(a.browsingLevel, a.preCap, pick.ServingLevel)
	if level == 0 || containsInt(a.pinnedIDs, pick.PostID) {
		return out, nil
	}
	q := extraQuery(a.q, []int{pick.PostID}, postImageLimit)
	q.BrowsingLevel = level
	// getAllImages({...input, browsingLevel: sponsoredLevel}) resolves the addons at that level, which
	// can hold R/X where the page's does not.
	f := a.filtersAt(level)
	q.ExcludedTagIDs, q.DisablePoi, q.DisableMinor = f.ExcludedTagIDs, f.DisablePoi, f.DisableMinor
	images, err := a.fetch(ctx, q)
	if err != nil {
		return nil, err
	}
	approved := make(map[int]bool, len(pick.ImageIDs))
	for _, id := range pick.ImageIDs {
		approved[id] = true
	}
	for _, img := range images {
		if approved[img.ID] {
			out.sponsored = append(out.sponsored, img)
		}
	}
	if len(out.sponsored) > 0 && !known {
		// The flag decides whether this viewer gets the post, and its audience is not evaluated here.
		return nil, fallback.New("sponsored-post")
	}
	return out, nil
}

// filterPinnedToVersion is filterPinnedImagesToVersion: media with no resource rows is kept (it
// cannot be attributed either way), the rest only when the version made it.
func filterPinnedToVersion(images []Image, resources map[int][]int, versionID int) []Image {
	out := make([]Image, 0, len(images))
	for _, img := range images {
		r := resources[img.ID]
		if len(r) == 0 || containsInt(r, versionID) {
			out = append(out, img)
		}
	}
	return out
}

// mergedPostIDs is `Object.values({...pinned, ...posts})`'s order: integer keys ascending.
func mergedPostIDs(pinned, posts map[int][]Image) []int {
	ids := make([]int, 0, len(pinned)+len(posts))
	for id := range pinned {
		ids = append(ids, id)
	}
	for id := range posts {
		if _, dup := pinned[id]; !dup {
			ids = append(ids, id)
		}
	}
	sort.Ints(ids)
	return ids
}

// assemble is the handler from `results` on: one post per merged id (pinned and page posts never
// share an id: the page loop skips every pinned id), the per-sort order with pinned posts first,
// then the sponsored post spliced in.
func assemble(fp *firstPage, posts map[int][]Image, sortBy string, reviews map[int]Review, lazy bool) []any {
	ids := mergedPostIDs(fp.pinned, posts)
	results := make([]post, 0, len(ids)+1)
	for _, id := range ids {
		images, pinned := fp.pinned[id]
		if !pinned {
			images = posts[id]
		}
		results = append(results, buildPost(id, images, sortBy, reviews, lazy, pinned))
	}
	sortPosts(results, sortBy)

	items := make([]any, 0, len(results)+1)
	for _, p := range results {
		items = append(items, p.wire)
	}
	if len(fp.sponsored) > 0 {
		pinnedCount := 0
		for _, p := range results {
			if p.pinned {
				pinnedCount++
			}
		}
		at := SponsoredSlotIndex(pinnedCount, len(items))
		items = append(items, nil)
		copy(items[at+1:], items[at:])
		items[at] = buildSponsored(fp.sponsored, lazy)
	}
	return items
}

// buildSponsored is the handler's sponsored entry: the post-level fields from its first approved
// image as fetched (no per-post index sort), no review.
func buildSponsored(images []Image, lazy bool) superjson.Object {
	first := images[0]
	nsfw := 0
	for _, img := range images {
		nsfw |= img.NsfwLevel
	}
	shown := images
	if lazy && len(shown) > GalleryPostImageSlice {
		shown = shown[:GalleryPostImageSlice]
	}
	wireImages := make([]any, len(shown))
	for i, img := range shown {
		wireImages[i] = img.Wire
	}
	wire := superjson.Object{
		{Key: "postId", Val: int64(first.PostID)},
		{Key: "pinned", Val: false},
		{Key: "sponsored", Val: true},
		{Key: "nsfwLevel", Val: int64(nsfw)},
		{Key: "modelVersionId", Val: first.ModelVerID},
		{Key: "publishedAt", Val: first.PublishedAt},
		{Key: "sortAt", Val: first.SortAt},
		{Key: "createdAt", Val: EarliestByJSDateString(images)},
		{Key: "user", Val: first.User},
	}
	if lazy {
		wire = append(wire, superjson.Field{Key: "imageCount", Val: int64(len(images))})
	}
	return append(wire,
		superjson.Field{Key: "images", Val: wireImages},
		superjson.Field{Key: "review", Val: superjson.Undefined{}},
	)
}
