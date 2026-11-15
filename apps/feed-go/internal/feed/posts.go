package feed

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// Config holds the values the Node path reads from feature flags or env that this service takes as
// configuration (see DESIGN.md "Flags"). When a flag turns on a shape not ported here, the matching
// field makes those requests fall back instead of being answered wrong.
type Config struct {
	// CreatorPromotions mirrors the `creator-promotions` flag's audience: who a first model-version
	// gallery page may carry a sponsored post for (PromotionAudience).
	CreatorPromotions PromotionAudience
	// LazyPostImages mirrors `gallery-lazy-post-images`: on, each post is completed to its whole
	// image set, then sent as its first GalleryPostImageSlice images plus `imageCount`.
	LazyPostImages bool
	// ImageIndexFeed mirrors `image-index-feed`: on, the pages come from the feed service
	// (getAllImagesIndex) instead of the Postgres query (getAllImages).
	ImageIndexFeed bool
	// VisibleDecorationEvents is the set of event decorations every viewer may see.
	VisibleDecorationEvents map[string]bool
}

// AddonSource reads `system:browsing-setting-addons` from the system redis.
type AddonSource struct {
	Sys redis.UniversalClient
}

// Addons returns the configured addons, or the defaults when the key is absent, unreadable or invalid
// (getBrowsingSettingAddons fails to the defaults the same way).
func (a *AddonSource) Addons(ctx context.Context) []browsing.Addon {
	if a == nil || a.Sys == nil {
		return browsing.DefaultAddons
	}
	raw, err := a.Sys.Get(ctx, "system:browsing-setting-addons").Bytes()
	if err != nil {
		return browsing.DefaultAddons
	}
	var addons []browsing.Addon
	if json.Unmarshal(raw, &addons) != nil || addons == nil {
		return browsing.DefaultAddons
	}
	return addons
}

// Deps are the handler's collaborators.
type Deps struct {
	DB       Querier
	Cache    *QueryCache
	Hydrator Hydrator
	Gallery  *GalleryStore
	Addons   *AddonSource
	// Feed is the feed service; nil = not configured (index-path requests fall back).
	Feed FeedFetcher
	// Promotions and Resources default to Gallery (tests replace them).
	Promotions PromotionStore
	Resources  ImageResourceReader
	Config     Config
	Now        func() time.Time
}

func (d *Deps) promotions() PromotionStore {
	if d.Promotions != nil {
		return d.Promotions
	}
	return d.Gallery
}

func (d *Deps) resources() ImageResourceReader {
	if d.Resources != nil {
		return d.Resources
	}
	return d.Gallery
}

// Request is one call.
type Request struct {
	Input *Input
	// Viewer is nil when signed out.
	Viewer *Viewer
	// BannedSession is a session whose user is banned. Viewer is then nil (the procedures see no
	// user), but Node still evaluates feature flags with that session's user.
	BannedSession bool
	// Cap is the domain cap (browsing.DomainCap); 0 = uncapped.
	Cap int
}

// AddonFilters is what enforceBlockedBrowsingTags (the addon half; tag filters are a fallback
// shape) and applyHideChallengesExclusion leave on a getAllImages input.
type AddonFilters struct {
	ExcludedTagIDs []int
	DisablePoi     bool
	DisableMinor   bool
}

// ResolveAddonFilters is those two steps for one getAllImages call at browsingLevel: Node runs them
// on a copy of the input for every call, so each call resolves the addons at its own level.
func ResolveAddonFilters(in *Input, addons []browsing.Addon, browsingLevel int, isModerator bool) AddonFilters {
	level := browsing.OnlySelectable(orInt(browsingLevel, browsing.PublicLevels))
	if level == 0 {
		level = browsing.PublicLevels
	}
	resolved := browsing.ResolveAddons(addons, level, isModerator, "")
	// In the order Node's input holds them: as sent, then (when any) the addons' tags unioned in by a
	// Set, then the challenge tag unioned in. The feed-service query sends this list as is.
	excluded := append([]int(nil), in.ExcludedTagIDs...)
	if len(resolved.ExcludedTagIDs) > 0 {
		excluded = unionInts(excluded, resolved.ExcludedTagIDs)
	}
	if in.HideChallenges {
		excluded = unionInts(excluded, []int{challengeTagID})
	}
	return AddonFilters{
		ExcludedTagIDs: excluded,
		DisablePoi:     in.DisablePoi || resolved.DisablePoi,
		DisableMinor:   in.DisableMinor || resolved.DisableMinor,
	}
}

