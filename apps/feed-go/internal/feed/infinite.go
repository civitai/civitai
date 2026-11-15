package feed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// The port of `image.getInfinite` (image.router.ts: heavyProcedure → getInfiniteImagesHandler in
// src/server/controllers/image.controller.ts → getAllImagesIndex / getAllImages in
// src/server/services/image.service.ts, then withSharedFeedUsers), for the request shapes it
// supports. It answers one page of images (the flat shape), not posts.

// InfiniteInput is getInfiniteImagesSchema as image.getInfinite reads it: the gallery input plus the
// creator, post and tag scopes.
type InfiniteInput struct {
	Input
	// UserID is the creator scope (`userId`); 0 = none.
	UserID int
	// Username is the creator scope by name (`username`, usernameSchema); resolved to an id when
	// UserID is 0.
	Username string
	// PostID is a post's own media (`postId`): always the Postgres path (requiresImageDbPath).
	PostID int
	// Tags is the tag inclusion scope (`tags`), as sent.
	Tags []int
}

// infiniteUnsupported are the input keys this port falls back on when present: the gallery's list
// without the scopes image.getInfinite answers here (userId, username, postId, tags).
var infiniteUnsupported = func() []string {
	ported := map[string]bool{"userId": true, "username": true, "postId": true, "tags": true}
	out := make([]string, 0, len(unsupportedKeys))
	for _, k := range unsupportedKeys {
		if !ported[k] {
			out = append(out, k)
		}
	}
	return out
}()

// hatKeys are the Hat Turf sorts and Show filters. Node acts on them only when its hat-turf flags
// are on and getHatTurfFeedEvent finds a live event (read from the event engine, per viewer), then
// pages from the turf rank or drops images by turfHiddenIds; none of that is read here, so a request
// carrying one falls back whatever the flags say. `hatTeams` only narrows a hat sort, so it is
// ignored alone.
var hatKeys = []string{"hatSort", "hatTurfMine", "hideTurfHats", "hideWornHats"}

// ParseInfinite validates image.getInfinite's decoded input. A shape outside the supported subset is
// a fallback, and so is a value the schema rejects (Node answers it with its own BAD_REQUEST).
func ParseInfinite(m map[string]any) (*InfiniteInput, error) {
	for _, k := range hatKeys {
		if v, ok := m[k]; ok && !isEmpty(v) {
			return nil, fallback.New("infinite-hat-turf")
		}
	}
	base, err := parseInput(m, infiniteUnsupported)
	if err != nil {
		return nil, err
	}
	in := &InfiniteInput{Input: *base}
	if v, ok := m["userId"]; ok && v != nil {
		n, err := intIn(v, 0, math.MaxInt32)
		if err != nil {
			return nil, fallback.Newf("input-invalid", "userId: %v", err)
		}
		if n == 0 {
			// `input.userId ?? …` keeps a 0 (the feed then has no creator) while the hydrate reads it
			// as absent and looks a `username` up: the two disagree, so a 0 is not answered here.
			return nil, fallback.New("infinite-user-zero")
		}
		in.UserID = n
	}
	if v, ok := m["username"]; ok && v != nil {
		s, isStr := v.(string)
		if !isStr || !usernameRE.MatchString(s) { // usernameSchema's pattern (v1query.go)
			return nil, fallback.New("input-invalid")
		}
		in.Username = s
	}
	if v, ok := m["postId"]; ok && v != nil {
		if in.PostID, err = intIn(v, 0, math.MaxInt32); err != nil {
			return nil, fallback.Newf("input-invalid", "postId: %v", err)
		}
	}
	if in.Tags, err = ints(m["tags"]); err != nil {
		return nil, err
	}
	return in, nil
}

// ownScoped is applyAddonExclusions' isOwnScoped: the request is scoped to the viewer's own content
// by id (before a username is resolved) or by name, case-insensitively.
func (in *InfiniteInput) ownScoped(viewerID int, viewerUsername string) bool {
	if viewerID != 0 && in.UserID != 0 && viewerID == in.UserID {
		return true
	}
	return viewerUsername != "" && in.Username != "" && strings.EqualFold(in.Username, viewerUsername)
}

