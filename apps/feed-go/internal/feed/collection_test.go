package feed

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// withItem is r as a collection page returns it: joined to an item with this status, adder and note.
func withItem(r RawImage, status string, addedBy *int, note *string) RawImage {
	r.Collection = &CollectionItem{Status: status, AddedByID: addedBy, Note: note}
	return r
}

// `collectionId` parses on image.getInfinite (a positive int4), with `collectionTagId` beside it and
// the Recently Added sort only beside it. Regression: before the port every collectionId fell back
// with input-collectionId.
func TestParseInfiniteCollection(t *testing.T) {
	in, err := ParseInfinite(parseObj(t, `{"collectionId":9101,"collectionTagId":31,"sort":"Recently Added","limit":3}`))
	if err != nil {
		t.Fatalf("collectionId: reason %q (err %v), want it parsed", fallback.Reason(err), err)
	}
	if in.CollectionID != 9101 || in.CollectionTagID != 31 || in.Sort != SortRecentlyAdded || in.Limit != 3 {
		t.Fatalf("parsed %+v, want collection 9101, tag 31, Recently Added, limit 3", *in)
	}
	if !in.dbPath() {
		t.Fatal("a collection is not the Postgres path (requiresImageDbPath)")
	}
	// collectionTagId 0 is falsy in Node: no tag filter, and no BAD_REQUEST without a collection.
	for _, input := range []string{`{"collectionId":5,"collectionTagId":0}`, `{"collectionTagId":0}`, `{"collectionId":null}`} {
		in, err := ParseInfinite(parseObj(t, input))
		if err != nil || in.CollectionTagID != 0 {
			t.Errorf("ParseInfinite %s: err %v, tag %v; want parsed without a tag", input, err, in != nil && in.CollectionTagID != 0)
		}
	}
	for input, want := range map[string][2]string{
		`{"collectionId":"5"}`:                             {"input-invalid", "collectionId"},
		`{"collectionId":5,"collectionTagId":"x"}`:         {"input-invalid", "collectionTagId"},
		`{"collectionId":0}`:                               {"collection-id", ""},
		`{"collectionId":-3}`:                              {"collection-id", ""},
		`{"collectionId":1.5}`:                             {"collection-id", ""},
		`{"collectionId":2147483648}`:                      {"collection-id", ""},
		`{"collectionId":5,"collectionTagId":2.5}`:         {"collection-tag-id", ""},
		`{"collectionTagId":31}`:                           {"input-collectionTagId", ""},
		`{"sort":"Recently Added"}`:                        {"input-sort", "Recently?Added"},
		`{"collectionId":5,"sort":"Random"}`:               {"input-sort", "Random"},
		`{"collectionId":5,"hubId":3}`:                     {"input-hubId", ""},
		`{"collectionId":5,"pendingReviewOnly":true}`:      {"input-pendingReviewOnly", ""},
		`{"collectionId":5,"sort":"Recently Added","x":1}`: {"input-unknown-key", "x"},
	} {
		_, err := ParseInfinite(parseObj(t, input))
		if fallback.Reason(err) != want[0] || (want[1] != "" && fallback.SafeDetail(err) != want[1]) {
			t.Errorf("ParseInfinite %s: reason %q detail %q, want %q / %q", input, fallback.Reason(err), fallback.SafeDetail(err), want[0], want[1])
		}
	}
	// The gallery is not widened.
	if _, err := Parse(parseObj(t, `{"collectionId":5}`)); fallback.Reason(err) != "input-collectionId" {
		t.Errorf("Parse collectionId: reason %q (err %v), want input-collectionId", fallback.Reason(err), err)
	}
}

