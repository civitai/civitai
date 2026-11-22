package feed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
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
	// BaseModels is `baseModels`, as sent (order, repeats and empty names kept); matched as text,
	// never against a list.
	BaseModels []string
	// Followed is `followed: true`: for a signed-in viewer, only the creators they follow
	// (getUserFollows). Signed out it changes nothing (both Node paths read it only with a user).
	Followed bool
	// CollectionID is `collectionId` (a positive int4; 0 = none): always the Postgres path
	// (requiresImageDbPath), only the collection's items, and only when the viewer may read it.
	CollectionID int
	// CollectionTagID is `collectionTagId` (an int4; 0 = none, as Node's truthiness check reads it),
	// only beside a CollectionID.
	CollectionTagID int
	// IDs is `ids` (z.array(z.number()).max(200)), as sent: non-empty, always the Postgres path
	// (requiresImageDbPath), only those images (`i."id" = ANY(<ids>::int[])`), and each answered
	// image held by its own post's model (withoutHeldFromViewer).
	IDs []int
	// Reactions is `reactions` (ReviewReactions values), as sent: non-empty, always the Postgres path;
	// for a signed-in viewer only the images they reacted to with one of them (signed out, no clause).
	Reactions []string
	// NewCreators is `newCreators: true`: only the creators on the "new & upcoming" board of the
	// request's board color (getNewCreatorUserIds), and the addons resolved under the `newCreators`
	// scope.
	NewCreators bool
}

// maxInputIDs is the `ids` schema's `.max(200)`: a longer list is Node's BAD_REQUEST.
const maxInputIDs = 200

// infiniteUnsupported are the input keys this port falls back on when present: the gallery's list
// without the inputs image.getInfinite answers here (userId, username, postId, tags,
// prioritizedUserIds, pending, baseModels, followed, collectionId, collectionTagId, ids, reactions,
// newCreators).
var infiniteUnsupported = func() []string {
	ported := map[string]bool{
		"userId": true, "username": true, "postId": true, "tags": true, "prioritizedUserIds": true, "pending": true,
		"baseModels": true, "followed": true, "collectionId": true, "collectionTagId": true,
		"ids": true, "reactions": true, "newCreators": true,
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
	// Recently Added orders on the collection's items: answered beside a collectionId only (without
	// one, Node's BAD_REQUEST: the input-sort fallback parseInput raises for it).
	recentlyAdded := m["sort"] == SortRecentlyAdded && !isEmpty(m["collectionId"])
	parsed := withoutUnreadIncludes(m)
	if recentlyAdded {
		parsed = without(parsed, "sort")
	}
	base, err := parseInput(parsed, infiniteUnsupported, infiniteAbsentKeys, true)
	if err != nil {
		return nil, err
	}
	in := &InfiniteInput{Input: *base}
	if recentlyAdded {
		in.Sort = SortRecentlyAdded
	}
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
	if v, ok := m["followed"]; ok && v != nil {
		b, isBool := v.(bool) // z.boolean(), not coerced: anything else is Node's BAD_REQUEST
		if !isBool {
			return nil, fallback.NewfSafe("input-invalid", "followed", "followed: %v", v)
		}
		in.Followed = b
	}
	if err := in.parseCollection(m); err != nil {
		return nil, err
	}
	if v, ok := m["ids"]; ok {
		if in.IDs, err = inputIDs(v); err != nil {
			return nil, err
		}
	}
	if v, ok := m["reactions"]; ok {
		if in.Reactions, err = reactionList(v); err != nil {
			return nil, err
		}
	}
	if v, ok := m["newCreators"]; ok {
		b, isBool := v.(bool) // z.boolean().optional(): a null or anything else is Node's BAD_REQUEST
		if !isBool {
			return nil, fallback.NewfSafe("input-invalid", "newCreators", "newCreators: %T", v)
		}
		in.NewCreators = b
	}
	return in, nil
}

// inputIDs reads `ids` (z.array(z.number()).max(200).optional()), kept as sent. A present value that
// is not a list (null included), an entry that is not a number, or more than 200 entries is the
// schema's BAD_REQUEST (input-invalid). A number the schema accepts but that is not an int4 integer
// falls back (`ids-not-int4`): Node binds the list as `::int[]`, and Postgres refuses it (a 500 this
// service does not reproduce).
func inputIDs(v any) ([]int, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, fallback.NewfSafe("input-invalid", "ids", "ids: %T", v)
	}
	if len(list) > maxInputIDs {
		return nil, fallback.NewfSafe("input-invalid", "ids", "ids: %d entries", len(list))
	}
	out := make([]int, 0, len(list))
	for _, e := range list {
		f, err := number(e)
		if err != nil {
			return nil, fallback.NewfSafe("input-invalid", "ids", "ids entry: %T", e)
		}
		if f != math.Trunc(f) || f < math.MinInt32 || f > math.MaxInt32 {
			return nil, fallback.Newf("ids-not-int4", "%v", e)
		}
		out = append(out, int(f))
	}
	return out, nil
}