// dbPath is requiresImageDbPath for the supported inputs: a post's media, or a model without a
// version (the feed has no model dimension). Every other shape it lists falls back in parsing.
func (in *InfiniteInput) dbPath() bool {
	return in.PostID != 0 || (in.ModelID != 0 && in.ModelVersionID == 0)
}

// InfiniteSources is the lookups image.getInfinite reads beyond the page's hydration (implemented by
// *hydrate.Sources).
type InfiniteSources interface {
	PostVersions(ctx context.Context, postIDs []int) (map[int]int, error)
	VersionModels(ctx context.Context, versionIDs []int) (map[int]int, error)
	UserIDByUsername(ctx context.Context, username string) (int, bool, error)
}

// BlockedTagsKey is REDIS_KEYS.SYSTEM.BLOCKED_BROWSING_TAGS, on the cache cluster.
const BlockedTagsKey = "system:blocked-browsing-tags"

// BlockedTags reads getBlockedBrowsingTags' list: the ids of `system:blocked-browsing-tags`. A key
// Node would rebuild (absent or unreadable as a list) falls back, as does a read error.
type BlockedTags struct {
	Cache  redis.UniversalClient
	Prefix string
}

// IDs returns the blocked tag ids.
func (b *BlockedTags) IDs(ctx context.Context) (map[int]bool, error) {
	raw, err := b.Cache.Get(ctx, b.Prefix+BlockedTagsKey).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, fallback.New("blocked-tags-miss")
	}
	if err != nil {
		return nil, fallback.Newf("blocked-tags-read-failed", "%v", err)
	}
	return ParseBlockedTags(raw)
}