// The read decision, one case per getUserCollectionPermissionsByIds branch: Public and Unlisted read
// for anyone; a missing collection, and a private one for a signed-out viewer, a contributor without
// VIEW or anyone else, read for no one; the owner reads; a moderator, or a contributor with VIEW, on a
// collection that is not theirs falls back.
func TestCollectionReadable(t *testing.T) {
	private := func(contrib ...string) *hydrate.CollectionPermission {
		return &hydrate.CollectionPermission{Read: "Private", OwnerID: 7, Contributor: contrib}
	}
	for _, c := range []struct {
		name   string
		p      *hydrate.CollectionPermission
		viewer Viewer
		read   bool
		reason string
	}{
		{"missing", nil, Viewer{ID: 9}, false, ""},
		{"public signed out", &hydrate.CollectionPermission{Read: "Public", OwnerID: 7}, Viewer{}, true, ""},
		{"unlisted signed out", &hydrate.CollectionPermission{Read: "Unlisted", OwnerID: 7}, Viewer{}, true, ""},
		{"public to a moderator", &hydrate.CollectionPermission{Read: "Public", OwnerID: 7}, Viewer{ID: 9, IsModerator: true}, true, ""},
		{"private signed out", private(), Viewer{}, false, ""},
		{"private to its owner", private(), Viewer{ID: 7}, true, ""},
		{"private to its owner, a moderator", private(), Viewer{ID: 7, IsModerator: true}, true, ""},
		{"private to another viewer", private(), Viewer{ID: 9}, false, ""},
		{"private to a contributor without VIEW", private("ADD", "ADD_REVIEW", "MANAGE"), Viewer{ID: 9}, false, ""},
		{"private to a contributor with VIEW", private("ADD", "VIEW"), Viewer{ID: 9}, false, "collection-contributor"},
		{"private to a moderator", private(), Viewer{ID: 9, IsModerator: true}, false, "collection-moderator"},
		{"an unknown read setting to another viewer", &hydrate.CollectionPermission{Read: "Hidden", OwnerID: 7}, Viewer{ID: 9}, false, ""},
	} {
		read, err := collectionReadable(c.p, c.viewer)
		if read != c.read || fallback.Reason(err) != c.reason || (c.reason == "" && err != nil) {
			t.Errorf("%s: read %v err %v (reason %q), want read %v reason %q", c.name, read, err, fallback.Reason(err), c.read, c.reason)
		}
	}
}

// parseJudgeScore is null for no note, a note JSON.parse rejects, a JSON value that is not an object,
// and an object without a score or with a null one; any other score is not null.
func TestJudgeScoreNull(t *testing.T) {
	str := func(s string) *string { return &s }
	for _, c := range []struct {
		note *string
		null bool
	}{
		{nil, true},
		{str(""), true},
		{str("not json"), true},
		{str(`{"score":`), true},
		{str(`{"score":1} trailing`), true},
		{str(`[{"score":1}]`), true},
		{str(`"score"`), true},
		{str(`7`), true},
		{str(`null`), true},
		{str(`{}`), true},
		{str(`{"comment":"no score"}`), true},
		{str(` {"score": null }`), true},
		{str(`{"score":1,"score":null}`), true},
		{str(`{"score":{"theme":7}}`), false},
		{str(`{"score":0}`), false},
		{str(`{"score":false}`), false},
		{str(`{"score":"7"}`), false},
		{str(`{"score":null,"score":[1]}`), false},
	} {
		if got := judgeScoreNull(c.note); got != c.null {
			note := "<nil>"
			if c.note != nil {
				note = *c.note
			}
			t.Errorf("judgeScoreNull(%s) = %v, want %v", note, got, c.null)
		}
	}
}

