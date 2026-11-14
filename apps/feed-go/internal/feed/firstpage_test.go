package feed

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// recordingFetch is a fetchFunc that answers by post ids and records every query.
type recordingFetch struct {
	byPost  map[int][]Image
	queries []ImagesQuery
}

func (r *recordingFetch) fetch(_ context.Context, q ImagesQuery) ([]Image, error) {
	r.queries = append(r.queries, q)
	var out []Image
	for _, id := range q.PostIDs {
		out = append(out, r.byPost[id]...)
	}
	return out, nil
}

type fakeResources map[int][]int

func (f fakeResources) ImageResources(_ context.Context, ids []int) (map[int][]int, error) {
	out := map[int][]int{}
	for _, id := range ids {
		if r, ok := f[id]; ok {
			out[id] = r
		}
	}
	return out, nil
}

var firstPageNow = time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)

// liveRun is one approved run of post 40 in version 9's gallery, accepted at PG|R, with images 401
// and 402 approved.
func liveRun() *fakePromotions {
	resolved := firstPageNow.Add(-time.Hour)
	return &fakePromotions{
		rows: []PromotionRow{{ID: 1, ResolvedAt: &resolved, Data: json.RawMessage(
			`{"postId":40,"days":3,"modelVersionIds":[9],"imageIds":[401,402],"acceptedLevel":5,"endsAt":"2026-11-15T00:00:00.000Z"}`)}},
		model: &PromotionModel{},
	}
}

func pageQuery() ImagesQuery {
	return ImagesQuery{Limit: 40, Sort: SortNewest, Period: "Week", BrowsingLevel: 1, ModelID: 7, ModelVersionID: 9,
		ExcludedTagIDs: []int{5}, ViewerID: 3}
}

func TestLoadFirstPagePinned(t *testing.T) {
	f := &recordingFetch{byPost: map[int][]Image{
		30: {pimg(301, 30), pimg(302, 30)},
		20: {pimg(201, 20)},
	}}
	fp, err := loadFirstPage(context.Background(), firstPageArgs{
		fetch: f.fetch,
		// 301 was made with version 9, 302 only with version 8, 201 has no resource rows.
		resources:      fakeResources{301: {8, 9}, 302: {8}},
		promotions:     &fakePromotions{},
		audience:       PromotionsOff,
		q:              pageQuery(),
		modelID:        7,
		modelVersionID: 9,
		pinnedIDs:      []int{30, 20},
		browsingLevel:  1,
		now:            firstPageNow,
	})
	if err != nil {
		t.Fatal(err)
	}
	// One fetch: the pinned posts whole, without the model scope or a cursor, 20 posts × 20 images,
	// with the request's own sort, period, level and filters.
	want := ImagesQuery{Limit: 400, Sort: SortNewest, Period: "Week", BrowsingLevel: 1,
		ExcludedTagIDs: []int{5}, ViewerID: 3, PostIDs: []int{30, 20}}
	if len(f.queries) != 1 || !reflect.DeepEqual(f.queries[0], want) {
		t.Fatalf("queries = %+v, want [%+v]", f.queries, want)
	}
	if got := imageIDs(fp.pinned[30]); !reflect.DeepEqual(got, []int{301}) {
		t.Fatalf("pinned post 30 = %v, want [301] (302 is another version's)", got)
	}
	if got := imageIDs(fp.pinned[20]); !reflect.DeepEqual(got, []int{201}) {
		t.Fatalf("pinned post 20 = %v, want [201] (no resource rows: kept)", got)
	}
	if len(fp.sponsored) != 0 || fp.sponsoredPostID() != 0 {
		t.Fatalf("flag off: sponsored = %v", fp.sponsored)
	}
}

