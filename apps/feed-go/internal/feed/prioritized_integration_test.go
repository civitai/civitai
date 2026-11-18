//go:build integration

package feed

// getAllImages' prioritizeUser branch (version cache off) and `pending`, against a real Postgres:
// which rows the page query returns, in which order, with which cursor. Expected values are literals
// worked out from image.service.ts's SQL by hand over the fixture below, never values computed by the
// code under test.
//
// Ids in this file live in 2_106_000..2_106_999.

import (
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// integSeedPrioritized resets the 2_106_xxx fixture: model owner O = 2106901, another creator
// X = 2106902, viewer V = 2106903 (MANAGEs collection 2106701), viewer W = 2106904 (VIEW only on it).
// Version 2106601 and 2106602 (both model 2106651).
//
//	post     owner  version  published   collection
//	2106501  O      2106601  2021-01-01
//	2106502  O      2106601  2021-02-01
//	2106503  O      2106602  2021-01-15
//	2106504  X      2106601  2021-01-20
//	2106505  O      2106601  NULL (draft)
//	2106506  O      2106601  2999-01-01 (scheduled)
//	2106507  O      2106601  2021-03-01  2106701
//
//	image    owner post     index  nsfw  other                  order key (postId*100 + COALESCE(index,0))
//	2106010  O     2106502  0      1                            210650200
//	2106011  O     2106501  2      1                            210650102
//	2106012  O     2106501  1      1                            210650101
//	2106013  O     2106501  NULL   1                            210650100
//	2106014  O     2106503  0      1     ImageResourceNew 2106601 (post is on 2106602)
//	2106015  X     2106504  0      1                            210650400
//	2106016  O     2106505  0      1     draft post             210650500
//	2106017  O     2106506  0      1     scheduled post         210650600
//	2106019  O     2106502  1      0     unrated, Pending       210650201
//	2106020  O     2106507  0      4     managed collection     210650700
//	2106021  O     2106502  3      1     needsReview            210650203
//	2106022  O     2106501  150    1     index past 100         210650250 (after 2106502's index 0)
//	2106023  O     2106502  0      1     ties 2106010           210650200 (id breaks the tie)
//	2106024  O     2106502  4      1     acceptableMinor        210650204
//	2106025  X     2106504  1      1     acceptableMinor        210650401
//	2106026  O     2106507  1      0     managed collection     210650701 (unrated)
//	2106027  O     2106507  2      32    managed collection     210650702 (Blocked level)
//	2106028  O     2106502  5      1     needsReview csam       210650205
//	2106029  O     2106502  6      1     needsReview poi        210650206
//	2106030  X     2106504  2      1     needsReview poi        210650402
//	2106031  X     2106504  3      1     needsReview csam       210650403
//
// Every image is Scanned unless the row says otherwise; no image is in ImageResourceNew but 2106014.
func integSeedPrioritized(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	integtest.Exec(t, pool, `
		DELETE FROM "Image" WHERE id BETWEEN 2106000 AND 2106999;
		DELETE FROM "Post" WHERE id BETWEEN 2106000 AND 2106999;
		DELETE FROM "ImageResourceNew" WHERE "imageId" BETWEEN 2106000 AND 2106999;
		DELETE FROM "TagsOnImageDetails" WHERE "imageId" BETWEEN 2106000 AND 2106999;
		DELETE FROM "CollectionContributor" WHERE "collectionId" BETWEEN 2106000 AND 2106999;
		INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt", "collectionId") VALUES
		  (2106501, 2106901, 2106601, '2021-01-01 00:00:00', NULL),
		  (2106502, 2106901, 2106601, '2021-02-01 00:00:00', NULL),
		  (2106503, 2106901, 2106602, '2021-01-15 00:00:00', NULL),
		  (2106504, 2106902, 2106601, '2021-01-20 00:00:00', NULL),
		  (2106505, 2106901, 2106601, NULL, NULL),
		  (2106506, 2106901, 2106601, '2999-01-01 00:00:00', NULL),
		  (2106507, 2106901, 2106601, '2021-03-01 00:00:00', 2106701);
		INSERT INTO "Image" (id, url, "userId", "postId", index, "nsfwLevel", ingestion, "needsReview", "acceptableMinor") VALUES
		  (2106010, 'p-u10', 2106901, 2106502, 0, 1, 'Scanned', NULL, false),
		  (2106011, 'p-u11', 2106901, 2106501, 2, 1, 'Scanned', NULL, false),
		  (2106012, 'p-u12', 2106901, 2106501, 1, 1, 'Scanned', NULL, false),
		  (2106013, 'p-u13', 2106901, 2106501, NULL, 1, 'Scanned', NULL, false),
		  (2106014, 'p-u14', 2106901, 2106503, 0, 1, 'Scanned', NULL, false),
		  (2106015, 'p-u15', 2106902, 2106504, 0, 1, 'Scanned', NULL, false),
		  (2106016, 'p-u16', 2106901, 2106505, 0, 1, 'Scanned', NULL, false),
		  (2106017, 'p-u17', 2106901, 2106506, 0, 1, 'Scanned', NULL, false),
		  (2106019, 'p-u19', 2106901, 2106502, 1, 0, 'Pending', NULL, false),
		  (2106020, 'p-u20', 2106901, 2106507, 0, 4, 'Scanned', NULL, false),
		  (2106021, 'p-u21', 2106901, 2106502, 3, 1, 'Scanned', 'minor', false),
		  (2106022, 'p-u22', 2106901, 2106501, 150, 1, 'Scanned', NULL, false),
		  (2106023, 'p-u23', 2106901, 2106502, 0, 1, 'Scanned', NULL, false),
		  (2106024, 'p-u24', 2106901, 2106502, 4, 1, 'Scanned', NULL, true),
		  (2106025, 'p-u25', 2106902, 2106504, 1, 1, 'Scanned', NULL, true),
		  (2106026, 'p-u26', 2106901, 2106507, 1, 0, 'Scanned', NULL, false),
		  (2106027, 'p-u27', 2106901, 2106507, 2, 32, 'Scanned', NULL, false),
		  (2106028, 'p-u28', 2106901, 2106502, 5, 1, 'Scanned', 'csam', false),
		  (2106029, 'p-u29', 2106901, 2106502, 6, 1, 'Scanned', 'poi', false),
		  (2106030, 'p-u30', 2106902, 2106504, 2, 1, 'Scanned', 'poi', false),
		  (2106031, 'p-u31', 2106902, 2106504, 3, 1, 'Scanned', 'csam', false);
		INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId") VALUES (2106014, 2106601);
		INSERT INTO "CollectionContributor" ("userId", "collectionId", permissions) VALUES
		  (2106903, 2106701, ARRAY['MANAGE']::"CollectionContributorPermission"[]),
		  (2106904, 2106701, ARRAY['VIEW']::"CollectionContributorPermission"[]);`)
}

func TestIntegrationPrioritizedPage(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedPrioritized(t, pool)
	const owner, other, version, model = 2106901, 2106902, 2106601, 2106651
	carousel := func() ImagesQuery {
		return ImagesQuery{Limit: 20, Sort: SortMostReactions, Period: "AllTime", BrowsingLevel: 1,
			ModelVersionID: version, PrioritizedUserIDs: []int{owner}}
	}
	cases := []struct {
		name string
		edit func(*ImagesQuery)
		want []int
	}{
		// Published, on the version (by the post, not ImageResourceNew), the owner's, reviewed, level 1:
		// oldest post first by postId*100 + index; 2106022's index 150 carries it past 2106502's index 0,
		// and 2106010 / 2106023 tie on the key and go by id.
		{"signed out", func(q *ImagesQuery) {}, []int{2106013, 2106012, 2106011, 2106010, 2106023, 2106022}},
		// The sort does not change the order.
		{"Oldest", func(q *ImagesQuery) { q.Sort = SortOldest }, []int{2106013, 2106012, 2106011, 2106010, 2106023, 2106022}},
		// Several creators: the other creator's post on the version joins in its key's place.
		{"two creators", func(q *ImagesQuery) { q.PrioritizedUserIDs = []int{owner, other} },
			[]int{2106013, 2106012, 2106011, 2106010, 2106023, 2106022, 2106015}},
		// A model alone has no model scope: the owner's post on the other version (2106503) joins too.
		{"a model alone", func(q *ImagesQuery) { q.ModelVersionID, q.ModelID = 0, model },
			[]int{2106013, 2106012, 2106011, 2106010, 2106023, 2106022, 2106014}},
		// Pending, signed out: no publish clause (the draft and the scheduled post's rows come back; the
		// transform drops them for anyone but the owner), visibility still the reviewed one.
		{"pending, signed out", func(q *ImagesQuery) { q.Pending = true },
			[]int{2106013, 2106012, 2106011, 2106010, 2106023, 2106022, 2106016, 2106017}},
		// Pending, the owner: their unrated (2106019, and 2106026 though in a collection post),
		// acceptableMinor (2106024) and needsReview 'poi' (2106029) images too; never their 'minor'
		// (2106021) or 'csam' (2106028) one, nor the Blocked level (2106027).
		{"pending, the owner", func(q *ImagesQuery) { q.Pending = true; q.ViewerID = owner },
			[]int{2106013, 2106012, 2106011, 2106010, 2106023, 2106019, 2106024, 2106029, 2106022, 2106016, 2106017, 2106026}},
		// The owner beside another creator: the owner's acceptableMinor image (2106024) shows, the other
		// creator's (2106025) does not, nor any needsReview image of theirs (2106030, 2106031); the other
		// creator's ordinary image (2106015) does.
		{"pending, the owner, two creators", func(q *ImagesQuery) {
			q.Pending = true
			q.ViewerID = owner
			q.PrioritizedUserIDs = []int{owner, other}
		}, []int{2106013, 2106012, 2106011, 2106010, 2106023, 2106019, 2106024, 2106029, 2106022, 2106015, 2106016, 2106017, 2106026}},
		// The other creator viewing both: their own acceptableMinor (2106025) and 'poi' (2106030) images,
		// not their 'csam' one (2106031), and none of the owner's needsReview, acceptableMinor or
		// unrated images.
		{"pending, the other creator, two creators", func(q *ImagesQuery) {
			q.Pending = true
			q.ViewerID = other
			q.PrioritizedUserIDs = []int{owner, other}
		}, []int{2106013, 2106012, 2106011, 2106010, 2106023, 2106022, 2106015, 2106025, 2106030, 2106016, 2106017}},
		// Pending, a viewer who MANAGEs the collection: the rated image of its post above their level,
		// never its unrated (2106026) or Blocked-level (2106027) one, nor another creator's
		// acceptableMinor image (2106024).
		{"pending, a collection manager", func(q *ImagesQuery) { q.Pending = true; q.ViewerID = 2106903 },
			[]int{2106013, 2106012, 2106011, 2106010, 2106023, 2106022, 2106016, 2106017, 2106020}},
		// Control: VIEW on the collection is not MANAGE.
		{"pending, a collection viewer", func(q *ImagesQuery) { q.Pending = true; q.ViewerID = 2106904 },
			[]int{2106013, 2106012, 2106011, 2106010, 2106023, 2106022, 2106016, 2106017}},
		// Pending, a moderator: unrated, needsReview and acceptableMinor images, nothing above the level.
		{"pending, a moderator", func(q *ImagesQuery) { q.Pending = true; q.ViewerID = 2106999; q.IsModerator = true },
			[]int{2106013, 2106012, 2106011, 2106010, 2106023, 2106019, 2106021, 2106024, 2106028, 2106029, 2106022, 2106016, 2106017, 2106026}},
	}
	for _, c := range cases {
		q := carousel()
		c.edit(&q)
		if got := integIDs(integRun(t, pool, q)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: ids %v, want %v", c.name, got, c.want)
		}
	}

	// The look-ahead row: limit 4 returns 5 rows, the fifth carrying its id as the cursor.
	q := carousel()
	q.Limit = 4
	rows := integRun(t, pool, q)
	if got := integIDs(rows); !reflect.DeepEqual(got, []int{2106013, 2106012, 2106011, 2106010, 2106023}) {
		t.Fatalf("limit 4: ids %v", got)
	}
	if look := rows[4]; look.CursorNull || look.CursorID != 2106023 {
		t.Fatalf("look-ahead cursor = %d (null %v), want 2106023", look.CursorID, look.CursorNull)
	}

	// Control: the same version gallery without prioritizedUserIds reads ImageResourceNew, where only
	// 2106014 is attributed to the version.
	plain := ImagesQuery{Limit: 20, Sort: SortMostReactions, Period: "AllTime", BrowsingLevel: 1, ModelVersionID: version}
	if got := integIDs(integRun(t, pool, plain)); !reflect.DeepEqual(got, []int{2106014}) {
		t.Fatalf("version gallery without prioritizedUserIds: ids %v, want [2106014]", got)
	}
}
