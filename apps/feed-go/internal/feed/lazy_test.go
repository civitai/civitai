package feed

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func TestParseCursorShapes(t *testing.T) {
	cases := []struct {
		cursor  any
		n       int
		text    string
		numeric bool
	}{
		{"feed:1700000000000:12", 0, "feed:1700000000000:12", false}, // the feed service's keyset
		{"500|1724677401898", 0, "500|1724677401898", false},         // the search index's offset|entry
		{"123", 123, "123", true},
		{num("55"), 55, "", true},
		{"", 0, "", true}, // falsy: no cursor
		{"0", 0, "0", false},
		{"-5", 0, "-5", false},
	}
	for _, c := range cases {
		in, err := Parse(map[string]any{"cursor": c.cursor})
		if err != nil {
			t.Errorf("%v: %v", c.cursor, err)
			continue
		}
		if in.Cursor != c.n || in.CursorText != c.text || in.NumericCursor() != c.numeric {
			t.Errorf("%v: Cursor=%d CursorText=%q numeric=%v, want %d %q %v", c.cursor, in.Cursor, in.CursorText, in.NumericCursor(), c.n, c.text, c.numeric)
		}
	}
}

func TestParseMetaAndRemixFlags(t *testing.T) {
	in, err := Parse(map[string]any{"include": []any{"cosmetics", "meta"}})
	if err != nil {
		t.Fatal(err)
	}
	// include 'meta' narrows the SQL; only the withMeta flag goes to the feed query.
	if !in.WithMeta || in.WithMetaFlag {
		t.Fatalf("include meta: WithMeta=%v WithMetaFlag=%v, want true false", in.WithMeta, in.WithMetaFlag)
	}
	in, _ = Parse(map[string]any{"withMeta": true, "requiringMeta": true, "remixOfId": num("4")})
	if !in.WithMeta || !in.WithMetaFlag || !in.RequiringMeta || !in.HasRemixOfID {
		t.Fatalf("flags = %+v", in)
	}
	in, _ = Parse(map[string]any{"remixOfId": num("0")})
	if in.HasRemixOfID {
		t.Fatal("remixOfId 0 is not present (the mapper's present())")
	}
}

func TestPackPostCompletions(t *testing.T) {
	ones := make([]int, 30)
	for i := range ones {
		ones[i] = i + 1
	}
	got := packPostCompletions(ones, func(int) int { return 1 })
	if len(got) != 2 || len(got[0]) != 25 || len(got[1]) != 5 || got[1][0] != 26 {
		t.Fatalf("30 one-row posts = %v, want 25 then 5", got)
	}
	rows := map[int]int{1: 150, 2: 60, 3: 20, 4: 250}
	got = packPostCompletions([]int{1, 2, 3, 4}, func(id int) int { return rows[id] })
	if want := [][]int{{1}, {2, 3}, {4}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("by rows = %v, want %v", got, want)
	}
	if got := packPostCompletions(nil, func(int) int { return 1 }); got != nil {
		t.Fatalf("no posts = %v", got)
	}
}

// fakeSource is a pageSource with canned answers.
type fakeSource struct {
	pages     map[Cursor]fakePage
	pageCalls []Cursor
	posts     []Image
	postCalls [][]int
	limits    []int
	err       error
}

type fakePage struct {
	images []Image
	next   Cursor
}

func (f *fakeSource) Page(_ context.Context, c Cursor, limit int) ([]Image, Cursor, error) {
	f.pageCalls = append(f.pageCalls, c)
	f.limits = append(f.limits, limit)
	p := f.pages[c]
	return p.images, p.next, nil
}

func (f *fakeSource) Posts(_ context.Context, postIDs []int, limit int) ([]Image, error) {
	f.postCalls = append(f.postCalls, append(append([]int(nil), postIDs...), limit))
	return f.posts, f.err
}

func pimg(id, postID int) Image { return Image{ID: id, PostID: postID} }

func imageIDs(images []Image) []int {
	out := make([]int, len(images))
	for i, x := range images {
		out[i] = x.ID
	}
	return out
}