func TestLoadFirstPageSponsored(t *testing.T) {
	images := map[int][]Image{40: {pimg(403, 40), pimg(402, 40), pimg(401, 40)}}
	preCap := 1 | 4 | 8
	args := func(f *recordingFetch, s *fakePromotions, a PromotionAudience, v *Viewer) firstPageArgs {
		return firstPageArgs{fetch: f.fetch, resources: fakeResources{}, promotions: s, audience: a, viewer: v,
			q: pageQuery(), modelID: 7, modelVersionID: 9, browsingLevel: 1, preCap: &preCap, now: firstPageNow}
	}
	mod := &Viewer{ID: 3, IsModerator: true}

	// On for this viewer: the approved images, fetched at (preCap & serving) = PG|R, 20 rows.
	f := &recordingFetch{byPost: images}
	fp, err := loadFirstPage(context.Background(), args(f, liveRun(), PromotionsModsTesters, mod))
	if err != nil {
		t.Fatal(err)
	}
	want := ImagesQuery{Limit: 20, Sort: SortNewest, Period: "Week", BrowsingLevel: 5,
		ExcludedTagIDs: []int{5}, ViewerID: 3, PostIDs: []int{40}}
	if len(f.queries) != 1 || !reflect.DeepEqual(f.queries[0], want) {
		t.Fatalf("queries = %+v, want [%+v]", f.queries, want)
	}
	// 403 was added after the host accepted: never shown. The fetched order is kept.
	if got := imageIDs(fp.sponsored); !reflect.DeepEqual(got, []int{402, 401}) || fp.sponsoredPostID() != 40 {
		t.Fatalf("sponsored = %v (post %d), want [402 401] of post 40", got, fp.sponsoredPostID())
	}

	// Off for this viewer (signed out, the moderators/testers rule): nothing is read at all.
	s := liveRun()
	f = &recordingFetch{byPost: images}
	fp, err = loadFirstPage(context.Background(), args(f, s, PromotionsModsTesters, nil))
	if err != nil || len(fp.sponsored) != 0 || len(s.since) != 0 || len(f.queries) != 0 {
		t.Fatalf("signed out: %v %v, %d lookups, %d fetches", fp, err, len(s.since), len(f.queries))
	}

	// Unknown for this viewer and a post would be shown: fall back.
	user := &Viewer{ID: 3}
	_, err = loadFirstPage(context.Background(), args(&recordingFetch{byPost: images}, liveRun(), PromotionsModsTesters, user))
	if fallback.Reason(err) != "sponsored-post" {
		t.Fatalf("unknown audience with a post to show: err %v", err)
	}
	_, err = loadFirstPage(context.Background(), args(&recordingFetch{byPost: images}, liveRun(), PromotionsUnknown, mod))
	if fallback.Reason(err) != "sponsored-post" {
		t.Fatalf("unknown mirror with a post to show: err %v", err)
	}
	// Unknown, but none of the approved images survives the viewer's filters: the flag cannot change
	// the answer, so it is served without one.
	fp, err = loadFirstPage(context.Background(), args(&recordingFetch{byPost: map[int][]Image{40: {pimg(403, 40)}}}, liveRun(), PromotionsUnknown, user))
	if err != nil || len(fp.sponsored) != 0 {
		t.Fatalf("unknown, nothing to show: %v %v", fp.sponsored, err)
	}
	// Unknown, no live run: served.
	fp, err = loadFirstPage(context.Background(), args(&recordingFetch{}, &fakePromotions{}, PromotionsUnknown, user))
	if err != nil || len(fp.sponsored) != 0 {
		t.Fatalf("unknown, no run: %v %v", fp.sponsored, err)
	}

	// The sponsored post is one of the version's pinned posts: not shown as sponsored.
	f = &recordingFetch{byPost: images}
	a := args(f, liveRun(), PromotionsEveryone, nil)
	a.pinnedIDs = []int{40}
	fp, err = loadFirstPage(context.Background(), a)
	if err != nil || len(fp.sponsored) != 0 || len(f.queries) != 1 {
		t.Fatalf("pinned sponsored post: %v %v, %d fetches (want only the pinned one)", fp.sponsored, err, len(f.queries))
	}

	// The viewer's level and the run's serving level share nothing: not fetched.
	f = &recordingFetch{byPost: images}
	r := liveRun()
	r.model = &PromotionModel{SfwOnly: true} // accepted PG|R & SFW = PG
	pgless := 4
	a = args(f, r, PromotionsEveryone, nil)
	a.preCap = &pgless
	fp, err = loadFirstPage(context.Background(), a)
	if err != nil || len(fp.sponsored) != 0 || len(f.queries) != 0 {
		t.Fatalf("no shared level: %v %v, %d fetches", fp.sponsored, err, len(f.queries))
	}

	// Not a version gallery: no lookup.
	s = liveRun()
	a = args(&recordingFetch{}, s, PromotionsEveryone, nil)
	a.modelVersionID = 0
	if _, err := loadFirstPage(context.Background(), a); err != nil || len(s.since) != 0 {
		t.Fatalf("model gallery without a version: %v, %d lookups", err, len(s.since))
	}

	// A failed lookup: Node shows no sponsored post, but cannot be told apart from here.
	_, err = loadFirstPage(context.Background(), args(&recordingFetch{}, &fakePromotions{err: context.DeadlineExceeded}, PromotionsEveryone, nil))
	if fallback.Reason(err) != "sponsored-lookup" {
		t.Fatalf("lookup error: %v", err)
	}
}

// aimg is an image for assemble: one per post, sortAt on the given day of 2024-01.
func aimg(id, postID, day int) Image {
	at := time.Date(2024, 1, day, 0, 0, 0, 0, time.UTC)
	return Image{Wire: superjson.Object{{Key: "id", Val: int64(id)}}, ID: id, PostID: postID, NsfwLevel: 1,
		SortAt: at, PublishedAt: at, User: superjson.Object{{Key: "id", Val: int64(7)}}, Stats: superjson.Object{}}
}

func postOrder(items []any) []int64 {
	out := make([]int64, len(items))
	for i, it := range items {
		v, _ := it.(superjson.Object).Get("postId")
		out[i] = v.(int64)
	}
	return out
}