// The collection page's SQL: the `ct` CTE (the collection, its tag, the status filter for the
// viewer), the join after the Post join, the three item columns after "cursorId", the
// acceptableMinor rule of a collection, and the Recently Added order and cursor. Expected fragments
// are written by hand from getAllImagesUncaptured.
func TestBuildCollection(t *testing.T) {
	signedOut := (&ImagesQuery{Limit: 5, Sort: SortNewest, BrowsingLevel: 1, CollectionID: 9101}).Build()
	for _, want := range []string{
		`WITH
        ct AS (
          SELECT "imageId", note, status, "addedById", "collectionItemId", "sortKey"`,
		`abs(mod(hashtext(concat(ci.id::text, '')), 1000000000)) as "sortKey"
            FROM "CollectionItem" ci
            WHERE ci."collectionId" = $1
              AND ci."imageId" IS NOT NULL
              AND (ci."status" = 'ACCEPTED')
          ) sub
        )`,
		`i."id" "cursorId", ct.note as "collectionItemNote", ct.status as "collectionItemStatus", ct."addedById" as "collectionItemAddedById"
    FROM "Image" i`,
		`JOIN "Post" p ON p.id = i."postId"
    JOIN ct ON ct."imageId" = i.id
    WHERE`,
		` AND i."needsReview" IS NULL AND i."acceptableMinor" = FALSE AND `,
		`ORDER BY i."id" DESC`,
	} {
		if !strings.Contains(signedOut.SQL, want) {
			t.Errorf("signed out: SQL lacks\n%s\nin\n%s", want, signedOut.SQL)
		}
	}
	if signedOut.Args[0] != 9101 || !signedOut.Collection || signedOut.CacheTTL != 0 {
		t.Errorf("signed out: first arg %v, collection %v, ttl %v; want 9101, true, 0", signedOut.Args[0], signedOut.Collection, signedOut.CacheTTL)
	}

	viewer := (&ImagesQuery{Limit: 5, Sort: SortRecentlyAdded, Cursor: 95002, BrowsingLevel: 1, CollectionID: 9101, CollectionTagID: 31, ViewerID: 1003}).Build()
	for _, want := range []string{
		`WHERE ci."collectionId" = $1
              AND ci."tagId" = $2
              AND ci."imageId" IS NOT NULL
              AND (ci."status" = 'ACCEPTED' OR (ci."status" <> 'REJECTED' AND ci."addedById" = $3))`,
		`ct."collectionItemId" "cursorId", ct.note`,
		`((ct."collectionItemId" <= $`,
		`ORDER BY ct."collectionItemId" DESC`,
	} {
		if !strings.Contains(viewer.SQL, want) {
			t.Errorf("signed in: SQL lacks\n%s\nin\n%s", want, viewer.SQL)
		}
	}
	if !reflect.DeepEqual(viewer.Args[:3], []any{9101, 31, 1003}) || viewer.Args[len(viewer.Args)-1] != 6 {
		t.Errorf("signed in: args %v, want the collection, the tag and the viewer first and the limit+1 (6) last", viewer.Args)
	}
	cursorBound := false
	for _, a := range viewer.Args {
		cursorBound = cursorBound || a == 95002
	}
	if !cursorBound {
		t.Errorf("signed in: the item cursor 95002 is not bound: %v", viewer.Args)
	}
	// The viewer's own acceptableMinor images stay in a collection.
	if !strings.Contains(viewer.SQL, `(i."acceptableMinor" = FALSE OR i."userId" = $`) || strings.Contains(viewer.SQL, ` AND i."acceptableMinor" = FALSE AND `) {
		t.Errorf("signed in: the owner's acceptableMinor exemption is missing:\n%s", viewer.SQL)
	}

	// A moderator's collection view has no acceptableMinor clause at all.
	mod := (&ImagesQuery{Limit: 5, BrowsingLevel: 1, CollectionID: 9101, ViewerID: 4, IsModerator: true}).Build()
	if strings.Contains(mod.SQL, `"acceptableMinor" = FALSE`) {
		t.Errorf("moderator: an acceptableMinor clause in a collection:\n%s", mod.SQL)
	}
	// Positive control: outside a collection the same viewers keep the plain clause, and nothing of
	// the collection is in the SQL.
	for _, q := range []ImagesQuery{{Limit: 5, BrowsingLevel: 1, ViewerID: 1003}, {Limit: 5, BrowsingLevel: 1, ViewerID: 4, IsModerator: true}} {
		b := q.Build()
		if !strings.Contains(b.SQL, ` AND i."acceptableMinor" = FALSE AND `) || strings.Contains(b.SQL, `JOIN ct ON`) || strings.Contains(b.SQL, `"CollectionItem"`) || strings.Contains(b.SQL, "WITH") || b.Collection {
			t.Errorf("no collection (viewer %d, moderator %v): SQL\n%s", q.ViewerID, q.IsModerator, b.SQL)
		}
	}
	// Node does not mark a collection personalized: a version gallery in a collection keeps its cache.
	cached := (&ImagesQuery{Limit: 5, BrowsingLevel: 1, ModelVersionID: 60, CollectionID: 9101}).Build()
	if cached.CacheTTL != 10*time.Minute || !reflect.DeepEqual(cached.CacheTags, []string{"images-modelVersion:60"}) {
		t.Errorf("a version gallery in a collection: ttl %v tags %v, want 10m [images-modelVersion:60]", cached.CacheTTL, cached.CacheTags)
	}
}