// reactionList reads `reactions` (z.array(z.enum(ReviewReactions)).optional()), kept as sent (order
// and repeats: Node binds the whole list into `IN (…)`). Not a list (null included), or an entry that
// is not a ReviewReactions value, is the schema's BAD_REQUEST (input-invalid).
func reactionList(v any) ([]string, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, fallback.NewfSafe("input-invalid", "reactions", "reactions: %T", v)
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		s, ok := e.(string)
		if !ok || !reviewReactions[s] {
			return nil, fallback.NewfSafe("input-invalid", "reactions", "reactions entry: %v", e)
		}
		out = append(out, s)
	}
	return out, nil
}

// parseCollection reads `collectionId` and `collectionTagId` (both z.number().optional()). Not a
// number is the schema's BAD_REQUEST (input-invalid). A collectionId that is not a positive int4
// integer falls back (`collection-id`: 0 is no collection in Node, which then routes the request
// elsewhere; any other such value is bound and matches no collection there). A non-zero
// collectionTagId that is not an int4 integer falls back (`collection-tag-id`: Node inlines it into
// the SQL text), and one without a collection is Node's BAD_REQUEST (`input-collectionTagId`).
func (in *InfiniteInput) parseCollection(m map[string]any) error {
	if v, ok := m["collectionId"]; ok && v != nil {
		f, err := number(v)
		if err != nil {
			return fallback.NewfSafe("input-invalid", "collectionId", "collectionId: %v", v)
		}
		if f != math.Trunc(f) || f < 1 || f > math.MaxInt32 {
			return fallback.Newf("collection-id", "%v", v)
		}
		in.CollectionID = int(f)
	}
	if v, ok := m["collectionTagId"]; ok && v != nil {
		f, err := number(v)
		if err != nil {
			return fallback.NewfSafe("input-invalid", "collectionTagId", "collectionTagId: %v", v)
		}
		if f == 0 {
			return nil // falsy: no tag filter, and no BAD_REQUEST without a collection
		}
		if f != math.Trunc(f) || f < math.MinInt32 || f > math.MaxInt32 {
			return fallback.Newf("collection-tag-id", "%v", v)
		}
		if in.CollectionID == 0 {
			return fallback.Newf("input-collectionTagId", "%v", v)
		}
		in.CollectionTagID = int(f)
	}
	return nil
}

// without is a copy of m without key.
func without(m map[string]any, key string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if k != key {
			out[k] = v
		}
	}
	return out
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

// hydration is what the include list hydrates: 'profilePictures', 'cosmetics' and 'tags'.
func (in *InfiniteInput) hydration() includes {
	return includes{profilePictures: in.IncludeProfilePictures, cosmetics: in.IncludeCosmetics, tags: in.IncludeTags}
}

// prioritized is getAllImages' prioritizeUser: a non-empty prioritizedUserIds.
func (in *InfiniteInput) prioritized() bool {
	return len(in.PrioritizedUserIDs) > 0
}