// Result is the procedure's value: `{nextCursor, items}`.
type Result struct {
	NextCursor Cursor
	Items      []any
}

// Value returns the superjson value of the result.
func (r *Result) Value() superjson.Object {
	next := r.NextCursor.value()
	items := r.Items
	if items == nil {
		items = []any{}
	}
	return superjson.Object{{Key: "nextCursor", Val: next}, {Key: "items", Val: items}}
}

var empty = &Result{}

// Serve is getImagesAsPostsInfiniteHandler for the supported subset.
func Serve(ctx context.Context, d *Deps, req Request) (*Result, error) {
	in := req.Input
	now := time.Now()
	if d.Now != nil {
		now = d.Now()
	}
	if d.Config.ImageIndexFeed && d.Feed == nil {
		return nil, fallback.New("index-feed-unconfigured")
	}
	inCursor := Cursor{N: in.Cursor, S: in.CursorText}
	var viewer Viewer
	if req.Viewer != nil {
		viewer = *req.Viewer
	}
	browsingLevel, preCap := in.ApplyDomainCap(req.Cap)

	// Model-gallery gates: settings, the held level of minor / SFW-only models, taken-down models.
	var modelIDs []int
	if in.ModelID != 0 {
		modelIDs = append(modelIDs, in.ModelID)
	}
	versionMissing := false
	if in.ModelVersionID != 0 {
		mid, err := d.Gallery.VersionModel(ctx, in.ModelVersionID)
		if err != nil {
			return nil, err
		}
		if mid == 0 {
			versionMissing = true
		} else if mid != in.ModelID {
			modelIDs = append(modelIDs, mid)
		}
	}
	var settings *GallerySettings
	if in.ModelID != 0 {
		s, err := d.Gallery.Settings(ctx, in.ModelID)
		if err != nil {
			return nil, err
		}
		settings = s
	}
	if !viewer.IsModerator {
		if versionMissing {
			// resolveImageModelIds returned null: held level 0 and withheld.
			return empty, nil
		}
		withheld, err := d.Gallery.Withheld(ctx, modelIDs, viewer.ID)
		if err != nil {
			return nil, err
		}
		if withheld {
			return empty, nil
		}
		held, isHeld := 0, false
		for _, mid := range modelIDs {
			s := settings
			if mid != in.ModelID {
				var err error
				if s, err = d.Gallery.Settings(ctx, mid); err != nil {
					return nil, err
				}
			}
			if lvl, ok := s.HeldLevel(); ok {
				if !isHeld {
					held = browsing.AllLevels
				}
				held &= lvl
				isHeld = true
			}
		}
		if isHeld {
			// preCapBrowsingLevel: (preCap ?? browsingLevel) & held, from the level before the hold.
			pc := browsingLevel
			if preCap != nil {
				pc = *preCap
			}
			pc &= held
			preCap = &pc
			browsingLevel &= held
			if browsingLevel == 0 {
				return empty, nil
			}
		}
	}
	pinned := settings.PinnedFor(in.ModelVersionID)

	// getAllImages resolves its addon exclusions at each call's own browsing level, so the page and
	// the sponsored fetch (which runs at the sponsored level) each get their own.
	addons := d.Addons.Addons(ctx)
	filtersAt := func(lvl int) AddonFilters { return ResolveAddonFilters(in, addons, lvl, viewer.IsModerator) }
	pageFilters := filtersAt(browsingLevel)
	excluded := pageFilters.ExcludedTagIDs
	disablePoi := pageFilters.DisablePoi
	disableMinor := pageFilters.DisableMinor

	q := ImagesQuery{
		Limit:          int(math.Ceil(float64(in.Limit) * 2)), // overscan, so posts can be merged
		Sort:           in.Sort,
		Period:         in.Period,
		PeriodMode:     in.PeriodMode,
		BrowsingLevel:  browsingLevel,
		ModelID:        in.ModelID,
		ModelVersionID: in.ModelVersionID,
		Model3DID:      in.Model3DID,
		Types:          in.Types,
		Generation:     in.Generation,
		WithMeta:       in.WithMeta,
		FromPlatform:   in.FromPlatform,
		DisablePoi:     disablePoi,
		DisableMinor:   disableMinor,
		ExcludedTagIDs: excluded,
		ExcludedUsers:  in.ExcludedUserIDs,
		ViewerID:       viewer.ID,
		IsModerator:    viewer.IsModerator,
	}

	overscan := int(math.Ceil(float64(in.Limit) * 2)) // so posts can be merged
	var src pageSource
	if d.Config.ImageIndexFeed {
		// feedHydrateQuery: the feed already applied the paging, the period and the model scope.
		hq := q
		hq.ModelID, hq.ModelVersionID, hq.Period, hq.Cursor = 0, 0, "AllTime", 0
		hq.ThrowOnStatementTimeout = true
		src = &indexSource{
			feed: d.Feed,
			base: feedsvc.Query{
				BrowsingLevel:   browsingLevel,
				ExcludedTagIDs:  excluded,
				ExcludedUserIDs: in.ExcludedUserIDs,
				ModelID:         in.ModelID,
				ModelVersionID:  in.ModelVersionID,
				Model3DID:       in.Model3DID,
				Types:           in.Types,
				WithMeta:        in.WithMetaFlag,
				FromPlatform:    in.FromPlatform,
				DisableMinor:    disableMinor,
				DisablePoi:      disablePoi,
				ViewerID:        viewer.ID,
				Sort:            in.Sort,
				Period:          in.Period,
				HasGeneration:   len(in.Generation) > 0,
				HasRemixOfID:    in.HasRemixOfID,
				RequiringMeta:   in.RequiringMeta,
			},
			hydrate: func(ctx context.Context, ids, postIDs []int) ([]Image, error) {
				h := hq
				h.IDs, h.PostIDs, h.Limit = ids, postIDs, len(ids)
				page, err := FetchImages(ctx, d.DB, d.Cache, d.Hydrator, h, viewer, d.Config.VisibleDecorationEvents, now)
				if err != nil {
					return nil, err
				}
				return page.Images, nil
			},
		}
	} else {
		if !in.NumericCursor() {
			// getCursor reads a single-field sort's cursor as one integer; anything else is a 400.
			return nil, fallback.Newf("input-cursor", "%q", in.CursorText)
		}
		src = &dbSource{d: d, q: q, viewer: viewer, now: now}
	}

	// The first page's pinned posts and sponsored post, before the page loop (which skips both).
	fp := &firstPage{}
	if inCursor.None() {
		fetch := func(ctx context.Context, q ImagesQuery) ([]Image, error) {
			page, err := FetchImages(ctx, d.DB, d.Cache, d.Hydrator, q, viewer, d.Config.VisibleDecorationEvents, now)
			if err != nil {
				return nil, err
			}
			return page.Images, nil
		}
		var err error
		fp, err = loadFirstPage(ctx, firstPageArgs{
			fetch:          fetch,
			resources:      d.resources(),
			promotions:     d.promotions(),
			audience:       d.Config.CreatorPromotions,
			viewer:         req.Viewer,
			q:              q,
			filtersAt:      filtersAt,
			bannedSession:  req.BannedSession,
			modelID:        in.ModelID,
			modelVersionID: in.ModelVersionID,
			pinnedIDs:      pinned,
			browsingLevel:  browsingLevel,
			preCap:         preCap,
			now:            now,
		})
		if err != nil {
			return nil, err
		}
	}
	// Past page 1 the pinned posts are not fetched, but their images are still kept off the page.
	skip := make(map[int]bool, len(pinned)+1)
	for _, id := range pinned {
		skip[id] = true
	}
	if id := fp.sponsoredPostID(); id != 0 {
		skip[id] = true
	}

	posts, cursor, err := collectPosts(ctx, src, inCursor, overscan, in.Limit, skip)
	if err != nil {
		return nil, err
	}

	// Object.values over integer keys: ascending postId. The sorts below are stable on that order.
	postIDs := make([]int, 0, len(posts))
	for id := range posts {
		postIDs = append(postIDs, id)
	}
	sort.Ints(postIDs)

	if d.Config.LazyPostImages {
		// Without counts every post is completed (getPostImageCounts' failure is logged, not thrown).
		counts, err := PostImageCounts(ctx, d.DB, postIDs)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			counts = nil
		}
		if err := completePosts(ctx, src, posts, postIDs, counts); err != nil {
			return nil, err
		}
	}

	var reviews map[int]Review
	if in.ModelID != 0 || in.ModelVersionID != 0 {
		// The creators of every merged post, pinned ones included (not the sponsored post).
		var userIDs []int
		seen := map[int]bool{}
		for _, id := range mergedPostIDs(fp.pinned, posts) {
			images, ok := fp.pinned[id]
			if !ok {
				images = posts[id]
			}
			uid := userIDOf(images[0])
			if !seen[uid] {
				seen[uid] = true
				userIDs = append(userIDs, uid)
			}
		}
		var err error
		if reviews, err = d.Gallery.Reviews(ctx, userIDs, in.ModelID, in.ModelVersionID, viewer.ID); err != nil {
			return nil, err
		}
	}

	items := assemble(fp, posts, in.Sort, reviews, d.Config.LazyPostImages)
	return &Result{NextCursor: cursor, Items: items}, nil
}

