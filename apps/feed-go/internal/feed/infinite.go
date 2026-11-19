package feed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"

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
	// PrioritizedUserIDs is `prioritizedUserIds`, as sent (the model page's showcase carousel sends
	// the model owner's id alone). Non-empty with a model scope it routes the request to Postgres
	// (requiresImageDbPath), where getAllImages keeps only those creators' images, drops the model
	// join for `p."modelVersionId"`, and orders oldest post first; on the feed path the query mapper
	// refuses it (an empty page).
	PrioritizedUserIDs []int
	// Pending is `pending`: getAllImages drops its published-before-now clause and, for a moderator or
	// a signed-in viewer, applies the pending visibility instead of the reviewed one. The feed path's
	// mapper refuses it (an empty page).
	Pending bool
	// BaseModels is `baseModels` (z.string().array()), as sent: getAllImages keeps the images with an
	// ImageResourceNew row whose ModelVersion's `baseModel` is one of them (the feed hydrate too); the
	// feed query sends the non-empty ones. The names are matched as text, never against a list.
	BaseModels []string
}

// infiniteUnsupported are the input keys this port falls back on when present: the gallery's list
// without the inputs image.getInfinite answers here (userId, username, postId, tags,
// prioritizedUserIds, pending, baseModels).
var infiniteUnsupported = func() []string {
	ported := map[string]bool{
		"userId": true, "username": true, "postId": true, "tags": true, "prioritizedUserIds": true, "pending": true,
		"baseModels": true,
	}
	out := make([]string, 0, len(unsupportedKeys))
	for _, k := range unsupportedKeys {
		if !ported[k] {
			out = append(out, k)
		}
	}
	return out
}()

// strippedURLKeys are keys of imagesQueryParamSchema (src/components/Image/image-query-params.ts,
// the images feeds' URL query) that getInfiniteImagesSchema lacks. The site passes that query into
// image.getInfinite's input (useImageFilters → ImagesInfinite → useQueryImages): `view` from an
// /images?view=… link, `section` from a profile's media tabs, `query` and `similarTo` from the image
// detail's feed context (ImagesInfinite removes those two from its own filters only). Zod strips all
// four, so Node answers as if they were absent, and so does ParseInfinite. Only image.getInfinite:
// Parse (the posts gallery) still falls back on them. TestStrippedURLKeysAreStrippedByZod fails when
// getInfiniteImagesSchema gains one (it must then be read, not ignored). This is a deliberate
// exception to the unknown-key fallback, with a deploy-gap risk: see DESIGN.md §5.1.
var strippedURLKeys = []string{"query", "section", "similarTo", "view"}

// strippedLegacyKeys are keys outside getInfiniteImagesSchema that legacy clients still send to
// image.getInfinite. zod strips them and nothing downstream reads them, so Node answers as if they
// were absent. Same deploy-gap exception as strippedURLKeys (DESIGN.md §5.1);
// TestStrippedLegacyKeysAreStrippedByZod fails when the schema gains one.
var strippedLegacyKeys = []string{"search", "useIndex"}

// infiniteAbsentKeys are the keys outside getInfiniteImagesSchema that ParseInfinite reads as absent:
// the tRPC client's own, strippedURLKeys and strippedLegacyKeys.
var infiniteAbsentKeys = func() map[string]bool {
	out := make(map[string]bool, len(trpcTransportKeys)+len(strippedURLKeys)+len(strippedLegacyKeys))
	for k := range trpcTransportKeys {
		out[k] = true
	}
	for _, k := range strippedURLKeys {
		out[k] = true
	}
	for _, k := range strippedLegacyKeys {
		out[k] = true
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
	base, err := parseInput(withoutUnreadIncludes(m), infiniteUnsupported, infiniteAbsentKeys)
	if err != nil {
		return nil, err
	}
	in := &InfiniteInput{Input: *base}
	if v, ok := m["userId"]; ok && v != nil {
		n, err := intIn(v, 0, math.MaxInt32)
		if err != nil {
			return nil, fallback.NewfSafe("input-invalid", "userId", "userId: %v", err)
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
			return nil, fallback.NewfSafe("input-invalid", "postId", "postId: %v", err)
		}
	}
	if in.Tags, err = ints(m["tags"]); err != nil {
		return nil, err
	}
	// z.array(z.number()): any length, negatives included (-1 is the system user).
	if in.PrioritizedUserIDs, err = ints(m["prioritizedUserIds"]); err != nil {
		return nil, err
	}
	if v, ok := m["pending"]; ok && v != nil {
		b, isBool := v.(bool) // z.boolean(), not coerced: anything else is Node's BAD_REQUEST
		if !isBool {
			return nil, fallback.NewfSafe("input-invalid", "pending", "pending: %v", v)
		}
		in.Pending = b
	}
	if v, ok := m["baseModels"]; ok {
		if in.BaseModels, err = baseModelNames(v); err != nil {
			return nil, err
		}
	}
	return in, nil
}

// baseModelNames reads `baseModels` (z.string().array()): a list of strings, kept as sent (order,
// repeats and empty strings included: getAllImages binds the whole list, the feed query drops the
// empty ones). A present value that is not a list (a literal null included: the field is
// `.optional()`, not `.nullish()`), or an entry that is not a string, is the schema's BAD_REQUEST
// (input-invalid). The caller skips an absent key, which is no filter.
func baseModelNames(v any) ([]string, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, fallback.NewfSafe("input-invalid", "baseModels", "baseModels: %T", v)
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		s, ok := e.(string)
		if !ok {
			return nil, fallback.NewfSafe("input-invalid", "baseModels", "baseModels entry: %T", e)
		}
		out = append(out, s)
	}
	return out, nil
}