// prioritizedSystemUser is getAllImages' prioritizseIsSystemUser: exactly the system user (-1).
func (in *InfiniteInput) prioritizedSystemUser() bool {
	return len(in.PrioritizedUserIDs) == 1 && in.PrioritizedUserIDs[0] == -1
}

// ViewerScoped is isViewerScopedInfiniteFeed (src/server/schema/image.schema.ts) for the inputs this
// port answers: the rest of that list falls back to the app. A signed-out answer to one of them is
// not edge-cacheable, or a signed-in caller at the same URL gets it instead of their own.
func (in *InfiniteInput) ViewerScoped() bool {
	return len(in.Reactions) > 0 || in.Followed || in.Pending
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

// dbPath is requiresImageDbPath for the supported inputs: a post's media, a collection, reactions,
// ids, a model without a version (the feed has no model dimension), or prioritizedUserIds with a
// model or version scope. Every other shape it lists falls back in parsing.
func (in *InfiniteInput) dbPath() bool {
	return in.PostID != 0 || in.CollectionID != 0 || len(in.Reactions) > 0 || len(in.IDs) > 0 ||
		(in.ModelID != 0 && in.ModelVersionID == 0) ||
		(in.prioritized() && (in.ModelID != 0 || in.ModelVersionID != 0))
}

// addonScope is the scope the addons resolve under: `newCreators` for the board (both
// enforceBlockedBrowsingTags callers pass `scope: input.newCreators ? 'newCreators' : undefined`).
func (in *InfiniteInput) addonScope() string {
	if in.NewCreators {
		return "newCreators"
	}
	return ""
}

// InfiniteSources is the lookups image.getInfinite reads beyond the page's hydration (implemented by
// *hydrate.Sources).
type InfiniteSources interface {
	PostVersions(ctx context.Context, postIDs []int) (map[int]int, error)
	VersionModels(ctx context.Context, versionIDs []int) (map[int]int, error)
	UserIDByUsername(ctx context.Context, username string) (int, bool, error)
	// UserFollows is getUserFollows: the ids the user follows (empty for none).
	UserFollows(ctx context.Context, userID int) ([]int, error)
	// CollectionPermission is the collection's row getUserCollectionPermissionsById decides `read`
	// on, with the viewer's contributor permissions (viewerID 0: signed out); nil when the collection
	// does not exist.
	CollectionPermission(ctx context.Context, collectionID, viewerID int) (*hydrate.CollectionPermission, error)
}

// maxFollowedBinds bounds the follow list the Postgres path binds (`i."userId" IN (…)`, one Prisma
// parameter per id in Node, against Postgres' 65535 per statement): a longer list falls back
// (followed-db-many). It is the feed's own MAX_FOLLOWED, so a list the feed path answers is never
// refused here.
const maxFollowedBinds = feedsvc.MaxFollowed

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
	// namesASCII: every name is ASCII, so its strings.ToLower is JS's toLowerCase.
	namesASCII bool
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

// NamesASCII returns the blocked tag names as Names does, and whether every name is ASCII: only then
// is each lowercased name exactly JS's toLowerCase (Go's tables map a few non-ASCII letters to ASCII
// that JS does not, U+0130 among them).
func (b *BlockedTags) NamesASCII(ctx context.Context) (map[string]bool, bool, error) {
	l, err := b.list(ctx)
	if err != nil {
		return nil, false, err
	}
	return l.names, l.namesASCII, l.namesErr
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
	l := &blockedList{ids: make(map[int]bool, len(list)), names: make(map[string]bool, len(list)), namesASCII: true}
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
			l.namesASCII = l.namesASCII && IsASCII(name)
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
	// NewCreators reads the "new & upcoming" boards (`newCreators`); nil = not configured (a request
	// with `newCreators: true` falls back).
	NewCreators *NewCreatorBoards
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
	// BoardColor is getRequestBoardDomainColor of the request's host (browsing.HostColors.BoardColorOf):
	// which "new & upcoming" board `newCreators` reads.
	BoardColor string
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
	resolved := browsing.ResolveAddons(addons, AddonLevel(level), viewer.IsModerator, in.addonScope())
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
	tags, allBlocked, err := stripBlockedTags(ctx, d.Blocked, in.Tags)
	if err != nil {
		return nil, err
	}
	if allBlocked {
		// getAllImagesIndex's / getAllImagesUncaptured's own `{ nextCursor: undefined, items: [] }`;
		// the Postgres arm's caller stamps its source on it.
		v := superjson.Object{{Key: "nextCursor", Val: superjson.Undefined{}}, {Key: "items", Val: []any{}}}
		if !useIndex {
			v = append(v, superjson.Field{Key: "source", Val: "db"})
		}
		return &InfiniteAnswer{Value: v, Trivial: true}, nil
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
	// `followed`, signed in only: the viewer's follow list, read once and used by both the feed query
	// (serveImagesFromFeedService's followedUserIds) and the page query (getAllImagesUncaptured's
	// prefetchedUserFollows), each of which reads it again in Node (followedOn below).
	followedOn := in.Followed && viewer.ID != 0
	var follows []int
	if followedOn {
		if follows, err = d.Sources.UserFollows(ctx, viewer.ID); err != nil {
			return nil, err
		}
		if !useIndex && len(follows) > maxFollowedBinds {
			// Node binds the list one parameter per id (Prisma.join); a list this long is not answered
			// here, whatever Node then does with it.
			return nil, fallback.Safef("followed-db-many", "%d", len(follows))
		}
	}
	// `newCreators`: the board of the request's color, read once and used by both the feed query
	// (serveImagesFromFeedService's newCreatorUserIds) and the page query (getAllImagesUncaptured's
	// prefetchedNewCreators), each of which reads the same cache entry in Node.
	var board []int
	if in.NewCreators {
		if board, err = d.NewCreators.UserIDs(ctx, NewCreatorBoardID(req.BoardColor)); err != nil {
			return nil, err
		}
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
		Techniques:     in.Techniques,
		Tools:          in.Tools,
		BaseModels:     in.BaseModels,
		CollectionID:   in.CollectionID,
		// The tag filter only beside a collection (ParseInfinite refuses it alone).
		CollectionTagID:   in.CollectionTagID,
		IDs:               in.IDs,
		NewCreators:       in.NewCreators,
		NewCreatorUserIDs: board,
	}
	if viewer.ID != 0 {
		// `userId && reactions?.length`: signed out, the input still routes to Postgres but adds no
		// clause.
		q.Reactions = in.Reactions
	}
	if in.prioritized() {
		q.PrioritizedUserIDs = in.PrioritizedUserIDs
	}
	// An empty follow list adds no clause (`prefetchedUserFollows?.length`): the Postgres path then
	// answers the unfiltered page, while the feed path answers it with an empty page.
	if len(follows) > 0 {
		q.FollowedUserIDs = follows
	}
	if useIndex {
		return infiniteFromFeed(ctx, d, in, q, viewer, now, followedOn, follows, board)
	}
	return infiniteFromDB(ctx, d, in, q, viewer, now)
}

// infiniteFromFeed is getAllImagesIndex with the feed service available: the feed picks and orders
// the page, Postgres supplies the rows (feedHydrateQuery), and the answer is
// `{ items, nextCursor, source: 'feed' }`. followedOn is `followed` with a signed-in viewer, follows
// their follow list, board the new-creators board (with `newCreators`).
func infiniteFromFeed(ctx context.Context, d *InfiniteDeps, in *InfiniteInput, q ImagesQuery, viewer Viewer, now time.Time,
	followedOn bool, follows []int, board []int) (*InfiniteAnswer, error) {
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
		Techniques:            in.Techniques,
		Tools:                 in.Tools,
		BaseModels:            in.BaseModels,
		Followed:              followedOn,
		FollowedUserIDs:       follows,
		FollowedSent:          in.Followed,
		NewCreators:           in.NewCreators,
		NewCreatorUserIDs:     board,
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
	if (followedOn && len(follows) == 0) || (in.NewCreators && len(board) == 0) {
		// serveFromFeed, before it maps the input: a follow list with no creators, or an unpopulated
		// new-creators board, is an empty feed, whatever else the request says (its cursor included).
		return page([]any{}, "", true), nil
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
	images, _, err := fetchInfiniteRows(ctx, d, hq, viewer, now, in.hydration())
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
		if in.prioritizedSystemUser() && in.ModelVersionID == 0 {
			// The system user alone on a model without a version: Node reads no system post and orders
			// every visible image on the site by an IIF, with no model or creator clause at all. That
			// unbounded sort is left to Node rather than run here.
			return nil, fallback.New("prioritized-system-user-no-version")
		}
	}
	if in.CollectionID != 0 {
		// `if (!prefetchedCollectionPermissions?.read)`: getAllImagesUncaptured's own empty page,
		// stamped by the handler. Read after this service's own fallbacks above, so a request it
		// hands back never reads the collection.
		perm, err := d.Sources.CollectionPermission(ctx, in.CollectionID, viewer.ID)
		if err != nil {
			return nil, err
		}
		readable, err := collectionReadable(perm, viewer)
		if err != nil {
			return nil, err
		}
		if !readable {
			return &InfiniteAnswer{Value: superjson.Object{
				{Key: "nextCursor", Val: superjson.Undefined{}}, {Key: "items", Val: []any{}}, {Key: "source", Val: "db"},
			}, Trivial: true}, nil
		}
	}
	if in.prioritizedSystemUser() {
		// getAllImages' hasSystemPosts: with its own post on the version the system user's images are
		// answered like any prioritized creator's; without one, every creator's images on the version,
		// the system user's first (an IIF over the index).
		has, err := d.Gallery.SystemUserPostOnVersion(ctx, in.ModelVersionID)
		if err != nil {
			return nil, err
		}
		q.PrioritizedSystemOrder = !has
	}
	images, next, err := fetchInfiniteRows(ctx, d, q, viewer, now, in.hydration())
	if err != nil {
		return nil, err
	}
	if len(in.IDs) > 0 {
		// Images picked by id name no model, so each is held by its own post's model.
		if images, err = withoutHeldFromViewer(ctx, d, images, viewer); err != nil {
			return nil, err
		}
	}
	items := make([]any, len(images))
	for i, img := range images {
		items[i] = img.Wire
	}
	return &InfiniteAnswer{Value: superjson.Object{
		{Key: "nextCursor", Val: next}, {Key: "items", Val: items}, {Key: "source", Val: "db"},
	}, Trivial: len(images) == 0}, nil
}

// withoutHeldFromViewer is the handler's withoutHeldFromViewer for a page picked by id: an image on a
// post whose model is held (minor or SFW-only) is kept only at a level that intersects the hold, or
// for the model's owner; a moderator sees every image. Order is kept. A held model whose settings
// carry no level falls back (`held-level-unset`), as the gallery gate does.
func withoutHeldFromViewer(ctx context.Context, d *InfiniteDeps, images []Image, viewer Viewer) ([]Image, error) {
	if len(images) == 0 || viewer.IsModerator {
		return images, nil
	}
	// `images.map((image) => image.postId).filter(isDefined)`: an image with no post is never held,
	// and no lookup is made for it.
	postIDs := make([]int, 0, len(images))
	for _, img := range images {
		if img.PostID != 0 {
			postIDs = append(postIDs, img.PostID)
		}
	}
	if len(postIDs) == 0 {
		return images, nil
	}
	holds, err := heldByPost(ctx, d.Sources, d.Gallery, postIDs, "held-level-unset")
	if err != nil || len(holds) == 0 {
		return images, err
	}
	modelIDs := make([]int, 0, len(holds))
	for _, h := range holds {
		modelIDs = append(modelIDs, h.modelID)
	}
	slices.Sort(modelIDs)
	owners, err := d.Gallery.ModelOwners(ctx, hydrate.Unique(modelIDs))
	if err != nil {
		return nil, err
	}
	out := images[:0:0]
	for _, img := range images {
		h, held := holds[img.PostID]
		owner, known := owners[h.modelID]
		isOwner := viewer.ID != 0 && known && owner == viewer.ID
		if held && !isOwner && h.level&img.NsfwLevel == 0 {
			continue
		}
		out = append(out, img)
	}
	return out, nil
}

// fetchInfiniteRows is one getAllImages call: the query (through the page cache), the hydration
// and the per-image transform with image.getInfinite's wire trim. next is the response's
// `nextCursor`: the look-ahead row's cursor column (the image id, or a post's nullable index), or
// undefined at the end. inc is what the include list hydrates (includes).
func fetchInfiniteRows(ctx context.Context, d *InfiniteDeps, q ImagesQuery, viewer Viewer, now time.Time, inc includes) ([]Image, any, error) {
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
	for _, r := range rows {
		if r.Collection != nil && !judgeScoreNull(r.Collection.Note) {
			// parseJudgeScore would answer a judge's score for this item: not rebuilt here.
			return nil, nil, fallback.New("collection-judge-score")
		}
	}
	hy, err := hydrateRows(ctx, d.Hydrator, rows, viewer, d.Config.VisibleDecorationEvents, inc)
	if err != nil {
		return nil, nil, err
	}
	return BuildInfiniteImages(rows, hy, viewer, now), next, nil
}

// BuildInfiniteImages is getAllImagesUncaptured's per-image transform under stripImageForInfiniteWire
// only (image.getInfinite does not apply the gallery's stripImageForAsPostsWire): the gallery wire
// plus `availability`, `meta` (null: 'metaSelect' is not ported), `baseModel` (undefined:
// includeBaseModel is not ported) and `judgeScore` (null: outside a collection, and in one for every
// item served, as fetchInfiniteRows falls back on any other score). A collection page's row also
// carries `collectionItemStatus` and `collectionItemAddedById` (the SELECT's columns, after
// `restricted`). The publish filter is BuildImages'.
func BuildInfiniteImages(rows []RawImage, hy *Hydrated, viewer Viewer, now time.Time) []Image {
	images := BuildImages(rows, hy, viewer, now)
	byID := make(map[int]*RawImage, len(rows))
	for i := range rows {
		byID[rows[i].ID] = &rows[i]
	}
	for i := range images {
		img := &images[i]
		availability := ""
		var item *CollectionItem
		if r := byID[img.ID]; r != nil {
			availability, item = r.Availability, r.Collection
		}
		// In the Node object's key order: `availability` is the SELECT's column before `minor`, `meta`
		// follows `restricted` (and a collection row's two columns), `baseModel` is set after
		// `modelVersionIdsManual`, and `judgeScore` is last.
		wire := make(superjson.Object, 0, len(img.Wire)+6)
		for _, f := range img.Wire {
			switch f.Key {
			case "minor":
				wire = append(wire, superjson.Field{Key: "availability", Val: availability})
			case "modelVersionIds":
				wire = append(wire, superjson.Field{Key: "meta", Val: nil})
			case "user":
				wire = append(wire, superjson.Field{Key: "baseModel", Val: superjson.Undefined{}})
			}
			wire = append(wire, f)
			if item != nil && f.Key == "restricted" {
				wire = append(wire,
					superjson.Field{Key: "collectionItemStatus", Val: item.Status},
					superjson.Field{Key: "collectionItemAddedById", Val: intOrNil(item.AddedByID)},
				)
			}
		}
		wire = append(wire, superjson.Field{Key: "judgeScore", Val: nil})
		img.Wire = wire
	}
	return images
}

// IsASCII reports whether s is all ASCII: the text on which Go's case mapping (strings.ToLower,
// case-insensitive matching) is exactly JS's. The one ASCII predicate the ports share.
func IsASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}