// collectPosts is the handler's page loop: fetch from cursor, merge images by postId (skipping images
// with no post and the pinned posts), and stop at the end of the feed or once limit posts are held.
// It returns the posts and the cursor the response carries. skip holds the pinned post ids and the
// sponsored post's id.
func collectPosts(ctx context.Context, src pageSource, cursor Cursor, overscan, limit int, skip map[int]bool) (map[int][]Image, Cursor, error) {
	posts := map[int][]Image{}
	for {
		images, next, err := src.Page(ctx, cursor, overscan)
		if err != nil {
			return nil, Cursor{}, err
		}
		for _, img := range images {
			if img.PostID == 0 || skip[img.PostID] {
				continue
			}
			posts[img.PostID] = append(posts[img.PostID], img)
		}
		cursor = next
		if cursor.None() || len(posts) >= limit {
			return posts, cursor, nil
		}
	}
}

// unionInts is `[...new Set([...a, ...b])]`: a's order first, duplicates dropped.
func unionInts(a, b []int) []int {
	seen := make(map[int]bool, len(a)+len(b))
	out := make([]int, 0, len(a)+len(b))
	for _, list := range [][]int{a, b} {
		for _, n := range list {
			if !seen[n] {
				seen[n] = true
				out = append(out, n)
			}
		}
	}
	return out
}