// unreadIncludes are imageInclude values getAllImagesUncaptured never reads: an `include` holding them
// is answered as the same list without them (with no 'cosmetics' left, as the list without cosmetics
// is). Only image.getInfinite: the posts gallery still falls back on them.
var unreadIncludes = map[string]bool{"count": true, "report": true}

// withoutUnreadIncludes is m with unreadIncludes removed from its `include` list (a copy; m itself when
// there is none). Any other value, a non-string entry included, is left for parseInput to judge.
func withoutUnreadIncludes(m map[string]any) map[string]any {
	list, ok := m["include"].([]any)
	if !ok {
		return m
	}
	kept := make([]any, 0, len(list))
	for _, e := range list {
		if s, isStr := e.(string); !isStr || !unreadIncludes[s] {
			kept = append(kept, e)
		}
	}
	if len(kept) == len(list) {
		return m
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	out["include"] = kept
	return out
}

// prioritized is getAllImages' prioritizeUser: a non-empty prioritizedUserIds.
func (in *InfiniteInput) prioritized() bool {
	return len(in.PrioritizedUserIDs) > 0
}

// prioritizedSystemUser is getAllImages' prioritizseIsSystemUser: exactly the system user (-1).
func (in *InfiniteInput) prioritizedSystemUser() bool {
	return len(in.PrioritizedUserIDs) == 1 && in.PrioritizedUserIDs[0] == -1
}

// ownScoped is applyAddonExclusions' isOwnScoped for this input (see ownScope).
func (in *InfiniteInput) ownScoped(viewerID int, viewerUsername string) bool {
	return ownScope(viewerID, viewerUsername, in.UserID, in.Username)
}

// ownScope is applyAddonExclusions' isOwnScoped, read on the creator the feed filters by: the
// `userId` whenever present (equal to the viewer's id, whatever `username` says), otherwise the
// `username` (the viewer's, case-insensitively). 0 / "" is no identifier (Node's falsy checks).
func ownScope(viewerID int, viewerUsername string, userID int, username string) bool {
	if userID != 0 {
		return viewerID != 0 && userID == viewerID
	}
	return username != "" && viewerUsername != "" && strings.EqualFold(username, viewerUsername)
}

// dbPath is requiresImageDbPath for the supported inputs: a post's media, a model without a
// version (the feed has no model dimension), or prioritizedUserIds with a model or version scope.
// Every other shape it lists falls back in parsing.
func (in *InfiniteInput) dbPath() bool {
	return in.PostID != 0 || (in.ModelID != 0 && in.ModelVersionID == 0) ||
		(in.prioritized() && (in.ModelID != 0 || in.ModelVersionID != 0))
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

// BlockedTagsTTL is SYSTEM_CACHE_INPROC_TTL_MS: how long getBlockedBrowsingTags' in-process memo
// (createTtlMemo) serves a list it read before reading the cache again.
const BlockedTagsTTL = 30 * time.Second

// blockedTagsReadTimeout bounds the one shared read of a refresh (it runs detached from any one
// caller's context, so a caller that leaves cannot fail the others waiting on it).
const blockedTagsReadTimeout = 2 * time.Second

// BlockedTags reads getBlockedBrowsingTags' list of `system:blocked-browsing-tags`: its ids
// (image.getInfinite) and its lowercased names (model.getAll). A key Node would rebuild (absent or
// unreadable as a list) falls back, as does a read error.
//
// Like Node's createTtlMemo, a list read successfully is served from memory for TTL; an error is
// never memoized (the next call reads again). Concurrent callers of an expired memo share one read
// (single flight). The returned maps are shared: callers must not modify them. One BlockedTags is
// shared by every procedure that reads the list, as the one memo is in Node.
type BlockedTags struct {
	Cache  redis.UniversalClient
	Prefix string
	// TTL is the memo's lifetime (0 = BlockedTagsTTL; negative = no memo).
	TTL time.Duration
	// Now is the memo's clock (nil = time.Now; tests replace it).
	Now func() time.Time

	mu      sync.Mutex
	memo    *blockedList
	readAt  time.Time
	refresh singleflight.Group
}

// blockedList is one read of the list. Each consumer's own reading of an entry it cannot use (a
// non-integer id, a nameless entry) is its own error, kept beside the other's result: in Node the
// memo holds the list and each consumer fails on it on every call.
type blockedList struct {
	ids      map[int]bool
	idsErr   error
	names    map[string]bool
	namesErr error
}

// IDs returns the blocked tag ids.
func (b *BlockedTags) IDs(ctx context.Context) (map[int]bool, error) {
	l, err := b.list(ctx)
	if err != nil {
		return nil, err
	}
	return l.ids, l.idsErr
}

// Names returns the blocked tag names, lowercased (`t.name.toLowerCase()`).
func (b *BlockedTags) Names(ctx context.Context) (map[string]bool, error) {
	l, err := b.list(ctx)
	if err != nil {
		return nil, err
	}
	return l.names, l.namesErr
}

func (b *BlockedTags) list(ctx context.Context) (*blockedList, error) {
	ttl := b.TTL
	if ttl == 0 {
		ttl = BlockedTagsTTL
	}
	now := time.Now
	if b.Now != nil {
		now = b.Now
	}
	if ttl > 0 {
		b.mu.Lock()
		l, fresh := b.memo, b.memo != nil && now().Sub(b.readAt) < ttl
		b.mu.Unlock()
		if fresh {
			return l, nil
		}
	}
	ch := b.refresh.DoChan("list", func() (any, error) {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), blockedTagsReadTimeout)
		defer cancel()
		l, err := b.read(rctx)
		if err != nil {
			return nil, err
		}
		b.mu.Lock()
		b.memo, b.readAt = l, now()
		b.mu.Unlock()
		return l, nil
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		return res.Val.(*blockedList), nil
	}
}

// read is one read of the cache key, without the memo.
func (b *BlockedTags) read(ctx context.Context) (*blockedList, error) {
	raw, err := b.Cache.Get(ctx, b.Prefix+BlockedTagsKey).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, fallback.New("blocked-tags-miss")
	}
	if err != nil {
		return nil, fallback.Wrap("blocked-tags-read-failed", err)
	}
	return parseBlockedList(raw)
}