func TestCollectPostsFollowsTheFeedCursor(t *testing.T) {
	src := &fakeSource{pages: map[Cursor]fakePage{
		{S: "500|1724677401898"}: {images: []Image{pimg(1, 10), pimg(2, 0), pimg(3, 20), pimg(4, 10)}, next: Cursor{S: "feed:1700:4"}},
		{S: "feed:1700:4"}:       {images: []Image{pimg(5, 30), pimg(6, 99)}, next: Cursor{S: "feed:1600:6"}},
		{S: "feed:1600:6"}:       {images: []Image{pimg(7, 40)}},
	}}
	posts, cursor, err := collectPosts(context.Background(), src, Cursor{S: "500|1724677401898"}, 8, 3, map[int]bool{99: true})
	if err != nil {
		t.Fatal(err)
	}
	// Page 1 holds posts 10, 20 (< 3): fetch on. Page 2 adds 30 (99 is pinned): 3 posts, stop.
	if want := []Cursor{{S: "500|1724677401898"}, {S: "feed:1700:4"}}; !reflect.DeepEqual(src.pageCalls, want) {
		t.Fatalf("pages fetched = %v, want %v", src.pageCalls, want)
	}
	if !reflect.DeepEqual(src.limits, []int{8, 8}) {
		t.Fatalf("limits = %v", src.limits)
	}
	if cursor != (Cursor{S: "feed:1600:6"}) {
		t.Fatalf("cursor = %v, want the second page's next", cursor)
	}
	if len(posts) != 3 || !reflect.DeepEqual(imageIDs(posts[10]), []int{1, 4}) || posts[99] != nil {
		t.Fatalf("posts = %v", posts)
	}
	// The end of the feed (no next cursor) stops the loop with no cursor.
	src = &fakeSource{pages: map[Cursor]fakePage{{}: {images: []Image{pimg(1, 10)}}}}
	_, cursor, _ = collectPosts(context.Background(), src, Cursor{}, 8, 3, nil)
	if !cursor.None() || len(src.pageCalls) != 1 {
		t.Fatalf("end of feed: cursor %v after %d calls", cursor, len(src.pageCalls))
	}
}

func TestCompletePosts(t *testing.T) {
	newPosts := func() map[int][]Image {
		return map[int][]Image{10: {pimg(101, 10)}, 20: {pimg(201, 20), pimg(202, 20)}, 30: {pimg(301, 30)}}
	}
	posts := newPosts()
	src := &fakeSource{posts: []Image{pimg(103, 10), pimg(101, 10), pimg(302, 30), pimg(999, 40), pimg(102, 10), pimg(5, 0)}}
	// Post 20 is whole (2 rows, 2 held); post 30 has no count, so it counts as POST_IMAGE_LIMIT (20).
	if err := completePosts(context.Background(), src, posts, []int{10, 20, 30}, map[int]int{10: 3, 20: 2}); err != nil {
		t.Fatal(err)
	}
	if want := [][]int{{10, 30, 23}}; !reflect.DeepEqual(src.postCalls, want) {
		t.Fatalf("completion fetches (post ids + limit) = %v, want %v", src.postCalls, want)
	}
	// Missing images are appended in completion order; held ones and posts not on the page are not.
	if got := imageIDs(posts[10]); !reflect.DeepEqual(got, []int{101, 103, 102}) {
		t.Fatalf("post 10 = %v", got)
	}
	if got := imageIDs(posts[30]); !reflect.DeepEqual(got, []int{301, 302}) {
		t.Fatalf("post 30 = %v", got)
	}
	if got := imageIDs(posts[20]); !reflect.DeepEqual(got, []int{201, 202}) || posts[40] != nil {
		t.Fatalf("post 20 = %v, post 40 = %v", got, posts[40])
	}

	// Counts unknown (the count query failed): every post is completed.
	src = &fakeSource{}
	if err := completePosts(context.Background(), src, newPosts(), []int{10, 20, 30}, nil); err != nil {
		t.Fatal(err)
	}
	if want := [][]int{{10, 20, 30, 60}}; !reflect.DeepEqual(src.postCalls, want) {
		t.Fatalf("no counts: %v, want %v", src.postCalls, want)
	}

	// A completion that fails fails the request (Promise.all rejects).
	src = &fakeSource{err: fallback.New("feed-unavailable")}
	err := completePosts(context.Background(), src, newPosts(), []int{10}, map[int]int{10: 2})
	if fallback.Reason(err) != "feed-unavailable" {
		t.Fatalf("err = %v", err)
	}
}

