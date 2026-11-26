package feed

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The port reads a collection's Random sort only with its switch on, and only beside a collectionId:
// off, or without one, it is the `input-sort` fallback it was before the port.
func TestParseInfiniteRandomSort(t *testing.T) {
	on := InfinitePorts{SortRandom: true}
	withCollection := map[string]any{"collectionId": num("9101"), "sort": "Random"}
	if _, err := ParseInfinite(withCollection); fallback.Reason(err) != "input-sort" {
		t.Fatalf("port off: %v, want input-sort", err)
	}
	if _, err := ParseInfiniteWith(withCollection, InfinitePorts{}); fallback.Reason(err) != "input-sort" {
		t.Fatalf("port off (ParseInfiniteWith): %v, want input-sort", err)
	}
	in, err := ParseInfiniteWith(withCollection, on)
	if err != nil || in.Sort != SortRandom || in.CollectionID != 9101 {
		t.Fatalf("port on: %+v, %v; want sort Random on 9101", in, err)
	}
	for _, m := range []map[string]any{
		{"sort": "Random"},
		{"sort": "Random", "collectionId": nil},
		{"sort": "Random", "modelVersionId": num("6001")},
	} {
		if _, err := ParseInfiniteWith(m, on); fallback.Reason(err) != "input-sort" {
			t.Errorf("port on, %v: %v, want input-sort (Node's BAD_REQUEST without a collection)", m, err)
		}
	}
	// Recently Added is unaffected by the port.
	if in, err := ParseInfiniteWith(map[string]any{"collectionId": num("9101"), "sort": "Recently Added"}, InfinitePorts{}); err != nil || in.Sort != SortRecentlyAdded {
		t.Fatalf("Recently Added: %+v, %v", in, err)
	}
}

// A collection's Random sort beside a `postId` is handed back (`collection-random-post-id`): Node
// orders it by the seeded sort key and builds a `seed:sortKey:id` cursor, where the post scope here
// would order by the index (a page 2 from the wrong cursor comes back almost empty). Without a
// `postId` (postIds included) Random is still read, and Recently Added beside a `postId` is unchanged.
func TestParseInfiniteRandomSortPostID(t *testing.T) {
	on := InfinitePorts{SortRandom: true, PostIDs: true}
	for _, input := range []string{
		`{"collectionId":9101,"sort":"Random","postId":7101}`,
		`{"collectionId":9101,"sort":"Random","postId":7101,"modelId":5001}`,
		`{"collectionId":9101,"sort":"Random","postId":7101,"cursor":"494868:337483310:8007"}`,
	} {
		if in, err := ParseInfiniteWith(parseObj(t, input), on); fallback.Reason(err) != "collection-random-post-id" {
			t.Errorf("%s: %+v, %v (reason %q), want collection-random-post-id", input, in, err, fallback.Reason(err))
		}
	}
	// The switch off, the same request is still the old `input-sort` fallback.
	if _, err := ParseInfiniteWith(parseObj(t, `{"collectionId":9101,"sort":"Random","postId":7101}`), InfinitePorts{}); fallback.Reason(err) != "input-sort" {
		t.Errorf("port off: %v, want input-sort", err)
	}
	if in, err := ParseInfiniteWith(parseObj(t, `{"collectionId":9101,"sort":"Random","postIds":[7101]}`), on); err != nil || in.Sort != SortRandom {
		t.Errorf("Random with postIds and no postId: %+v, %v; want sort Random", in, err)
	}
	if in, err := ParseInfiniteWith(parseObj(t, `{"collectionId":9101,"sort":"Recently Added","postId":7101}`), on); err != nil || in.Sort != SortRecentlyAdded || in.PostID != 7101 {
		t.Errorf("Recently Added beside a postId: %+v, %v", in, err)
	}
}

// getAllImages' Random cursor: three parts of String(cursor), each digits; anything that is not
// three parts is no cursor at all (the first page); a part Node would inline as NaN, a sign or a
// fraction falls back.
func TestParseRandomCursor(t *testing.T) {
	for _, c := range []struct {
		in     Input
		want   *RandomCursor
		reason string
	}{
		{in: Input{}},
		{in: Input{Cursor: 95002}},
		{in: Input{Cursor: 95002, CursorText: "95002"}},
		{in: Input{CursorText: "feed:1"}},
		{in: Input{CursorText: "1:2:3:4"}},
		{in: Input{CursorText: "494868:337483310:8007"}, want: &RandomCursor{Seed: 494868, SortKey: 337483310, ID: 8007}},
		{in: Input{CursorText: "0:400000000:9999"}, want: &RandomCursor{Seed: 0, SortKey: 400000000, ID: 9999}},
		{in: Input{CursorText: "007:08:09"}, want: &RandomCursor{Seed: 7, SortKey: 8, ID: 9}},
		{in: Input{CursorText: "494868:x:8007"}, reason: "collection-random-cursor"},
		{in: Input{CursorText: "494868:-1:8007"}, reason: "collection-random-cursor"},
		{in: Input{CursorText: "494868:1.5:8007"}, reason: "collection-random-cursor"},
		{in: Input{CursorText: "494868: 1:8007"}, reason: "collection-random-cursor"},
		{in: Input{CursorText: "::"}, reason: "collection-random-cursor"},
		{in: Input{CursorText: "feed:1:2"}, reason: "collection-random-cursor"},
		{in: Input{CursorText: "1:1234567890123456:2"}, reason: "collection-random-cursor"},
	} {
		got, err := parseRandomCursor(&c.in)
		if fallback.Reason(err) != c.reason || !reflect.DeepEqual(got, c.want) {
			t.Errorf("parseRandomCursor(%+v) = %+v, %v; want %+v, %q", c.in, got, err, c.want, c.reason)
		}
	}
}