func flagOf(it any, key string) any {
	v, _ := it.(superjson.Object).Get(key)
	return v
}

func TestAssemblePinnedFirstAndSponsoredSlot(t *testing.T) {
	// Page posts 10 (Jan 3) and 20 (Jan 5); pinned 30 (Jan 1) and 5 (Jan 2); sponsored 40.
	posts := map[int][]Image{10: {aimg(101, 10, 3)}, 20: {aimg(201, 20, 5)}}
	fp := &firstPage{
		pinned:    map[int][]Image{30: {aimg(301, 30, 1)}, 5: {aimg(51, 5, 2)}},
		sponsored: []Image{aimg(401, 40, 4)},
	}
	cases := []struct {
		sort string
		want []int64
	}{
		// Pinned first, newest first within each group, the sponsored post after the pinned ones.
		{SortNewest, []int64{5, 30, 40, 20, 10}},
		{SortOldest, []int64{30, 5, 40, 10, 20}},
		// Equal stats: each group keeps ascending postId.
		{SortMostReactions, []int64{5, 30, 40, 10, 20}},
	}
	for _, c := range cases {
		items := assemble(fp, posts, c.sort, nil, false)
		if got := postOrder(items); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: order %v, want %v", c.sort, got, c.want)
		}
	}
	items := assemble(fp, posts, SortNewest, nil, false)
	if flagOf(items[0], "pinned") != true || flagOf(items[1], "pinned") != true || flagOf(items[3], "pinned") != false {
		t.Fatalf("pinned flags = %v %v %v", flagOf(items[0], "pinned"), flagOf(items[1], "pinned"), flagOf(items[3], "pinned"))
	}
	if flagOf(items[2], "sponsored") != true || flagOf(items[2], "pinned") != false || flagOf(items[0], "sponsored") != false {
		t.Fatalf("sponsored flags wrong: %v", items[2])
	}

	// No pinned posts: second, so the list opens on an organic post.
	fp = &firstPage{sponsored: []Image{aimg(401, 40, 4)}}
	if got := postOrder(assemble(fp, posts, SortNewest, nil, false)); !reflect.DeepEqual(got, []int64{20, 40, 10}) {
		t.Fatalf("no pinned: %v, want [20 40 10]", got)
	}
	// An otherwise empty page: first.
	if got := postOrder(assemble(fp, nil, SortNewest, nil, false)); !reflect.DeepEqual(got, []int64{40}) {
		t.Fatalf("empty page: %v, want [40]", got)
	}
}

func TestBuildSponsored(t *testing.T) {
	// Eight approved images out of index order; no per-post index sort for a sponsored post.
	var images []Image
	for i, idx := range []int{7, 0, 1, 2, 3, 4, 5, 6} {
		im := wimg(i+1, 40, idx, 1)
		if idx == 7 {
			im.NsfwLevel = 4
		}
		images = append(images, im)
	}
	w := buildSponsored(images, true)
	want := []string{"postId", "pinned", "sponsored", "nsfwLevel", "modelVersionId", "publishedAt", "sortAt", "createdAt", "user", "imageCount", "images", "review"}
	if got := wireKeys(w); !reflect.DeepEqual(got, want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	shown, _ := w.Get("images")
	var ids []int64
	for _, x := range shown.([]any) {
		v, _ := x.(superjson.Object).Get("id")
		ids = append(ids, v.(int64))
	}
	if !reflect.DeepEqual(ids, []int64{1, 2, 3, 4, 5, 6}) {
		t.Fatalf("images = %v, want the first six as fetched", ids)
	}
	if n, _ := w.Get("imageCount"); n != int64(8) {
		t.Fatalf("imageCount = %v, want 8", n)
	}
	if n, _ := w.Get("nsfwLevel"); n != int64(5) {
		t.Fatalf("nsfwLevel = %v, want 5", n)
	}
	if r, _ := w.Get("review"); r != (superjson.Undefined{}) {
		t.Fatalf("review = %v, want undefined", r)
	}
	if keys := wireKeys(buildSponsored(images, false)); hasKey(keys, "imageCount") {
		t.Fatalf("lazy off must not carry imageCount: %v", keys)
	}
}

func TestBuildPostPinnedFlag(t *testing.T) {
	p := buildPost(10, []Image{aimg(1, 10, 1)}, SortNewest, nil, false, true)
	if v, _ := p.wire.Get("pinned"); v != true || !p.pinned {
		t.Fatalf("pinned = %v / %v", v, p.pinned)
	}
}

func TestMergedPostIDs(t *testing.T) {
	got := mergedPostIDs(map[int][]Image{30: nil, 5: nil}, map[int][]Image{10: nil, 2: nil})
	if !reflect.DeepEqual(got, []int{2, 5, 10, 30}) {
		t.Fatalf("merged = %v, want ascending [2 5 10 30]", got)
	}
}