func wimg(id, postID, index, nsfw int) Image {
	return Image{Wire: superjson.Object{{Key: "id", Val: int64(id)}}, ID: id, PostID: postID, Index: index, NsfwLevel: nsfw,
		User: superjson.Object{{Key: "id", Val: int64(7)}}, Stats: superjson.Object{}}
}

func wireKeys(o superjson.Object) []string {
	out := make([]string, len(o))
	for i, f := range o {
		out[i] = f.Key
	}
	return out
}

func TestBuildPostLazySlice(t *testing.T) {
	// Eight images fetched out of index order; image 8 (index 7) carries the only R bit.
	var images []Image
	for i, idx := range []int{7, 0, 1, 2, 3, 4, 5, 6} {
		nsfw := 1
		if idx == 7 {
			nsfw = 4
		}
		images = append(images, wimg(i+1, 10, idx, nsfw))
	}
	p := buildPost(10, images, SortNewest, nil, true)
	want := []string{"postId", "pinned", "sponsored", "nsfwLevel", "modelVersionId", "publishedAt", "sortAt", "createdAt", "user", "imageCount", "images", "review"}
	if got := wireKeys(p.wire); !reflect.DeepEqual(got, want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	if n, _ := p.wire.Get("imageCount"); n != int64(8) {
		t.Fatalf("imageCount = %v, want 8 (the whole post, before the slice)", n)
	}
	got, _ := p.wire.Get("images")
	var ids []int64
	for _, w := range got.([]any) {
		v, _ := w.(superjson.Object).Get("id")
		ids = append(ids, v.(int64))
	}
	// Newest sorts by index first, then slices: indexes 0..5 are images 2..7.
	if !reflect.DeepEqual(ids, []int64{2, 3, 4, 5, 6, 7}) {
		t.Fatalf("sliced images = %v", ids)
	}
	// nsfwLevel is the OR over every image, including the ones past the slice.
	if n, _ := p.wire.Get("nsfwLevel"); n != int64(5) {
		t.Fatalf("nsfwLevel = %v, want 5", n)
	}

	// Lazy off: every image, no imageCount key at all.
	p = buildPost(10, images, SortNewest, nil, false)
	if got := wireKeys(p.wire); hasKey(got, "imageCount") {
		t.Fatalf("lazy off must not carry imageCount: %v", got)
	}
	all, _ := p.wire.Get("images")
	if len(all.([]any)) != 8 {
		t.Fatalf("lazy off images = %d, want 8", len(all.([]any)))
	}
	// A post within the slice keeps all its images and its count.
	p = buildPost(10, images[:3], SortMostReactions, nil, true)
	few, _ := p.wire.Get("images")
	if n, _ := p.wire.Get("imageCount"); n != int64(3) || len(few.([]any)) != 3 {
		t.Fatalf("small post: imageCount %v, %d images", n, len(few.([]any)))
	}
}

func hasKey(keys []string, k string) bool {
	for _, x := range keys {
		if x == k {
			return true
		}
	}
	return false
}

// fakeFeed answers by query string.
type fakeFeed struct {
	answers map[string]feedsvc.Answer
	err     error
	queries []string
}

func (f *fakeFeed) Fetch(_ context.Context, query string) (feedsvc.Answer, error) {
	f.queries = append(f.queries, query)
	if f.err != nil {
		return feedsvc.Answer{}, f.err
	}
	a, ok := f.answers[query]
	if !ok {
		return feedsvc.Answer{Status: 400}, nil
	}
	return a, nil
}

func TestIndexSourceServe(t *testing.T) {
	base := feedsvc.Query{BrowsingLevel: 1, ModelVersionID: 9, Sort: SortNewest}
	var hydrated [][]int
	hydrate := func(rows ...Image) func(context.Context, []int, []int) ([]Image, error) {
		return func(_ context.Context, ids, postIDs []int) ([]Image, error) {
			hydrated = append(hydrated, ids, postIDs)
			return rows, nil
		}
	}
	feed := &fakeFeed{answers: map[string]feedsvc.Answer{
		"levels=1&versionIds=9&sort=newest&limit=8":                                {Status: 200, IDs: []int{30, 10, 20}, NextCursor: "1700|20"},
		"levels=1&versionIds=9&sort=newest&limit=8&cursor=1700%7C20":               {Status: 200, NextCursor: "1600|5"},
		"levels=1&versionIds=9&postIds=10%2C30&sort=newest&limit=23":               {Status: 200, IDs: []int{11, 31}},
		"levels=1&versionIds=9&sort=newest&limit=8&offset=40&before=1724677380000": {Status: 503},
	}}
	src := &indexSource{feed: feed, base: base, hydrate: hydrate(pimg(20, 2), pimg(10, 1))}

	// Image 30 was filtered out by the hydrate; the rest come back in the feed's order.
	images, next, err := src.Page(context.Background(), Cursor{}, 8)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(imageIDs(images), []int{10, 20}) || next != (Cursor{S: "feed:1700:20"}) {
		t.Fatalf("page = %v next %v", imageIDs(images), next)
	}
	if !reflect.DeepEqual(hydrated, [][]int{{30, 10, 20}, nil}) {
		t.Fatalf("hydrated = %v", hydrated)
	}

	// The client's feed cursor goes back as the feed's keyset; no ids is an empty page that keeps
	// the feed's cursor, and nothing is hydrated.
	hydrated = nil
	images, next, err = src.Page(context.Background(), Cursor{S: "feed:1700:20"}, 8)
	if err != nil || len(images) != 0 || next != (Cursor{S: "feed:1600:5"}) || hydrated != nil {
		t.Fatalf("empty page: %v %v %v hydrated %v", imageIDs(images), next, err, hydrated)
	}

	// The completion sends the post ids and hydrates within them.
	src.hydrate = hydrate(pimg(31, 30), pimg(11, 10))
	images, err = src.Posts(context.Background(), []int{10, 30}, 23)
	if err != nil || !reflect.DeepEqual(imageIDs(images), []int{11, 31}) {
		t.Fatalf("completion = %v %v", imageIDs(images), err)
	}
	if !reflect.DeepEqual(hydrated[len(hydrated)-1], []int{10, 30}) {
		t.Fatalf("completion hydrate post ids = %v", hydrated[len(hydrated)-1])
	}

	// A 5xx is a fallback (Node answers 503, or a stale copy this service does not hold).
	_, _, err = src.Page(context.Background(), Cursor{S: "40|1724677401898"}, 8)
	if fallback.Reason(err) != "feed-status" {
		t.Fatalf("503: err %v", err)
	}

	// A cursor the mapper rejects is Node's BAD_REQUEST: fall back, without calling the feed.
	calls := len(feed.queries)
	_, _, err = src.Page(context.Background(), Cursor{S: "abc"}, 8)
	if fallback.Reason(err) != "feed-cursor:unparsed" || len(feed.queries) != calls {
		t.Fatalf("unparsed cursor: err %v, feed calls %d -> %d", err, calls, len(feed.queries))
	}
	// A shape the mapper cannot express is Node's empty page, also without calling the feed.
	unmapped := &indexSource{feed: feed, base: feedsvc.Query{BrowsingLevel: 1, ModelID: 7, Sort: SortNewest}, hydrate: hydrate()}
	images, next, err = unmapped.Page(context.Background(), Cursor{}, 8)
	if err != nil || len(images) != 0 || !next.None() || len(feed.queries) != calls {
		t.Fatalf("unmapped: %v %v %v", images, next, err)
	}

	// Every id filtered out by the hydrate: Node retries on the other replica, so this falls back.
	empty := &indexSource{feed: feed, base: base, hydrate: hydrate()}
	if _, _, err := empty.Page(context.Background(), Cursor{}, 8); fallback.Reason(err) != "feed-hydrate-empty" {
		t.Fatalf("hydrate empty: err %v", err)
	}
	// A transport error is a fallback.
	down := &indexSource{feed: &fakeFeed{err: errors.New("dial tcp: refused")}, base: base, hydrate: hydrate()}
	if _, _, err := down.Page(context.Background(), Cursor{}, 8); fallback.Reason(err) != "feed-unavailable" {
		t.Fatalf("feed down: err %v", err)
	}
}

func TestServeIndexPathRoundTripsTheFeedCursor(t *testing.T) {
	// A Model3D gallery (no model gates), signed out, so capped at PG. At PG the default addons
	// exclude POI and the people tags. Both feed pages are empty, so nothing is hydrated and the
	// counts query has no posts to read.
	const q1 = "levels=1&excludedTags=5161%2C5162%2C5188%2C5249%2C130818%2C130820%2C133182%2C130401%2C110980&excludePoi=1&model3dIds=5&sort=reactions&limit=20"
	feed := &fakeFeed{answers: map[string]feedsvc.Answer{
		q1:                      {Status: 200, NextCursor: "900|77"},
		q1 + "&cursor=900%7C77": {Status: 200},
	}}
	d := &Deps{Feed: feed, Config: Config{ImageIndexFeed: true, LazyPostImages: true}, Now: func() time.Time { return time.Unix(0, 0) }}
	in, err := Parse(map[string]any{"model3dId": num("5"), "limit": num("10")})
	if err != nil {
		t.Fatal(err)
	}
	res, err := Serve(context.Background(), d, Request{Input: in, Cap: 1})
	if err != nil {
		t.Fatalf("serve: %v (queries %v)", err, feed.queries)
	}
	if want := []string{q1, q1 + "&cursor=900%7C77"}; !reflect.DeepEqual(feed.queries, want) {
		t.Fatalf("feed queries =\n%v\nwant\n%v", feed.queries, want)
	}
	if len(res.Items) != 0 || !res.NextCursor.None() {
		t.Fatalf("result = %+v", res)
	}
}

func TestBuildFeedHydrateQuery(t *testing.T) {
	// feedHydrateQuery: the model scope is dropped (so no ImageResourceNew join), the ids and the
	// completion's post ids are filters, and the Model3D cache policy stays.
	q := ImagesQuery{Limit: 3, Sort: SortNewest, Period: "AllTime", BrowsingLevel: 1, Model3DID: 5,
		IDs: []int{30, 10, 20}, PostIDs: []int{7}, ThrowOnStatementTimeout: true}
	b := q.Build()
	mustContain(t, b.SQL, `FROM "Image" i`, `i."id" = ANY($`, `i."postId" = ANY($`, `p."model3dId" = $`, `ORDER BY i."id" DESC`)
	if strings.Contains(b.SQL, `irr`) {
		t.Fatal("the hydrate must not join ImageResourceNew")
	}
	if !b.ThrowOnStatementTimeout || b.CacheTTL != 10*time.Minute || len(b.CacheTags) != 1 || b.CacheTags[0] != "images-model3d:5" {
		t.Fatalf("built = %+v", b)
	}
	if !hasArg(b.Args, 4) {
		t.Fatalf("limit must bind len(ids)+1 = 4: %v", b.Args)
	}
}

func TestFetchRowsThrowsOnStatementTimeoutWhenAsked(t *testing.T) {
	shortStatementTimeout(t)
	_, err := FetchRows(context.Background(), &blockingDB{}, nil, Built{SQL: "select 1", ThrowOnStatementTimeout: true})
	if err == nil {
		t.Fatal("a hydrate's statement timeout must be an error, not an empty page")
	}
}

func TestServePageSourceSelection(t *testing.T) {
	in, err := Parse(map[string]any{"cursor": "feed:1700:12"})
	if err != nil {
		t.Fatal(err)
	}
	// Index flag mirrored on without a feed service: fall back before anything is read.
	_, err = Serve(context.Background(), &Deps{Config: Config{ImageIndexFeed: true}}, Request{Input: in})
	if fallback.Reason(err) != "index-feed-unconfigured" {
		t.Fatalf("no feed service: err %v", err)
	}
	// Index flag off: the Postgres path cannot read a feed cursor (getCursor 400s it).
	_, err = Serve(context.Background(), &Deps{}, Request{Input: in})
	if fallback.Reason(err) != "input-cursor" {
		t.Fatalf("postgres path with a feed cursor: err %v", err)
	}
}