// parseBlockedList reads a cached `[{id, name}]` list. Anything but a JSON array is a value Node
// would replace from the database (its JSON.parse / Array.isArray guard), which this service does
// not read.
func parseBlockedList(raw []byte) (*blockedList, error) {
	var list []map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&list); err != nil || list == nil {
		return nil, fallback.New("blocked-tags-stale")
	}
	l := &blockedList{ids: make(map[int]bool, len(list)), names: make(map[string]bool, len(list))}
	for _, t := range list {
		n, _ := t["id"].(json.Number)
		f, err := n.Float64()
		if err != nil || f != math.Trunc(f) {
			l.ids, l.idsErr = nil, fallback.New("blocked-tags-stale")
		} else if l.ids != nil {
			l.ids[int(f)] = true
		}
		name, ok := t["name"].(string)
		if !ok {
			// `t.name.toLowerCase()` throws on a nameless entry: a 500 this service does not mimic.
			l.names, l.namesErr = nil, fallback.New("blocked-tags-stale")
		} else if l.names != nil {
			l.names[strings.ToLower(name)] = true
		}
	}
	return l, nil
}

// ParseBlockedTags reads a cached `[{id, name}]` list's ids.
func ParseBlockedTags(raw []byte) (map[int]bool, error) {
	l, err := parseBlockedList(raw)
	if err != nil {
		return nil, err
	}
	return l.ids, l.idsErr
}

// ParseBlockedTagNames reads a cached `[{id, name}]` list's names, lowercased.
func ParseBlockedTagNames(raw []byte) (map[string]bool, error) {
	l, err := parseBlockedList(raw)
	if err != nil {
		return nil, err
	}
	return l.names, l.namesErr
}