// A public collection signed out: the Postgres path even with the index feed on (requiresImageDbPath),
// one permission read without a viewer, the ACCEPTED-only CTE, and each item's status and adder on the
// wire with a null judgeScore. Regression: before the port this request fell back
// (input-collectionId).
func TestServeInfiniteCollectionPublic(t *testing.T) {
	f := newInfFixture(t)
	src := f.deps.Sources.(*fakeV1Sources)
	src.collections = map[int]hydrate.CollectionPermission{9101: {Read: "Public", OwnerID: 7}}
	f.rows = []RawImage{
		withItem(infRow(12, 100), "ACCEPTED", intp(7), nil),
		withItem(infRow(11, 100), "ACCEPTED", nil, strp(`{"comment":"no score"}`)),
	}
	j, _, ans, err := serveInf(t, f, map[string]any{"collectionId": num("9101"), "sort": "Newest", "limit": num("5")}, InfiniteRequest{Cap: 1})
	if err != nil {
		t.Fatalf("serve: %v (reason %q)", err, fallback.Reason(err))
	}
	if len(f.feed.queries) != 0 || j["source"] != "db" || ans.Trivial {
		t.Fatalf("feed queries %v, source %v, trivial %v; want the Postgres page", f.feed.queries, j["source"], ans.Trivial)
	}
	if !reflect.DeepEqual(src.collectionsAsked, [][2]int{{9101, 0}}) {
		t.Fatalf("permission reads %v, want one for 9101 signed out", src.collectionsAsked)
	}
	if len(f.sql) != 1 || !strings.Contains(f.sql[0], `AND (ci."status" = 'ACCEPTED')`) || f.sqlArgs[0][0] != 9101 {
		t.Fatalf("page query without the collection CTE over 9101:\n%v\nargs %v", f.sql, f.sqlArgs)
	}
	items, _ := j["items"].([]any)
	if got := itemIDs(j); !reflect.DeepEqual(got, []float64{12, 11}) {
		t.Fatalf("items %v, want [12 11]", got)
	}
	for i, want := range []map[string]any{
		{"collectionItemStatus": "ACCEPTED", "collectionItemAddedById": float64(7), "judgeScore": nil},
		{"collectionItemStatus": "ACCEPTED", "collectionItemAddedById": nil, "judgeScore": nil},
	} {
		it := items[i].(map[string]any)
		for k, v := range want {
			got, present := it[k]
			if !present || got != v {
				t.Errorf("item %d: %s = %v (present %v), want %v", i, k, got, present, v)
			}
		}
		if _, leaked := it["collectionItemNote"]; leaked {
			t.Errorf("item %d carries the note (Node destructures it out)", i)
		}
	}
}

// The private collection's owner is answered (their own items in review too: the viewer-bound status
// filter); a moderator on a public collection is answered too.
func TestServeInfiniteCollectionOwnerAndModerator(t *testing.T) {
	for _, c := range []struct {
		name   string
		read   string
		viewer Viewer
	}{
		{"the owner of a private collection", "Private", Viewer{ID: 7}},
		{"a moderator on a public collection", "Public", Viewer{ID: 9, IsModerator: true}},
	} {
		f := newInfFixture(t)
		src := f.deps.Sources.(*fakeV1Sources)
		src.collections = map[int]hydrate.CollectionPermission{9102: {Read: c.read, OwnerID: 7}}
		f.rows = []RawImage{withItem(infRow(21, 100), "REVIEW", intp(c.viewer.ID), nil)}
		j, _, _, err := serveInf(t, f, map[string]any{"collectionId": num("9102")}, InfiniteRequest{Cap: 1, Viewer: &c.viewer})
		if err != nil {
			t.Fatalf("%s: %v (reason %q)", c.name, err, fallback.Reason(err))
		}
		if got := itemIDs(j); !reflect.DeepEqual(got, []float64{21}) || len(f.sql) != 1 {
			t.Fatalf("%s: items %v, page queries %d", c.name, got, len(f.sql))
		}
		if !strings.Contains(f.sql[0], `ci."status" <> 'REJECTED' AND ci."addedById" = $3`) || f.sqlArgs[0][2] != c.viewer.ID {
			t.Fatalf("%s: the viewer's own items are not kept:\n%s\nargs %v", c.name, f.sql[0], f.sqlArgs[0])
		}
		if !reflect.DeepEqual(src.collectionsAsked, [][2]int{{9102, c.viewer.ID}}) {
			t.Fatalf("%s: permission reads %v", c.name, src.collectionsAsked)
		}
	}
}

