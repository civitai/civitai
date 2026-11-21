package hydrate

import (
	"context"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// BasicUser is the userBasicCache value (getBasicDataForUsers).
type BasicUser struct {
	ID        int
	Username  any // string or nil
	Image     any // string or nil
	DeletedAt any // *time.Time (one Date per user, basicUserFrom) or nil
}

// basicUsersFrom is getBasicDataForUsers over the `basic-users` cache's answer got for (unique) ids
// (stale entries served): the misses are read from the replica with the same Prisma select.
func (s *Sources) basicUsersFrom(ctx context.Context, ids []int, got map[int]Entry) (map[int]BasicUser, error) {
	out := make(map[int]BasicUser, len(ids))
	for id, e := range got {
		if e.NotFound {
			continue
		}
		out[id] = basicUserFrom(id, e.Value)
	}
	if miss := Missing(ids, got); len(miss) > 0 {
		rows, err := s.Replica.Query(ctx, `SELECT id, username, "deletedAt", image FROM "User" WHERE id = ANY($1::int[])`, miss)
		if err != nil {
			return nil, err
		}
		maps, err := rowsToMaps(rows)
		if err != nil {
			return nil, err
		}
		for _, m := range maps {
			id, _ := Int(m["id"])
			out[id] = basicUserFrom(id, m)
		}
	}
	return out, nil
}

func basicUserFrom(id int, m map[string]any) BasicUser {
	u := BasicUser{ID: id, Username: m["username"], Image: m["image"], DeletedAt: m["deletedAt"]}
	if t, ok := u.DeletedAt.(time.Time); ok {
		// One Date per user: every image's `user` carries `deletedAt: userData?.deletedAt ?? null`, the
		// same Date from the user's cached entry, so the devalue writer writes it once (a pointer is
		// that identity; the superjson writer reads through it).
		u.DeletedAt = &t
	}
	return u
}

// equippedCosmetic is one entry of a user's cached equipped list.
type equippedCosmetic struct {
	cosmeticID int
	data       any
}

// userCosmeticsFrom is getCosmeticsForUsers' first half over the user-cosmetics cache's answer got
// for (unique) ids: each user's equipped list, and the cosmetic ids to join (unordered, possibly
// repeated). An id got does not answer falls back; with Sources.Compute, fillUserCosmetics has
// computed every miss (lookupUserCosmetics) into got before this runs.
func userCosmeticsFrom(ids []int, got map[int]Entry) (map[int][]equippedCosmetic, []int, error) {
	if miss := Missing(ids, got); len(miss) > 0 {
		return nil, nil, fallback.Safef("user-cosmetics-miss", "%d ids", len(miss))
	}
	perUser := map[int][]equippedCosmetic{}
	var cosmeticIDs []int
	for id, e := range got {
		if e.NotFound {
			continue
		}
		list, _ := e.Value["cosmetics"].([]any)
		for _, item := range list {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			cid, _ := Int(m["cosmeticId"])
			perUser[id] = append(perUser[id], equippedCosmetic{cosmeticID: cid, data: m["data"]})
			cosmeticIDs = append(cosmeticIDs, cid)
		}
	}
	return perUser, cosmeticIDs, nil
}

// joinUserCosmetics is getCosmeticsForUsers' second half: per user id, the wire array
// `[{cosmeticId, data, cosmetic}]`, each equipped entry with its cosmetic record, or undefined when
// the record exists nowhere. cosmetics is cosmeticsFrom's answer for (at least) the ids
// userCosmeticsFrom returned; a record is a pure function of its id, so extra ids change nothing.
func joinUserCosmetics(perUser map[int][]equippedCosmetic, cosmetics map[int]superjson.Object) map[int][]any {
	out := make(map[int][]any, len(perUser))
	for uid, list := range perUser {
		arr := make([]any, 0, len(list))
		for _, c := range list {
			var cosmetic any = superjson.Undefined{}
			if rec, ok := cosmetics[c.cosmeticID]; ok {
				cosmetic = rec
			}
			arr = append(arr, superjson.Object{
				{Key: "cosmeticId", Val: int64(c.cosmeticID)},
				{Key: "data", Val: Wire(c.data)},
				{Key: "cosmetic", Val: cosmetic},
			})
		}
		out[uid] = arr
	}
	return out
}

// cosmeticsFrom is cosmeticCache.fetch (`{id, name, type, data, source, flags?}` per cosmetic id) over
// the cache's answer got for (unique) ids, stale entries served: the misses are read from the replica.
func (s *Sources) cosmeticsFrom(ctx context.Context, ids []int, got map[int]Entry) (map[int]superjson.Object, error) {
	out := make(map[int]superjson.Object, len(ids))
	for id, e := range got {
		if !e.NotFound {
			out[id] = Pick(e.Value, "id", "name", "type", "data", "source", "flags")
		}
	}
	if miss := Missing(ids, got); len(miss) > 0 {
		rows, err := s.Replica.Query(ctx, `SELECT id, name, type, data, source, flags FROM "Cosmetic" WHERE id = ANY($1::int[])`, miss)
		if err != nil {
			return nil, err
		}
		maps, err := rowsToMaps(rows)
		if err != nil {
			return nil, err
		}
		for _, m := range maps {
			id, _ := Int(m["id"])
			out[id] = Pick(m, "id", "name", "type", "data", "source", "flags")
		}
	}
	return out, nil
}

// profilePictureColumns is the profile-pictures:v4 lookup's select list, in order.
var profilePictureColumns = []string{"id", "name", "url", "nsfwLevel", "hash", "userId", "ingestion", "type", "width", "height", "metadata"}

// profilePicturesFrom is getProfilePicturesForUsers over the cache's answer got for (unique) ids. The
// miss path runs the cache's own lookup query on the replica: the user's profile picture, only when it
// is servable (servableProfilePictureSql, src/server/services/profile-picture.sql.ts).
func (s *Sources) profilePicturesFrom(ctx context.Context, ids []int, got map[int]Entry) (map[int]superjson.Object, error) {
	out := make(map[int]superjson.Object, len(ids))
	for id, e := range got {
		if !e.NotFound {
			out[id] = Pick(e.Value, profilePictureColumns...)
		}
	}
	if miss := Missing(ids, got); len(miss) > 0 {
		rows, err := s.Replica.Query(ctx, `
			SELECT i.id, i.name, i.url, i."nsfwLevel", i.hash, i."userId", i.ingestion, i.type, i.width, i.height, i.metadata
			FROM "User" u
			JOIN "Image" i ON i.id = u."profilePictureId"
			WHERE u.id = ANY($1::int[])
			  AND i.ingestion <> 'Blocked'
			  AND i."nsfwLevel" != 0
			  AND (i."needsReview" IS NULL OR i."needsReview" NOT IN ('csam', 'minor'))
			  AND `+ImageReviewedSQL("i")+`
			  AND ((i."nsfwLevel" & 60) = 0 OR NOT i."modelRestricted")
			  AND NOT `+HasBlockMarkerSQL("i"), miss)
		if err != nil {
			return nil, err
		}
		maps, err := rowsToMaps(rows)
		if err != nil {
			return nil, err
		}
		for _, m := range maps {
			uid, _ := Int(m["userId"])
			out[uid] = Pick(m, profilePictureColumns...)
		}
	}
	return out, nil
}

// HasBlockMarkerSQL is hasBlockMarkerSql(alias) (src/server/common/image-visibility.ts), with its
// bound values inlined as literals.
func HasBlockMarkerSQL(alias string) string {
	a := `"` + alias + `"`
	return `(` + a + `."ingestion" = 'Blocked'::"ImageIngestionStatus" OR ` + a + `."nsfwLevel" = 32 OR ` + a + `."blockedFor" IS NOT NULL)`
}

// ImageReviewedSQL is imageReviewedSql(alias) (src/server/common/image-visibility.ts), with its bound
// values inlined as literals (they are constants).
func ImageReviewedSQL(alias string) string {
	a := `"` + alias + `"`
	return `(` + a + `."ingestion" = 'Scanned'::"ImageIngestionStatus"
	 OR (` + a + `."nsfwLevelLocked" = TRUE
	     AND ` + a + `."ingestion" NOT IN ('Blocked'::"ImageIngestionStatus", 'NotFound'::"ImageIngestionStatus")
	     AND NOT (` + a + `."ingestion" = 'Error'::"ImageIngestionStatus"
	              AND (COALESCE(` + a + `."metadata"->>'nsfwLevelReason','') = 'Knights Vote'
	                   OR COALESCE(` + a + `."scanJobs"->'error'->>'failureClass','') = 'permanent'
	                   OR COALESCE(` + a + `."scanJobs"->'lastFailure'->>'failureClass','') = 'permanent'
	                   OR COALESCE(` + a + `."scanJobs"->'permanentFailure' = 'true'::jsonb, FALSE)))))`
}

// Unique returns ids without duplicates or zeros, keeping first-seen order.
func Unique(ids []int) []int {
	seen := make(map[int]bool, len(ids))
	out := make([]int, 0, len(ids))
	for _, id := range ids {
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