func orInt(v, def int) int {
	if v == 0 {
		return def
	}
	return v
}

func userIDOf(img Image) int {
	v, _ := img.User.Get("id")
	n, _ := v.(int64)
	return int(n)
}

type post struct {
	wire      superjson.Object
	pinned    bool
	createdAt time.Time
	reactions int64
	comments  int64
	collected int64
}

func statOf(stats superjson.Object, key string) int64 {
	v, _ := stats.Get(key)
	n, _ := v.(int64)
	return n
}

// GalleryPostImageSlice is GALLERY_POST_IMAGE_SLICE: the images a post carries with lazy post images on.
const GalleryPostImageSlice = 6

// buildPost is the per-post `results` map of the handler (the sponsored post is buildSponsored).
// lazy is buildPostImagesWire's `lazy`: the first GalleryPostImageSlice images (after the Newest index
// sort) and `imageCount`, the post's whole count, before `images`. pinned is `!!pinned[postId]`.
func buildPost(postID int, images []Image, sortBy string, reviews map[int]Review, lazy, pinned bool) post {
	// The post-level fields come from the first image as fetched: the handler destructures it BEFORE
	// it sorts a Newest post's images by index.
	first := images[0]
	createdAt := EarliestByJSDateString(images)
	if sortBy == SortNewest {
		images = append([]Image(nil), images...)
		sort.SliceStable(images, func(a, b int) bool {
			if images[a].Index != images[b].Index {
				return images[a].Index < images[b].Index
			}
			return images[a].ID < images[b].ID
		})
	}
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
	var review any = superjson.Undefined{}
	if r, ok := reviews[userIDOf(first)]; ok {
		var details any
		if r.Details != nil {
			details = *r.Details
		}
		review = superjson.Object{
			{Key: "rating", Val: int64(r.Rating)},
			{Key: "details", Val: details},
			{Key: "recommended", Val: r.Recommended},
			{Key: "id", Val: int64(r.ID)},
		}
	}
	wire := superjson.Object{
		{Key: "postId", Val: int64(postID)},
		{Key: "pinned", Val: pinned},
		{Key: "sponsored", Val: false},
		{Key: "nsfwLevel", Val: int64(nsfw)},
		{Key: "modelVersionId", Val: first.ModelVerID},
		{Key: "publishedAt", Val: first.PublishedAt},
		{Key: "sortAt", Val: first.SortAt},
		{Key: "createdAt", Val: createdAt},
		{Key: "user", Val: first.User},
	}
	if lazy {
		wire = append(wire, superjson.Field{Key: "imageCount", Val: int64(len(images))})
	}
	wire = append(wire,
		superjson.Field{Key: "images", Val: wireImages},
		superjson.Field{Key: "review", Val: review},
	)
	// getReactionTotals & co. read `images[0]` of the built post, i.e. after the Newest index sort.
	stats := images[0].Stats
	return post{
		wire:      wire,
		pinned:    pinned,
		createdAt: createdAt,
		reactions: statOf(stats, "likeCountAllTime") + statOf(stats, "laughCountAllTime") + statOf(stats, "heartCountAllTime") + statOf(stats, "cryCountAllTime") - statOf(stats, "dislikeCountAllTime"),
		comments:  statOf(stats, "commentCountAllTime"),
		collected: statOf(stats, "collectedCountAllTime"),
	}
}