// ImageTagGate is getImageTagGateIds (src/server/redis/image-tag-gate-ids.ts) as the tag-ids miss
// computation's hydrate.MissCompute.TagGate: every tag id a browsing rule can hide content by, the
// blocked browsing tags' ids and the excludedTagIds of every addon, the defaults' and the configured
// ones'. A blocked-list read that fails (or a list Node would rebuild from the database) is the
// gate's error. The returned map is the caller's.
func ImageTagGate(blocked *BlockedTags, addons func(context.Context) []browsing.Addon) func(context.Context) (map[int]bool, error) {
	return func(ctx context.Context) (map[int]bool, error) {
		if blocked == nil {
			return nil, errors.New("no blocked-tag list configured")
		}
		ids, err := blocked.IDs(ctx)
		if err != nil {
			return nil, err
		}
		out := make(map[int]bool, len(ids))
		for id := range ids {
			out[id] = true
		}
		add := func(list []browsing.Addon) {
			for _, a := range list {
				for _, id := range a.ExcludedTagIDs {
					out[id] = true
				}
			}
		}
		add(browsing.DefaultAddons)
		if addons != nil {
			add(addons(ctx))
		}
		return out, nil
	}
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
	resolved := browsing.ResolveAddons(addons, AddonLevel(level), viewer.IsModerator, "")
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
		Pending:        in.Pending,
		Tools:          in.Tools,
		BaseModels:     in.BaseModels,
	}
	if in.prioritized() {
		q.PrioritizedUserIDs = in.PrioritizedUserIDs
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
		BrowsingLevel:         q.BrowsingLevel,
		ExcludedTagIDs:        q.ExcludedTagIDs,
		ExcludedUserIDs:       in.ExcludedUserIDs,
		ModelID:               in.ModelID,
		ModelVersionID:        in.ModelVersionID,
		Model3DID:             in.Model3DID,
		Types:                 in.Types,
		WithMeta:              in.WithMetaFlag,
		FromPlatform:          in.FromPlatform,
		DisableMinor:          q.DisableMinor,
		DisablePoi:            q.DisablePoi,
		ViewerID:              viewer.ID,
		UserID:                q.TargetUserID,
		Tags:                  q.TagIDs,
		Sort:                  in.Sort,
		Period:                in.Period,
		Limit:                 in.Limit,
		HasGeneration:         len(in.Generation) > 0,
		HasRemixOfID:          in.HasRemixOfID,
		RequiringMeta:         in.RequiringMeta,
		HasPrioritizedUserIDs: in.prioritized(),
		Pending:               in.Pending,
		Tools:                 in.Tools,
		BaseModels:            in.BaseModels,
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
		return nil, fallback.Wrap("feed-unavailable", err)
	}
	if ans.Status != 200 {
		return nil, fallback.Safef("feed-status", "%d", ans.Status)
	}
	next := ""
	if ans.NextCursor != "" {
		next = feedsvc.EncodeCursor(ans.NextCursor)
	}
	if len(ans.IDs) == 0 {
		return page([]any{}, next, true), nil
	}
	// feedHydrateQuery: the request's filters (baseModels included) without its paging, period or
	// model scope.
	hq := q
	hq.IDs, hq.Limit = ans.IDs, len(ans.IDs)
	hq.Cursor, hq.ModelID, hq.ModelVersionID, hq.Period = 0, 0, 0, "AllTime"
	hq.ThrowOnStatementTimeout = true
	images, _, err := fetchInfiniteRows(ctx, d, hq, viewer, now, in.IncludeProfilePictures, in.IncludeCosmetics)
	if err != nil {
		if fallback.Reason(err) != "" {
			return nil, err
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fallback.Wrap("feed-hydrate-error", err) // Node: hydrate:error, a 503
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
	if in.prioritized() {
		// getAllImages' prioritizeUser branches, for the sub-cases not computed here (Node answers):
		if d.Config.PrioritizedVersionCache {
			// `use-model-version-cache-for-images` on: the ids come from imagesForModelVersionsCache
			// and the page is re-sorted into that cache's order. Not ported (off in production).
			return nil, fallback.New("prioritized-version-cache")
		}
		if in.Cursor != 0 || in.CursorText != "" {
			// A truthy cursor is Node's BAD_REQUEST 'Cannot use cursor with prioritizedUserIds'.
			return nil, fallback.New("prioritized-cursor")
		}
		if in.prioritizedSystemUser() {
			// The system user alone: one more read (does it have a post on the version?) decides
			// between its own images and every creator's, ordered by an IIF over the index.
			return nil, fallback.New("prioritized-system-user")
		}
	}
	images, next, err := fetchInfiniteRows(ctx, d, q, viewer, now, in.IncludeProfilePictures, in.IncludeCosmetics)
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
// undefined at the end. profilePictures and cosmetics are the include list's 'profilePictures' and
// 'cosmetics'.
func fetchInfiniteRows(ctx context.Context, d *InfiniteDeps, q ImagesQuery, viewer Viewer, now time.Time, profilePictures, cosmetics bool) ([]Image, any, error) {
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
	hy, err := hydrateRows(ctx, d.Hydrator, rows, viewer, d.Config.VisibleDecorationEvents, profilePictures, cosmetics)
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