// The stored seed: digits are the seed; a missing key, an empty one, 0 or anything else, and a failed
// read are each their own fallback (this service never writes the key Node writes on a miss).
func TestRandomSeed(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct {
		stored *string
		want   int64
		reason string
	}{
		{stored: randomSeedText("494868"), want: 494868},
		{stored: randomSeedText("0494868"), want: 494868},
		{reason: "collection-random-seed-miss"},
		{stored: randomSeedText(""), reason: "collection-random-seed-miss"},
		{stored: randomSeedText("0"), reason: "collection-random-seed-stale"},
		{stored: randomSeedText("4948.5"), reason: "collection-random-seed-stale"},
		{stored: randomSeedText("-4"), reason: "collection-random-seed-stale"},
		{stored: randomSeedText("NaN"), reason: "collection-random-seed-stale"},
	} {
		sys := testkit.NewRedis()
		if c.stored != nil {
			sys.SetString(RandomSeedKey, []byte(*c.stored))
		}
		got, err := (&RandomSeed{Sys: sys}).Seed(ctx)
		if fallback.Reason(err) != c.reason || got != c.want {
			t.Errorf("stored %v: Seed = %d, %v; want %d, %q", c.stored, got, err, c.want, c.reason)
		}
	}
	sys := testkit.NewRedis()
	sys.SetString(RandomSeedKey, []byte("494868"))
	sys.Err = errors.New("down")
	if _, err := (&RandomSeed{Sys: sys}).Seed(ctx); fallback.Reason(err) != "collection-random-seed-read-failed" {
		t.Errorf("a failed read: %v, want collection-random-seed-read-failed", err)
	}
	var none *RandomSeed
	if _, err := none.Seed(ctx); fallback.Reason(err) != "collection-random-seed-unconfigured" {
		t.Errorf("no source: %v, want collection-random-seed-unconfigured", err)
	}
}

func randomSeedText(s string) *string { return &s }

// The Random collection page's SQL, written by hand from getAllImagesUncaptured: the seed hashed into
// each item's sort key (bound as text, first), the cursor clause inside the CTE (strict, on the sort
// key then the image id), the CTE's own order, `ct."sortKey" DESC, i."id" DESC` as the page order with
// the sort key as the cursor column, no getCursor clause, and never cached.
func TestBuildCollectionRandom(t *testing.T) {
	first := (&ImagesQuery{Limit: 5, Sort: SortRandom, BrowsingLevel: 1, CollectionID: 9101, RandomSeed: 494868}).Build()
	for _, want := range []string{
		`abs(mod(hashtext(concat(ci.id::text, $1::text)), 1000000000)) as "sortKey"
            FROM "CollectionItem" ci
            WHERE ci."collectionId" = $2
              AND ci."imageId" IS NOT NULL
              AND (ci."status" = 'ACCEPTED')
          ) sub
          ORDER BY "sortKey" DESC
        )`,
		`ct."sortKey" "cursorId", ct.note as "collectionItemNote"`,
		`ORDER BY ct."sortKey" DESC, i."id" DESC
    LIMIT $`,
	} {
		if !strings.Contains(first.SQL, want) {
			t.Errorf("first page: SQL lacks\n%s\nin\n%s", want, first.SQL)
		}
	}
	if first.Args[0] != "494868" || first.Args[1] != 9101 || first.CacheTTL != 0 || first.CacheTags != nil || !first.Collection {
		t.Errorf("first page: args %v, ttl %v, tags %v, collection %v; want the seed text then 9101, uncached", first.Args[:2], first.CacheTTL, first.CacheTags, first.Collection)
	}
	if strings.Contains(first.SQL, `"sortKey" <`) || strings.Contains(first.SQL, `((ct."sortKey"`) || strings.Contains(first.SQL, `((i."id"`) {
		t.Errorf("first page: a cursor clause:\n%s", first.SQL)
	}

	next := (&ImagesQuery{Limit: 5, Sort: SortRandom, BrowsingLevel: 31, CollectionID: 9101, ViewerID: 1003, RandomSeed: 494867,
		RandomCursor: &RandomCursor{Seed: 494867, SortKey: 588720858, ID: 8003}}).Build()
	want := `AND (ci."status" = 'ACCEPTED' OR (ci."status" <> 'REJECTED' AND ci."addedById" = $3))
          ) sub
          WHERE (
                  "sortKey" < $4
                  OR (
                    "sortKey" = $4
                    AND "imageId" < $5
                  )
                )
          ORDER BY "sortKey" DESC
        )`
	if !strings.Contains(next.SQL, want) {
		t.Errorf("next page: SQL lacks\n%s\nin\n%s", want, next.SQL)
	}
	if !reflect.DeepEqual(next.Args[:5], []any{"494867", 9101, 1003, int64(588720858), int64(8003)}) {
		t.Errorf("next page: args %v, want the seed, the collection, the viewer, the sort key and the id", next.Args[:5])
	}

	// Recently Added on a collection keeps its own hash input ('') and order (the port changes no other
	// collection page).
	other := (&ImagesQuery{Limit: 5, Sort: SortRecentlyAdded, BrowsingLevel: 1, CollectionID: 9101, RandomSeed: 494868}).Build()
	if !strings.Contains(other.SQL, `hashtext(concat(ci.id::text, ''))`) || strings.Contains(other.SQL, `ORDER BY "sortKey" DESC`) ||
		!strings.Contains(other.SQL, `ORDER BY ct."collectionItemId" DESC`) || other.Args[0] != 9101 {
		t.Errorf("Recently Added: the Random parts leaked in:\n%s", other.SQL)
	}
}