// EarliestByJSDateString reproduces `images.map((i) => new Date(i.sortAt)).sort()[0]`. Array#sort with
// no comparator orders Dates by their STRING form ("Fri Mar 01 2024 …"), so this picks the
// alphabetically first weekday/month/day string, not the earliest instant. Ported as is: the value is
// on the wire and drives the Newest/Oldest post order. (The process runs in UTC, as the Node pods do.)
func EarliestByJSDateString(images []Image) time.Time {
	best := images[0].SortAt
	bestKey := JSDateString(best)
	for _, img := range images[1:] {
		if k := JSDateString(img.SortAt); k < bestKey {
			best, bestKey = img.SortAt, k
		}
	}
	return best
}

// JSDateString is Date#toString in UTC, e.g. "Fri Mar 01 2024 10:00:00 GMT+0000 (Coordinated Universal Time)".
func JSDateString(t time.Time) string {
	return t.UTC().Format("Mon Jan 02 2006 15:04:05") + " GMT+0000 (Coordinated Universal Time)"
}

// sortPosts is the handler's per-sort comparator: pinned posts first, each group in the sort's
// order (every branch of the handler's comparators reduces to that). sort.SliceStable keeps the
// ascending-postId order on ties, as V8's stable Array#sort does. Any other sort leaves the order.
func sortPosts(results []post, sortBy string) {
	var less func(a, b post) bool
	switch sortBy {
	case SortNewest:
		less = func(a, b post) bool { return a.createdAt.UnixMilli() > b.createdAt.UnixMilli() }
	case SortMostReactions:
		less = func(a, b post) bool { return a.reactions > b.reactions }
	case SortMostComments:
		less = func(a, b post) bool { return a.comments > b.comments }
	case SortMostCollected:
		less = func(a, b post) bool { return a.collected > b.collected }
	case SortOldest:
		less = func(a, b post) bool { return a.createdAt.UnixMilli() < b.createdAt.UnixMilli() }
	default:
		return
	}
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].pinned != results[j].pinned {
			return results[i].pinned
		}
		return less(results[i], results[j])
	})
}
