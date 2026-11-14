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
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// Config holds the values the Node path reads from feature flags or env that this service takes as
// configuration (see DESIGN.md "Flags"). When a flag turns on a shape not ported here, the matching
// field makes those requests fall back instead of being answered wrong.
type Config struct {
	// CreatorPromotions mirrors the `creator-promotions` flag: on, a first model-gallery page may carry
	// a sponsored post (not ported -> fallback).
	CreatorPromotions bool
	// LazyPostImages mirrors `gallery-lazy-post-images` (not ported -> fallback).
	LazyPostImages bool
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
	Config   Config
	Now      func() time.Time
}

// Request is one call.
type Request struct {
	Input *Input
	// Viewer is nil when signed out.
	Viewer *Viewer
	// Cap is the domain cap (browsing.DomainCap); 0 = uncapped.
	Cap int
}

// Result is the procedure's value: `{nextCursor, items}`.
type Result struct {
	NextCursor int
	Items      []any
}

// Value returns the superjson value of the result.
func (r *Result) Value() superjson.Object {
	var next any = superjson.Undefined{}
	if r.NextCursor != 0 {
		next = int64(r.NextCursor)
	}
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
	if d.Config.LazyPostImages {
		return nil, fallback.New("lazy-post-images")
	}
	var viewer Viewer
	if req.Viewer != nil {
		viewer = *req.Viewer
	}
	browsingLevel, _ := in.ApplyDomainCap(req.Cap)

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
			browsingLevel &= held
			if browsingLevel == 0 {
				return empty, nil
			}
		}
	}
	pinned := settings.PinnedFor(in.ModelVersionID)
	if len(pinned) > 0 && in.Cursor == 0 {
		return nil, fallback.New("pinned-posts")
	}
	if in.Cursor == 0 && in.ModelID != 0 && in.ModelVersionID != 0 && d.Config.CreatorPromotions {
		return nil, fallback.New("sponsored-post")
	}

	// enforceBlockedBrowsingTags (the addon half; tag filters are a fallback shape) and
	// applyHideChallengesExclusion, as getAllImages applies them to every fetch.
	level := browsing.OnlySelectable(orInt(browsingLevel, browsing.PublicLevels))
	if level == 0 {
		level = browsing.PublicLevels
	}
	resolved := browsing.ResolveAddons(d.Addons.Addons(ctx), level, viewer.IsModerator, "")
	excluded := append([]int(nil), in.ExcludedTagIDs...)
	excluded = append(excluded, resolved.ExcludedTagIDs...)
	if in.HideChallenges {
		excluded = append(excluded, challengeTagID)
	}

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
		DisablePoi:     in.DisablePoi || resolved.DisablePoi,
		DisableMinor:   in.DisableMinor || resolved.DisableMinor,
		ExcludedTagIDs: excluded,
		ExcludedUsers:  in.ExcludedUserIDs,
		ViewerID:       viewer.ID,
		IsModerator:    viewer.IsModerator,
	}

	posts := map[int][]Image{}
	cursor := in.Cursor
	for {
		q.Cursor = cursor
		page, err := FetchImages(ctx, d.DB, d.Cache, d.Hydrator, q, viewer, d.Config.VisibleDecorationEvents, now)
		if err != nil {
			return nil, err
		}
		for _, img := range page.Images {
			if img.PostID == 0 {
				continue
			}
			posts[img.PostID] = append(posts[img.PostID], img)
		}
		cursor = page.NextCursor
		if cursor == 0 || len(posts) >= in.Limit {
			break
		}
	}

	// Object.values over integer keys: ascending postId. The sorts below are stable on that order.
	postIDs := make([]int, 0, len(posts))
	for id := range posts {
		postIDs = append(postIDs, id)
	}
	sort.Ints(postIDs)

	var reviews map[int]Review
	if in.ModelID != 0 || in.ModelVersionID != 0 {
		var userIDs []int
		seen := map[int]bool{}
		for _, id := range postIDs {
			uid := userIDOf(posts[id][0])
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

	results := make([]post, 0, len(postIDs))
	for _, id := range postIDs {
		results = append(results, buildPost(id, posts[id], in.Sort, reviews))
	}
	sortPosts(results, in.Sort)

	items := make([]any, len(results))
	for i, p := range results {
		items[i] = p.wire
	}
	return &Result{NextCursor: cursor, Items: items}, nil
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

// buildPost is the per-post `results` map of the handler (pinned/sponsored are fallback shapes).
func buildPost(postID int, images []Image, sortBy string, reviews map[int]Review) post {
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
	wireImages := make([]any, len(images))
	for i, img := range images {
		nsfw |= img.NsfwLevel
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
		{Key: "pinned", Val: false},
		{Key: "sponsored", Val: false},
		{Key: "nsfwLevel", Val: int64(nsfw)},
		{Key: "modelVersionId", Val: first.ModelVerID},
		{Key: "publishedAt", Val: first.PublishedAt},
		{Key: "sortAt", Val: first.SortAt},
		{Key: "createdAt", Val: createdAt},
		{Key: "user", Val: first.User},
		{Key: "images", Val: wireImages},
		{Key: "review", Val: review},
	}
	// getReactionTotals & co. read `images[0]` of the built post, i.e. after the Newest index sort.
	stats := images[0].Stats
	return post{
		wire:      wire,
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

// sortPosts is the handler's per-sort comparator; pinned posts are a fallback shape, so only the
// unpinned branch applies. sort.SliceStable keeps the ascending-postId order on ties, as V8's stable
// Array#sort does.
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
	sort.SliceStable(results, func(i, j int) bool { return less(results[i], results[j]) })
}
