package modelfeed

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// assocTarget is one ModelAssociations row as listModelAssociationTargets reads it.
type assocTarget struct {
	ToModelID   *int
	ToArticleID *int
}

// sourceModel is getModelPoiAndOwner (packages/civitai-db-queries/src/hot-reads-6.db.ts), the read of
// the `model.*` visibility middleware (modelVisibleToViewer, model.router.ts): found is false for an
// id with no row.
func sourceModel(ctx context.Context, db Querier, id int) (poi bool, ownerID int, found bool, err error) {
	rows, err := db.Query(ctx, `SELECT "poi", "userId" FROM "Model" WHERE "id" = $1 LIMIT 1`, id)
	if err != nil {
		return false, 0, false, err
	}
	defer rows.Close()
	if rows.Next() {
		if err := rows.Scan(&poi, &ownerID); err != nil {
			return false, 0, false, err
		}
		found = true
	}
	return poi, ownerID, found, rows.Err()
}

// associationTargets is listModelAssociationTargets: the source model's associations of one type,
// ordered by `index` only (as the Kysely read orders them; ties are the database's order, as Node's).
func associationTargets(ctx context.Context, db Querier, fromID int, typ string) ([]assocTarget, error) {
	rows, err := db.Query(ctx, `SELECT "toModelId", "toArticleId" FROM "ModelAssociations"
		WHERE "fromModelId" = $1 AND "type" = $2::"AssociationType"
		ORDER BY "index" ASC`, fromID, typ)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []assocTarget
	for rows.Next() {
		var t assocTarget
		if err := rows.Scan(&t.ToModelID, &t.ToArticleID); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// assocPromotionWindow is MAX_RUN_MS (src/shared/utils/promotion.ts): the longest run, the window
// liveApprovedPromotions reads.
const assocPromotionWindow = 7 * 24 * time.Hour

// approvedModelPromotions counts liveApprovedPromotions({ surface: 'modelPromotion', modelId }): the
// approved model-card runs on the source model resolved within the longest run. `since` is bound as a
// UTC wall-clock literal, as Prisma compares its timestamp(3) columns.
func approvedModelPromotions(ctx context.Context, db Querier, modelID int, since time.Time) (int, error) {
	rows, err := db.Query(ctx, `SELECT count(*) FROM "Placement"
		WHERE "surface" = 'modelPromotion' AND "targetType" = 'model' AND "targetId" = $1
		  AND "status" = 'approved' AND "resolvedAt" > $2::timestamp`, modelID, since.UTC().Format("2006-01-02T15:04:05.000"))
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	n := 0
	if rows.Next() {
		if err := rows.Scan(&n); err != nil {
			return 0, err
		}
	}
	return n, rows.Err()
}

// HiddenPrefs reads the viewer's hidden and blocked users (implemented by *PackedHiddenPrefs).
type HiddenPrefs interface {
	// HiddenUserIDs is the ids of HiddenUsers, BlockedByUsers and BlockedUsers.getCached({ userId })
	// (src/server/services/user-preferences.service.ts), in that order with duplicates; ok is false
	// when any of the three is not cached (Node then reads the database and writes the field).
	HiddenUserIDs(ctx context.Context, userID int) (ids []int, ok bool, err error)
}

// The three createUserCache fields getAssociatedResourcesCardDataHandler reads, in its order.
var hiddenPrefsFields = []string{"hidden-users-5", "blocked-by-users-2", "blocked-users-2"}

// PackedHiddenPrefs reads the per-user hidden-preferences hash, `packed:user:<id>:hidden-prefs`
// (getUserPrefsHashKey), one msgpackr-packed field per cache. Prefix is the cache key prefix
// (hydrate.PackedReader.Prefix).
type PackedHiddenPrefs struct {
	Redis  redis.UniversalClient
	Prefix string
}

// HiddenUserIDs reads the three fields in one pipeline. A field that is absent, empty or not a
// packed list of `{ id }` entries is a miss (`redis.packed.hGet` answers null for an empty or
// undecodable value, and getCached then refills it); any other Redis error is returned (Node's
// read throws).
func (p *PackedHiddenPrefs) HiddenUserIDs(ctx context.Context, userID int) ([]int, bool, error) {
	key := p.Prefix + "packed:user:" + strconv.Itoa(userID) + ":hidden-prefs"
	cmds := make([]*redis.StringCmd, len(hiddenPrefsFields))
	_, err := p.Redis.Pipelined(ctx, func(pipe redis.Pipeliner) error {
		for i, f := range hiddenPrefsFields {
			cmds[i] = pipe.HGet(ctx, key, f)
		}
		return nil
	})
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, false, err
	}
	ids := make([]int, 0, len(cmds))
	for _, cmd := range cmds {
		b, err := cmd.Bytes()
		if errors.Is(err, redis.Nil) || (err == nil && len(b) == 0) {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		list, ok := decodeUserList(b)
		if !ok {
			return nil, false, nil
		}
		ids = append(ids, list...)
	}
	return ids, true, nil
}

// decodeUserList decodes one field: a list of `{ id, username }` rows.
func decodeUserList(b []byte) ([]int, bool) {
	v, err := hydrate.Unpack(b)
	if err != nil {
		return nil, false
	}
	list, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]int, 0, len(list))
	for _, e := range list {
		row, ok := e.(map[string]any)
		if !ok {
			return nil, false
		}
		id, ok := hydrate.Int(row["id"])
		if !ok {
			return nil, false
		}
		out = append(out, id)
	}
	return out, true
}
