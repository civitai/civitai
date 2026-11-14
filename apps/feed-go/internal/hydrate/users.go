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
	DeletedAt any // time.Time or nil
}

// BasicUsers is getBasicDataForUsers: cache `basic-users` (stale served), miss -> the same Prisma select.
func (s *Sources) BasicUsers(ctx context.Context, ids []int) (map[int]BasicUser, error) {
	ids = Unique(ids)
	got := s.Packed.Get(ctx, KeyBasicUsers, ids, ttlDay)
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
		u.DeletedAt = t
	}
	return u
}

// UserCosmetics is getCosmeticsForUsers: the per-user equipped list joined with the cosmetic records.
// Returns, per user id, the wire array `[{cosmeticId, data, cosmetic}]`.
//
// The user-cosmetics miss path (which drops withheld creator cosmetics) is not ported: a miss falls back.
func (s *Sources) UserCosmetics(ctx context.Context, ids []int) (map[int][]any, error) {
	ids = Unique(ids)
	got := s.Packed.Get(ctx, KeyUserCosmetics, ids, 0)
	if miss := Missing(ids, got); len(miss) > 0 {
		return nil, fallback.Newf("user-cosmetics-miss", "%d ids", len(miss))
	}
	type equipped struct {
		cosmeticID int
		data       any
	}
	perUser := map[int][]equipped{}
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
			perUser[id] = append(perUser[id], equipped{cosmeticID: cid, data: m["data"]})
			cosmeticIDs = append(cosmeticIDs, cid)
		}
	}
	cosmetics, err := s.Cosmetics(ctx, cosmeticIDs)
	if err != nil {
		return nil, err
	}
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
	return out, nil
}

// Cosmetics is cosmeticCache.fetch: `{id, name, type, data, source, flags?}` per cosmetic id.
func (s *Sources) Cosmetics(ctx context.Context, ids []int) (map[int]superjson.Object, error) {
	ids = Unique(ids)
	out := make(map[int]superjson.Object, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	got := s.Packed.Get(ctx, KeyCosmetics, ids, ttlDay)
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

// profilePictureColumns is the profile-pictures:v2 lookup's select list, in order.
var profilePictureColumns = []string{"id", "name", "url", "nsfwLevel", "hash", "userId", "ingestion", "type", "width", "height", "metadata"}

// ProfilePictures is getProfilePicturesForUsers. The miss path runs the cache's own lookup query:
// the user's profile picture, only when it is servable (src/server/services/profile-picture.sql.ts).
func (s *Sources) ProfilePictures(ctx context.Context, ids []int) (map[int]superjson.Object, error) {
	ids = Unique(ids)
	got := s.Packed.Get(ctx, KeyProfilePictures, ids, 0)
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
			  AND i."needsReview" IS DISTINCT FROM 'csam'
			  AND `+ImageReviewedSQL("i"), miss)
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

// ImageReviewedSQL is imageReviewedSql(alias) (src/server/common/image-visibility.ts), with its bound
// values inlined as literals (they are constants).
func ImageReviewedSQL(alias string) string {
	a := `"` + alias + `"`
	return `(` + a + `."ingestion" = 'Scanned'::"ImageIngestionStatus"
	 OR (` + a + `."nsfwLevelLocked" = TRUE
	     AND ` + a + `."ingestion" NOT IN ('Blocked'::"ImageIngestionStatus", 'NotFound'::"ImageIngestionStatus")
	     AND NOT (` + a + `."ingestion" = 'Error'::"ImageIngestionStatus"
	              AND (COALESCE(` + a + `."metadata"->>'nsfwLevelReason','') = 'Knights Vote'
	                   OR COALESCE(` + a + `."scanJobs"->'error'->>'failureClass','') = 'permanent'))))`
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
