//go:build integration

package feed

import (
	"reflect"
	"sort"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/integtest"
)

// goldenRandomSortKeys are the Random sort keys the golden mirror holds for its collection items
// (COLLECTION_SORT_KEYS in testdata/golden/gen.mjs), computed once with a Postgres 16. Neither side
// reimplements hashtext, so this is what ties those literals to Postgres: change one, change both.
var goldenRandomSortKeys = map[string]map[int]int{
	"494867": {95001: 995023918, 95002: 296414999, 95003: 281741135, 95004: 588720858, 95005: 431780544, 95006: 522077658, 95101: 502631944, 95102: 717036926, 95103: 749353720, 95201: 325348675, 95202: 959163105},
	"494868": {95001: 8992366, 95002: 337483310, 95003: 309553120, 95004: 409789263, 95005: 878391610, 95006: 697502928, 95101: 372575269, 95102: 332677071, 95103: 364410394, 95201: 163855030, 95202: 213911762},
}

// TestIntegrationCollectionRandomSortKeys: the CI Postgres computes the golden fixtures' sort keys
// (the CTE's own expression, the seed as text) exactly as the mirror records them.
func TestIntegrationCollectionRandomSortKeys(t *testing.T) {
	pool := integtest.Postgres(t)
	ctx := integtest.Ctx(t)
	n := 0
	for seed, keys := range goldenRandomSortKeys {
		for id, want := range keys {
			var got int
			if err := pool.QueryRow(ctx, `SELECT abs(mod(hashtext(concat($1::int::text, $2::text)), 1000000000))`, id, seed).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Errorf("item %d, seed %s: Postgres sort key %d, the golden table holds %d", id, seed, got, want)
			}
			n++
		}
	}
	if n != 22 {
		t.Fatalf("checked %d keys, want 22", n)
	}
}

// A collection's Random page against the real schema: the items ordered by their seeded sort key
// (read back from Postgres with the expression alone), the sort key as the cursor column, and the
// next page strictly below the look-ahead row (which is therefore on neither page, as in Node). A
// different seed reorders the same items.
func TestIntegrationCollectionRandomPage(t *testing.T) {
	pool := integtest.Postgres(t)
	integSeedImages(t, pool)
	ctx := integtest.Ctx(t)
	integtest.Exec(t, pool, `
		DELETE FROM "CollectionItem" WHERE id BETWEEN 2101700 AND 2101799;
		INSERT INTO "CollectionItem" (id, "collectionId", "imageId", status) VALUES
		  (2101711, 2101790, 2101002, 'ACCEPTED'),
		  (2101712, 2101790, 2101003, 'ACCEPTED'),
		  (2101713, 2101790, 2101005, 'ACCEPTED'),
		  (2101714, 2101790, 2101008, 'ACCEPTED'),
		  (2101715, 2101790, 2101009, 'REJECTED');`)
	items := map[int]int{2101711: 2101002, 2101712: 2101003, 2101713: 2101005, 2101714: 2101008}
	order := func(seed string) (ids []int, keys map[int]int) {
		keys = map[int]int{}
		for item, img := range items {
			var k int
			if err := pool.QueryRow(ctx, `SELECT abs(mod(hashtext(concat($1::int::text, $2::text)), 1000000000))`, item, seed).Scan(&k); err != nil {
				t.Fatal(err)
			}
			keys[img] = k
			ids = append(ids, img)
		}
		sort.Slice(ids, func(a, b int) bool { return keys[ids[a]] > keys[ids[b]] })
		return ids, keys
	}
	q := ImagesQuery{Limit: 2, IsModerator: true, BrowsingLevel: browsing.AllLevels, Sort: SortRandom, CollectionID: 2101790, RandomSeed: 777}
	want, keys := order("777")
	rows := integRun(t, pool, q)
	if got := integIDs(rows); !reflect.DeepEqual(got, want[:3]) {
		t.Fatalf("first page (limit 2 + look-ahead) = %v, want %v (keys %v)", got, want[:3], keys)
	}
	for _, r := range rows {
		if r.CursorNull || r.CursorID != keys[r.ID] {
			t.Fatalf("row %d: cursor column %d (null %v), want its sort key %d", r.ID, r.CursorID, r.CursorNull, keys[r.ID])
		}
	}
	look := rows[2]
	q.RandomCursor = &RandomCursor{Seed: 777, SortKey: int64(look.CursorID), ID: int64(look.ID)}
	if got := integIDs(integRun(t, pool, q)); !reflect.DeepEqual(got, want[3:]) {
		t.Fatalf("next page from the look-ahead row = %v, want %v (strictly below it)", got, want[3:])
	}

	other, _ := order("778")
	q.RandomSeed, q.RandomCursor, q.Limit = 778, nil, 10
	if got := integIDs(integRun(t, pool, q)); !reflect.DeepEqual(got, other) {
		t.Fatalf("seed 778 = %v, want %v", got, other)
	}
	if reflect.DeepEqual(want, other) {
		t.Fatalf("seeds 777 and 778 order the items alike (%v): pick seeds that tell them apart", want)
	}
}