// No read is getAllImagesUncaptured's own empty page, stamped by the handler, without a page query:
// a missing collection, a private one signed out, to another viewer, and to a contributor whose row
// holds no VIEW. Privacy: none of these may reach the CollectionItem rows.
func TestServeInfiniteCollectionNoRead(t *testing.T) {
	for _, c := range []struct {
		name   string
		id     string
		viewer *Viewer
	}{
		{"a missing collection", "88", &Viewer{ID: 9}},
		{"a private collection signed out", "9102", nil},
		{"a private collection to another viewer", "9102", &Viewer{ID: 8}},
		{"a private collection to a contributor without VIEW", "9102", &Viewer{ID: 9}},
	} {
		f := newInfFixture(t)
		src := f.deps.Sources.(*fakeV1Sources)
		src.collections = map[int]hydrate.CollectionPermission{9102: {Read: "Private", OwnerID: 7}}
		src.contributors = map[int]map[int][]string{9102: {9: {"ADD", "MANAGE"}}}
		f.rows = []RawImage{withItem(infRow(21, 100), "ACCEPTED", nil, nil)}
		j, ann, ans, err := serveInf(t, f, map[string]any{"collectionId": num(c.id)}, InfiniteRequest{Cap: 1, Viewer: c.viewer})
		if err != nil {
			t.Fatalf("%s: %v (reason %q)", c.name, err, fallback.Reason(err))
		}
		items, _ := j["items"].([]any)
		next, _ := ann["nextCursor"].([]any)
		if items == nil || len(items) != 0 || j["source"] != "db" || len(next) != 1 || next[0] != "undefined" || !ans.Trivial {
			t.Fatalf("%s: answer %v (meta %v, trivial %v), want the empty Postgres page", c.name, j, ann, ans.Trivial)
		}
		if keys := ans.Value; len(keys) != 3 || keys[0].Key != "nextCursor" || keys[1].Key != "items" || keys[2].Key != "source" {
			t.Fatalf("%s: keys %v, want nextCursor, items, source", c.name, ans.Value)
		}
		if len(f.sql) != 0 || len(f.feed.queries) != 0 {
			t.Fatalf("%s: page queries %v, feed queries %v; want none", c.name, f.sql, f.feed.queries)
		}
	}
}

// The permission-sensitive reads that are not answered here fall back before any page query: a
// contributor with VIEW, and a moderator who does not own a private collection. A failed permission
// read is the request's error. A judged item (a score in its note) falls back after the page query.
func TestServeInfiniteCollectionFallsBack(t *testing.T) {
	for _, c := range []struct {
		name   string
		viewer Viewer
		reason string
	}{
		{"a contributor with VIEW", Viewer{ID: 9}, "collection-contributor"},
		{"a moderator", Viewer{ID: 4, IsModerator: true}, "collection-moderator"},
	} {
		f := newInfFixture(t)
		src := f.deps.Sources.(*fakeV1Sources)
		src.collections = map[int]hydrate.CollectionPermission{9102: {Read: "Private", OwnerID: 7}}
		src.contributors = map[int]map[int][]string{9102: {9: {"VIEW"}}}
		f.rows = []RawImage{withItem(infRow(21, 100), "ACCEPTED", nil, nil)}
		_, _, _, err := serveInf(t, f, map[string]any{"collectionId": num("9102")}, InfiniteRequest{Cap: 1, Viewer: &c.viewer})
		if fallback.Reason(err) != c.reason || len(f.sql) != 0 {
			t.Fatalf("%s: reason %q (%v), page queries %d; want %q and none", c.name, fallback.Reason(err), err, len(f.sql), c.reason)
		}
	}

	f := newInfFixture(t)
	readErr := errors.New("replica down")
	f.deps.Sources.(*fakeV1Sources).collectionsErr = readErr
	if _, _, _, err := serveInf(t, f, map[string]any{"collectionId": num("9101")}, InfiniteRequest{Cap: 1}); !errors.Is(err, readErr) || len(f.sql) != 0 {
		t.Fatalf("a failed permission read: err %v, page queries %d; want that error and none", err, len(f.sql))
	}

	f = newInfFixture(t)
	f.deps.Sources.(*fakeV1Sources).collections = map[int]hydrate.CollectionPermission{9103: {Read: "Public", OwnerID: 7}}
	f.rows = []RawImage{
		withItem(infRow(31, 100), "ACCEPTED", nil, nil),
		withItem(infRow(32, 100), "ACCEPTED", nil, strp(`{"score":{"theme":7}}`)),
	}
	if _, _, _, err := serveInf(t, f, map[string]any{"collectionId": num("9103")}, InfiniteRequest{Cap: 1}); fallback.Reason(err) != "collection-judge-score" {
		t.Fatalf("a judged item: reason %q (%v), want collection-judge-score", fallback.Reason(err), err)
	}

	// This service's own refusals come first: an unreadable Postgres cursor never reads the
	// collection.
	f = newInfFixture(t)
	_, _, _, err := serveInf(t, f, map[string]any{"collectionId": num("9101"), "cursor": "feed:1:2"}, InfiniteRequest{Cap: 1})
	if fallback.Reason(err) != "input-cursor" || len(f.deps.Sources.(*fakeV1Sources).collectionsAsked) != 0 {
		t.Fatalf("a feed cursor on a collection: reason %q, permission reads %v; want input-cursor and none",
			fallback.Reason(err), f.deps.Sources.(*fakeV1Sources).collectionsAsked)
	}
}
