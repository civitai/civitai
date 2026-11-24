package hydrate

import (
	"context"
	"fmt"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// The viewer's follow list of image.getInfinite's `followed: true`: getUserFollows
// (src/server/redis/caches.ts), `userFollowsCache.fetch(userId)` then `userFollows[userId]?.follows
// ?? []`. Node reads it in serveImagesFromFeedService (the feed's `userIds`) and again in
// getAllImagesUncaptured (`i."userId" IN (…)`); this service reads it once per request and uses that
// list for both.

// KeyUserFollows is REDIS_KEYS.CACHES.USER_FOLLOWS.
const KeyUserFollows = "packed:caches:user-follows"

// userFollowsSpec is userFollowsCache's write shape: ttl a day, staleWhileRevalidate off (an entry is
// never stale: Redis expires it at the same EX), cacheNotFound (default) on, no notFoundTtl. It is
// computed on a miss but not in WriteCaches, so this service never writes it.
var userFollowsSpec = lookupSpec{cache: MissUserFollows, reason: "user-follows-miss", key: KeyUserFollows, idKey: "userId",
	ttl: ttlDay, notFoundTTL: ttlDay}

// UserFollows is getUserFollows(userID): the ids the user follows, in cached order. A notFound marker
// (the lookup found no Follow row) is no follows. A miss (no key, a debounce marker, an undecodable
// value, a failed read) is computed with s.Compute (userFollowsCache's lookupFn on the replica, never
// written back) and otherwise falls back (user-follows-miss). An entry Node would read differently
// (another user's record under the key, a `follows` that is not a list of integers) falls back
// (user-follows-shape).
func (s *Sources) UserFollows(ctx context.Context, userID int) ([]int, error) {
	ids := []int{userID}
	b := NewBatch()
	read := s.Packed.Queue(b, KeyUserFollows, ids, 0)
	b.Exec(ctx)
	got, _ := read.read()
	if s.Compute != nil {
		// writable nil: nothing is written back, whatever FEED_GO_CACHE_WRITEBACK lists.
		if err := s.fill(ctx, userFollowsSpec, ids, got, nil, true, nil, s.lookupUserFollows); err != nil {
			return nil, err
		}
	}
	return userFollowsFrom(userID, got)
}

// userFollowsFrom is `userFollows[userId]?.follows ?? []` over the cache's answer got.
func userFollowsFrom(userID int, got map[int]Entry) ([]int, error) {
	e, ok := got[userID]
	if !ok {
		return nil, fallback.Safef("user-follows-miss", "1 id")
	}
	if e.NotFound {
		return []int{}, nil
	}
	// createCachedObject.fetch keys its answer by the record's own `userId`: a record naming another
	// user is not this user's entry.
	if id, ok := Int(e.Value["userId"]); !ok || id != userID {
		return nil, fallback.Safef("user-follows-shape", "userId")
	}
	raw, present := e.Value["follows"]
	if !present || raw == nil {
		return []int{}, nil // `?.follows ?? []`
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, fallback.Safef("user-follows-shape", "follows")
	}
	out := make([]int, 0, len(list))
	for _, v := range list {
		n, ok := followID(v)
		if !ok {
			return nil, fallback.Safef("user-follows-shape", "follow id")
		}
		out = append(out, n)
	}
	return out, nil
}

// FollowedUserIDs is model.getAll's follow list (getModelsRaw's `followed`): the ids the user follows,
// read from the replica on every call, never through userFollowsCache, as Node reads them
// (`dbRead.user.findUnique({ where: { id }, select: { engagingUsers: { where: { type: 'Follow' } } } })`:
// the user's Follow rows of UserEngagement). It runs the cache lookup's own statement
// (sqlUserFollows) for the one user; the order is the rows', which only feeds an `IN (…)`. No row is
// an empty list.
func (s *Sources) FollowedUserIDs(ctx context.Context, userID int) ([]int, error) {
	got, err := s.lookupUserFollows(ctx, []int{userID})
	if err != nil {
		return nil, err
	}
	rec, ok := got[userID]
	if !ok {
		return []int{}, nil
	}
	var out []int
	for _, kv := range rec {
		if kv.K != "follows" {
			continue
		}
		list, _ := kv.V.([]any)
		out = make([]int, 0, len(list))
		for _, v := range list {
			n, ok := Int(v)
			if !ok {
				return nil, fmt.Errorf("followed user ids: %v", v)
			}
			out = append(out, n)
		}
	}
	if out == nil {
		out = []int{}
	}
	return out, nil
}

// followID reads one cached follow id: an integer msgpack number (a string, which Int would parse,
// is not one Node binds the same way).
func followID(v any) (int, bool) {
	if _, isStr := v.(string); isStr {
		return 0, false
	}
	return Int(v)
}

// sqlUserFollows is userFollowsCache's lookupFn: `userEngagement.findMany({ where: { userId: { in:
// ids }, type: 'Follow' }, select: { userId, targetUserId } })` on the replica (a fetch's lookupFn(ids)
// reads dbRead). No ORDER BY, as Prisma sends none.
const sqlUserFollows = `SELECT "userId", "targetUserId" FROM "UserEngagement" WHERE "userId" = ANY($1::int[]) AND "type" = 'Follow'`

// lookupUserFollows is the lookupFn's reduce: per user with at least one row, `{userId, follows}` with
// the target ids in row order; a user with none is absent (a notFound marker).
func (s *Sources) lookupUserFollows(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
	rows, err := s.Replica.Query(ctx, sqlUserFollows, ids)
	if err != nil {
		return nil, err
	}
	maps, err := rowsToMaps(rows)
	if err != nil {
		return nil, err
	}
	order := []int{}
	follows := map[int][]any{}
	for _, m := range maps {
		uid, ok1 := Int(m["userId"])
		target, ok2 := Int(m["targetUserId"])
		if !ok1 || !ok2 {
			return nil, fmt.Errorf("user follows: row %v", m)
		}
		if _, seen := follows[uid]; !seen {
			order = append(order, uid)
		}
		follows[uid] = append(follows[uid], int64(target))
	}
	out := make(map[int]jspack.Obj, len(order))
	for _, id := range order {
		out[id] = jspack.O("userId", id, "follows", follows[id])
	}
	return out, nil
}
