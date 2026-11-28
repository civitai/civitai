//go:build integration

package feed

// The image query's block terms (blockedMediaListConditions, src/server/common/image-visibility.ts)
// against a real Postgres. Ids live in 2_110_000..2_110_999.

import (
	"reflect"
	"sort"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// integSeedOwnerBlocked resets the 2_110_xxx fixture, every image on a published Public post:
//
//	2110001 owner 2110901  blockedFor CSAM,          ingestion Blocked, level 0  (blocked at scan, unrated)
//	2110002 owner 2110901  no blockedFor,            ingestion Blocked, level 0
//	2110003 owner 2110901  blockedFor AiNotVerified, ingestion Blocked, level 0  (a hold: exempt)
//	2110004 owner 2110901  clean,                    Scanned, level 1
//	2110005 owner 2110901  blockedFor Moderated,     Scanned, level 1
//	2110006 owner 2110902  blockedFor AiNotVerified, Scanned, level 1
//	2110007 owner 2110902  clean,                    Scanned, level 1
//
// The level 0 rows reach only the pending view (its owner carve-out keeps an unrated own image).
func integSeedOwnerBlocked(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	integtest.Exec(t, pool, `
		DELETE FROM "Image" WHERE id BETWEEN 2110000 AND 2110999;
		DELETE FROM "Post" WHERE id BETWEEN 2110000 AND 2110999;
		INSERT INTO "Post" (id, "userId", "publishedAt", availability) VALUES
		  (2110501, 2110901, '2021-02-01 00:00:00', 'Public'),
		  (2110502, 2110902, '2021-02-01 00:00:00', 'Public');
		INSERT INTO "Image" (id, url, "userId", type, "nsfwLevel", "postId", ingestion, "blockedFor") VALUES
		  (2110001, 'integ-ob1', 2110901, 'image', 0, 2110501, 'Blocked', 'CSAM'),
		  (2110002, 'integ-ob2', 2110901, 'image', 0, 2110501, 'Blocked', NULL),
		  (2110003, 'integ-ob3', 2110901, 'image', 0, 2110501, 'Blocked', 'AiNotVerified'),
		  (2110004, 'integ-ob4', 2110901, 'image', 1, 2110501, 'Scanned', NULL),
		  (2110005, 'integ-ob5', 2110901, 'image', 1, 2110501, 'Scanned', 'Moderated'),
		  (2110006, 'integ-ob6', 2110902, 'image', 1, 2110502, 'Scanned', 'AiNotVerified'),
		  (2110007, 'integ-ob7', 2110902, 'image', 1, 2110502, 'Scanned', NULL);`)
}

func TestIntegrationOwnerBlockedMedia(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedOwnerBlocked(t, pool)
	ids := []int{2110001, 2110002, 2110003, 2110004, 2110005, 2110006, 2110007}
	run := func(q ImagesQuery) []int {
		got := integIDs(integRun(t, pool, q))
		sort.Ints(got)
		return got
	}
	for _, c := range []struct {
		name string
		q    ImagesQuery
		want []int
	}{
		// Positive control: every row reachable at this level.
		{"moderator", ImagesQuery{IDs: ids, Limit: 20, BrowsingLevel: browsing.AllLevels, IsModerator: true},
			[]int{2110004, 2110005, 2110006, 2110007}},
		{"signed out", ImagesQuery{IDs: ids, Limit: 20, BrowsingLevel: browsing.AllLevels},
			[]int{2110004, 2110007}},
		// The owner of 2110001..2110005: their Moderated block (2110005) is not theirs to see.
		{"owner", ImagesQuery{IDs: ids, Limit: 20, BrowsingLevel: browsing.AllLevels, ViewerID: 2110901},
			[]int{2110004, 2110007}},
		// The owner of 2110006..2110007: their AiNotVerified hold is theirs to see.
		{"the other owner", ImagesQuery{IDs: ids, Limit: 20, BrowsingLevel: browsing.AllLevels, ViewerID: 2110902},
			[]int{2110004, 2110006, 2110007}},
		// The owner's pending view also reaches their unrated rows: of those only the AiNotVerified
		// hold (2110003); not the CSAM block (2110001) nor the Blocked ingestion with no reason (2110002).
		{"owner, pending", ImagesQuery{IDs: ids, Limit: 20, BrowsingLevel: browsing.AllLevels, ViewerID: 2110901, Pending: true},
			[]int{2110003, 2110004, 2110007}},
		{"moderator, pending", ImagesQuery{IDs: ids, Limit: 20, BrowsingLevel: browsing.AllLevels, IsModerator: true, Pending: true},
			[]int{2110001, 2110002, 2110003, 2110004, 2110005, 2110006, 2110007}},
	} {
		if got := run(c.q); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s = %v, want %v", c.name, got, c.want)
		}
	}
}