// ParseBlockedTags reads a cached `[{id, name}]` list. Anything else is a value Node would replace
// from the database (its JSON.parse / Array.isArray guard), which this service does not read.
func ParseBlockedTags(raw []byte) (map[int]bool, error) {
	var list []struct {
		ID json.Number `json:"id"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&list); err != nil || list == nil {
		return nil, fallback.New("blocked-tags-stale")
	}
	out := make(map[int]bool, len(list))
	for _, t := range list {
		f, err := t.ID.Float64()
		if err != nil || f != math.Trunc(f) {
			return nil, fallback.New("blocked-tags-stale")
		}
		out[int(f)] = true
	}
	return out, nil
}

// InfiniteDeps are image.getInfinite's collaborators: the gallery port's (feed client, replica,
// caches, hydration, addons, flag mirrors) plus the lookups it reads itself.
type InfiniteDeps struct {
	*Deps
	Sources InfiniteSources
	Blocked *BlockedTags
}

// InfiniteRequest is one call.
type InfiniteRequest struct {
	Input *InfiniteInput
	// Viewer is nil when signed out or banned.
	Viewer *Viewer
	// ViewerUsername is the session user's name (the own-scope check reads it); "" when signed out.
	ViewerUsername string
	// Cap is the domain cap (browsing.DomainCap); 0 = uncapped.
	Cap int
}

// InfiniteAnswer is one computed answer.
type InfiniteAnswer struct {
	// Value is the procedure's result as Node returns it.
	Value superjson.Object
	// Trivial: no image row was loaded (a withheld or held gallery, a blocked tag scope, a shape the
	// feed cannot express, a feed page with no ids). Kept out of the served / match series.
	Trivial bool
}

// infiniteEmpty is the handler's own `{ items: [], nextCursor: undefined }` (a withheld or fully held
// gallery).
func infiniteEmpty() *InfiniteAnswer {
	return &InfiniteAnswer{Value: superjson.Object{
		{Key: "items", Val: []any{}}, {Key: "nextCursor", Val: superjson.Undefined{}},
	}, Trivial: true}
}

// infiniteFilters is enforceBlockedBrowsingTags' addon half plus applyHideChallengesExclusion, at
// the request's level: the addons' exclusions, except their tags on the viewer's own feed.
func infiniteFilters(in *InfiniteInput, addons []browsing.Addon, level int, viewer Viewer, viewerUsername string) AddonFilters {
	lv := browsing.OnlySelectable(orInt(level, browsing.PublicLevels))
	if lv == 0 {
		lv = browsing.PublicLevels
	}
	resolved := browsing.ResolveAddons(addons, lv, viewer.IsModerator, "")
	excluded := append([]int(nil), in.ExcludedTagIDs...)
	if !in.ownScoped(viewer.ID, viewerUsername) && len(resolved.ExcludedTagIDs) > 0 {
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

// ServeInfinite is getInfiniteImagesHandler (then withSharedFeedUsers, which changes no decoded
// value) for the supported subset.
func ServeInfinite(ctx context.Context, d *InfiniteDeps, req InfiniteRequest) (*InfiniteAnswer, error) {
	in := req.Input
	useIndex := d.Config.ImageIndexFeed && !in.dbPath()
	if useIndex && d.Feed == nil {
		return nil, fallback.New("index-feed-unconfigured")
	}
	now := time.Now()
	if d.Now != nil {
		now = d.Now()
	}
	var viewer Viewer
	viewerUsername := ""
	if req.Viewer != nil {
		viewer = *req.Viewer
		viewerUsername = req.ViewerUsername
	}
	level, _ := in.ApplyDomainCap(req.Cap)

	// The gallery gates (moderators are exempt from both): a taken-down model's images only to its
	// owner, a minor or SFW-only model's only at its held level.
	if !viewer.IsModerator && (in.ModelID != 0 || in.ModelVersionID != 0 || in.PostID != 0) {
		modelIDs, ok, err := resolveImageModelIDs(ctx, d.Sources, in.ModelID, in.ModelVersionID, in.PostID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return infiniteEmpty(), nil
		}
		withheld, err := d.Gallery.Withheld(ctx, modelIDs, viewer.ID)
		if err != nil {
			return nil, err
		}
		if withheld {
			return infiniteEmpty(), nil
		}
		levels, err := heldLevels(ctx, d.Gallery, modelIDs, "held-level-unset")
		if err != nil {
			return nil, err
		}
		if len(levels) > 0 {
			held := browsing.AllLevels
			for _, l := range levels {
				held &= l
			}
			if level &= held; level == 0 {
				return infiniteEmpty(), nil
			}
		}
	}

	filters := infiniteFilters(in, d.Addons.Addons(ctx), level, viewer, viewerUsername)
	// stripBlockedTagIds: a tag scope made only of blocked tags is an empty page.
	tags := in.Tags
	if len(tags) > 0 {
		if d.Blocked == nil {
			return nil, fallback.New("blocked-tags-unconfigured")
		}
		blocked, err := d.Blocked.IDs(ctx)
		if err != nil {
			return nil, err
		}
		kept := make([]int, 0, len(tags))
		for _, t := range tags {
			if !blocked[t] {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			// getAllImagesIndex's / getAllImagesUncaptured's own `{ nextCursor: undefined, items: [] }`;
			// the Postgres arm's caller stamps its source on it.
			v := superjson.Object{{Key: "nextCursor", Val: superjson.Undefined{}}, {Key: "items", Val: []any{}}}
			if !useIndex {
				v = append(v, superjson.Field{Key: "source", Val: "db"})
			}
			return &InfiniteAnswer{Value: v, Trivial: true}, nil
		}
		tags = kept
	}
	userID := in.UserID
	if userID == 0 && in.Username != "" {
		id, found, err := d.Sources.UserIDByUsername(ctx, in.Username)
		if err != nil {
			return nil, err
		}
		if !found {
			// The index path answers 404; the Postgres path reads the primary next.
			return nil, fallback.New("username-miss")
		}
		userID = id
	}

	q := ImagesQuery{
		Limit:          in.Limit,
		Cursor:         in.Cursor,
		Sort:           in.Sort,
		Period:         in.Period,
		PeriodMode:     in.PeriodMode,
		BrowsingLevel:  level,
		ModelID:        in.ModelID,
		ModelVersionID: in.ModelVersionID,
		Model3DID:      in.Model3DID,
		Types:          in.Types,
		Generation:     in.Generation,
		WithMeta:       in.WithMeta,
		FromPlatform:   in.FromPlatform,
		DisablePoi:     filters.DisablePoi,
		DisableMinor:   filters.DisableMinor,
		ExcludedTagIDs: filters.ExcludedTagIDs,
		ExcludedUsers:  in.ExcludedUserIDs,
		ViewerID:       viewer.ID,
		IsModerator:    viewer.IsModerator,
		PostID:         in.PostID,
		TargetUserID:   userID,
		TagIDs:         tags,
		IndexOrder:     in.PostID != 0 && in.ModelID == 0,
	}
	if useIndex {
		return infiniteFromFeed(ctx, d, in, q, viewer, now)
	}
	return infiniteFromDB(ctx, d, in, q, viewer, now)
}

// infiniteFromFeed is getAllImagesIndex with the feed service available: the feed picks and orders
// the page, Postgres supplies the rows (feedHydrateQuery), and the answer is
// `{ items, nextCursor, source: 'feed' }`.
func infiniteFromFeed(ctx context.Context, d *InfiniteDeps, in *InfiniteInput, q ImagesQuery, viewer Viewer, now time.Time) (*InfiniteAnswer, error) {
	fq := feedsvc.Query{
		BrowsingLevel:   q.BrowsingLevel,
		ExcludedTagIDs:  q.ExcludedTagIDs,
		ExcludedUserIDs: in.ExcludedUserIDs,
		ModelID:         in.ModelID,
		ModelVersionID:  in.ModelVersionID,
		Model3DID:       in.Model3DID,
		Types:           in.Types,
		WithMeta:        in.WithMetaFlag,
		FromPlatform:    in.FromPlatform,
		DisableMinor:    q.DisableMinor,
		DisablePoi:      q.DisablePoi,
		ViewerID:        viewer.ID,
		UserID:          q.TargetUserID,
		Tags:            q.TagIDs,
		Sort:            in.Sort,
		Period:          in.Period,
		Limit:           in.Limit,
		HasGeneration:   len(in.Generation) > 0,
		HasRemixOfID:    in.HasRemixOfID,
		RequiringMeta:   in.RequiringMeta,
	}
	if in.CursorText != "" {
		fq.CursorText = in.CursorText
	} else {
		fq.CursorNum = in.Cursor
	}
	page := func(items []any, next string, trivial bool) *InfiniteAnswer {
		var cursor any = superjson.Undefined{}
		if next != "" {
			cursor = next
		}
		return &InfiniteAnswer{Value: superjson.Object{
			{Key: "items", Val: items}, {Key: "nextCursor", Val: cursor}, {Key: "source", Val: "feed"},
		}, Trivial: trivial}
	}
	query, refusal := feedsvc.Map(fq)
	if refusal != nil {
		if refusal.Rejected {
			return nil, fallback.New("feed-" + refusal.Reason) // answerWithoutFeed: a BAD_REQUEST
		}
		return page([]any{}, "", true), nil // a shape the feed cannot express: an empty page
	}
	ans, err := d.Feed.Fetch(ctx, query)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fallback.Newf("feed-unavailable", "%v", err)
	}
	if ans.Status != 200 {
		return nil, fallback.Newf("feed-status", "%d", ans.Status)
	}
	next := ""
	if ans.NextCursor != "" {
		next = feedsvc.EncodeCursor(ans.NextCursor)
	}
	if len(ans.IDs) == 0 {
		return page([]any{}, next, true), nil
	}
	// feedHydrateQuery: the request's filters without its paging, period or model scope.
	hq := q
	hq.IDs, hq.Limit = ans.IDs, len(ans.IDs)
	hq.Cursor, hq.ModelID, hq.ModelVersionID, hq.Period = 0, 0, 0, "AllTime"
	hq.ThrowOnStatementTimeout = true
	images, _, err := fetchInfiniteRows(ctx, d, hq, viewer, now, in.IncludeProfilePictures)
	if err != nil {
		if fallback.Reason(err) != "" {
			return nil, err
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fallback.Newf("feed-hydrate-error", "%v", err) // Node: hydrate:error, a 503
	}
	if len(images) == 0 {
		// hydrateWithReadRescue retries an empty hydrate on a replica this service does not reach.
		return nil, fallback.New("feed-hydrate-empty")
	}
	byID := make(map[int]superjson.Object, len(images))
	for _, img := range images {
		byID[img.ID] = img.Wire
	}
	items := make([]any, 0, len(ans.IDs))
	for _, id := range ans.IDs {
		if w, ok := byID[id]; ok {
			items = append(items, w)
		}
	}
	return page(items, next, false), nil
}

// infiniteFromDB is getAllImages for one page (no overscan, no grouping), stamped
// `{ nextCursor, items, source: 'db' }` by the handler.
func infiniteFromDB(ctx context.Context, d *InfiniteDeps, in *InfiniteInput, q ImagesQuery, viewer Viewer, now time.Time) (*InfiniteAnswer, error) {
	if !in.NumericCursor() {
		// getCursor reads a single-field sort's cursor as one integer; anything else is a 400.
		return nil, fallback.Newf("input-cursor", "%q", in.CursorText)
	}
	images, next, err := fetchInfiniteRows(ctx, d, q, viewer, now, in.IncludeProfilePictures)
	if err != nil {
		return nil, err
	}
	items := make([]any, len(images))
	for i, img := range images {
		items[i] = img.Wire
	}
	return &InfiniteAnswer{Value: superjson.Object{
		{Key: "nextCursor", Val: next}, {Key: "items", Val: items}, {Key: "source", Val: "db"},
	}, Trivial: len(images) == 0}, nil
}

// fetchInfiniteRows is one getAllImages call: the query (through the page cache), the hydration
// and the per-image transform with image.getInfinite's wire trim. next is the response's
// `nextCursor`: the look-ahead row's cursor column (the image id, or a post's nullable index), or
// undefined at the end.
func fetchInfiniteRows(ctx context.Context, d *InfiniteDeps, q ImagesQuery, viewer Viewer, now time.Time, profilePictures bool) ([]Image, any, error) {
	rows, err := FetchRows(ctx, d.DB, d.Cache, q.Build())
	if err != nil {
		return nil, nil, err
	}
	var next any = superjson.Undefined{}
	if len(rows) > q.Limit {
		look := rows[len(rows)-1]
		rows = rows[:len(rows)-1]
		if look.CursorNull {
			next = nil
		} else {
			next = int64(look.CursorID)
		}
	}
	hy, err := hydrateRows(ctx, d.Hydrator, rows, viewer, d.Config.VisibleDecorationEvents, profilePictures)
	if err != nil {
		return nil, nil, err
	}
	return BuildInfiniteImages(rows, hy, viewer, now), next, nil
}

// BuildInfiniteImages is getAllImagesUncaptured's per-image transform under stripImageForInfiniteWire
// only (image.getInfinite does not apply the gallery's stripImageForAsPostsWire): the gallery wire
// plus `availability`, `meta` (null: 'metaSelect' is not ported), `baseModel` (undefined:
// includeBaseModel is not ported) and `judgeScore` (null outside a collection). The publish filter is
// BuildImages'.
func BuildInfiniteImages(rows []RawImage, hy *Hydrated, viewer Viewer, now time.Time) []Image {
	images := BuildImages(rows, hy, viewer, now)
	byID := make(map[int]*RawImage, len(rows))
	for i := range rows {
		byID[rows[i].ID] = &rows[i]
	}
	for i := range images {
		img := &images[i]
		availability := ""
		if r := byID[img.ID]; r != nil {
			availability = r.Availability
		}
		wire := make(superjson.Object, 0, len(img.Wire)+4)
		wire = append(wire, img.Wire...)
		wire = append(wire,
			superjson.Field{Key: "availability", Val: availability},
			superjson.Field{Key: "meta", Val: nil},
			superjson.Field{Key: "baseModel", Val: superjson.Undefined{}},
			superjson.Field{Key: "judgeScore", Val: nil},
		)
		img.Wire = wire
	}
	return images
}
