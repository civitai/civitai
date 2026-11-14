package feed

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func num(s string) json.Number { return json.Number(s) }

func TestParseDefaultsAndSupportedShape(t *testing.T) {
	in, err := Parse(map[string]any{"modelId": num("7"), "modelVersionId": num("9"), "limit": num("50"), "cursor": "123"})
	if err != nil {
		t.Fatal(err)
	}
	if in.Limit != 50 || in.Sort != SortMostReactions || in.Period != "AllTime" || in.PeriodMode != "published" {
		t.Fatalf("defaults wrong: %+v", in)
	}
	if in.ModelID != 7 || in.ModelVersionID != 9 || in.Cursor != 123 {
		t.Fatalf("ids/cursor wrong: %+v", in)
	}
	if in.BrowsingLevel != nil {
		t.Fatal("an absent browsingLevel must stay absent until the domain cap applies")
	}
}

func TestParseFallsBackOnUnportedShapes(t *testing.T) {
	cases := map[string]map[string]any{
		"input-hidden":       {"hidden": true},
		"input-username":     {"username": "x"},
		"input-tags":         {"tags": []any{num("1")}},
		"input-sort":         {"sort": "Random"},
		"input-include":      {"include": []any{"cosmetics", "tags"}},
		"input-cursor":       {"cursor": true},
		"input-collectionId": {"collectionId": num("3")},
	}
	for want, m := range cases {
		_, err := Parse(m)
		if reason := fallback.Reason(err); reason != want {
			t.Errorf("%v: reason %q, want %q (err %v)", m, fallback.Reason(err), want, err)
		}
	}
	// Falsy values of unsupported keys are the same as absent.
	if _, err := Parse(map[string]any{"hidden": false, "tags": []any{}, "username": ""}); err != nil {
		t.Fatalf("falsy keys must not fall back: %v", err)
	}
}

func TestApplyDomainCap(t *testing.T) {
	r := 4
	in := &Input{BrowsingLevel: &r}
	// Signed out (cap PG): R & PG = 0 -> the cap.
	if bl, _ := in.ApplyDomainCap(1); bl != 1 {
		t.Fatalf("signed-out level = %d, want 1", bl)
	}
	// Uncapped and absent: the schema default, 31.
	if bl, _ := (&Input{}).ApplyDomainCap(0); bl != 31 {
		t.Fatalf("uncapped default = %d, want 31", bl)
	}
	// Capped and absent: the cap (applyDomainFeature runs before the default).
	if bl, _ := (&Input{}).ApplyDomainCap(3); bl != 3 {
		t.Fatalf("capped default = %d, want 3", bl)
	}
}

func TestBuildModelVersionGalleryQuery(t *testing.T) {
	q := ImagesQuery{Limit: 100, Cursor: 555, Sort: SortMostReactions, BrowsingLevel: 31 | 32, ModelID: 7, ModelVersionID: 9,
		DisablePoi: true, DisableMinor: true, ExcludedTagIDs: []int{5, 5, 6}, ViewerID: 42}
	b := q.Build()
	mustContain(t, b.SQL,
		`FROM "ImageResourceNew" irr`,
		`JOIN "Image" i ON i.id = irr."imageId"`,
		`irr."modelVersionId" = $`,
		`ORDER BY irr."imageId" DESC`,
		`((irr."imageId" <= $`,
		`(i."poi" != TRUE OR p."userId" = $`,
		`(i."minor" != TRUE OR i."userId" = $`,
		`(i."blockedFor" IS NULL OR i."userId" = $`,
		`i."acceptableMinor" = FALSE`,
		`(p."publishedAt" < now())`,
		`irr."imageId" "cursorId"`,
	)
	// The version filter wins over modelId: no ModelVersion join.
	if strings.Contains(b.SQL, `mv."modelId"`) {
		t.Fatal("modelVersionId must not join ModelVersion")
	}
	if b.CacheTTL != 10*time.Minute || len(b.CacheTags) != 1 || b.CacheTags[0] != "images-modelVersion:9" {
		t.Fatalf("cache policy = %v %v", b.CacheTTL, b.CacheTags)
	}
	// The Blocked bit is stripped from the bound level; the limit is limit+1 (look-ahead row).
	if !hasArg(b.Args, 31) || hasArg(b.Args, 63) || !hasArg(b.Args, 101) || !hasArg(b.Args, 555) {
		t.Fatalf("args = %v", b.Args)
	}
	// Excluded tags are de-duplicated.
	foundTags := false
	for _, a := range b.Args {
		if ids, ok := a.([]int); ok && len(ids) == 2 && ids[0] == 5 && ids[1] == 6 {
			foundTags = true
		}
	}
	if !foundTags {
		t.Fatalf("excluded tag ids not de-duplicated: %v", b.Args)
	}
}

func TestBuildSignedOutAndOldest(t *testing.T) {
	b := (&ImagesQuery{Limit: 10, Sort: SortOldest, BrowsingLevel: 0, DisableMinor: true, Period: "Week"}).Build()
	mustContain(t, b.SQL, `FROM "Image" i`, `ORDER BY i."id" ASC`, `(i."blockedFor" IS NULL)`, `(i."minor" != TRUE)`,
		`interval '1 week'`)
	if strings.Contains(b.SQL, `i."id" >=`) {
		t.Fatal("a zero cursor adds no clause")
	}
	// Signed out: the availability carve-out binds NULL.
	if !hasNil(b.Args) {
		t.Fatalf("signed-out viewer must bind NULL: %v", b.Args)
	}
	// Level 0 falls back to public (1), never to "no filter".
	if !hasArg(b.Args, 1) {
		t.Fatalf("level 0 must bind 1: %v", b.Args)
	}
	if b.CacheTTL != 0 {
		t.Fatal("a non-gallery feed is not cached")
	}
	// Moderators skip the availability and blockedFor clauses.
	m := (&ImagesQuery{Limit: 10, BrowsingLevel: 31, ViewerID: 1, IsModerator: true}).Build()
	if strings.Contains(m.SQL, `"availability" != 'Private'`) || strings.Contains(m.SQL, `"blockedFor" IS NULL`) {
		t.Fatal("moderator query must not carry the availability/blockedFor clauses")
	}
}

func TestJSDateStringSortQuirk(t *testing.T) {
	// Fri 2024-03-01 is later than Mon 2024-02-26, but "Fri…" < "Mon…" as strings, which is what
	// `[dates].sort()[0]` picks.
	mon := time.Date(2024, 2, 26, 0, 0, 0, 0, time.UTC)
	fri := time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC)
	got := EarliestByJSDateString([]Image{{SortAt: mon}, {SortAt: fri}})
	if !got.Equal(fri) {
		t.Fatalf("got %v, want the Friday", got)
	}
	if s := JSDateString(fri); s != "Fri Mar 01 2024 00:00:00 GMT+0000 (Coordinated Universal Time)" {
		t.Fatalf("JSDateString = %q", s)
	}
}

func img(id, postID, index, nsfw, user int, likes int64, sortAt time.Time) Image {
	u := superjson.Object{{Key: "id", Val: int64(user)}}
	stats := superjson.Object{{Key: "likeCountAllTime", Val: likes}}
	return Image{
		Wire: superjson.Object{{Key: "id", Val: int64(id)}}, ID: id, PostID: postID, Index: index, NsfwLevel: nsfw,
		SortAt: sortAt, PublishedAt: sortAt, ModelVerID: nil, User: u, Stats: stats,
	}
}

func TestBuildPostAndSort(t *testing.T) {
	t0 := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC) // a Monday
	// Post 10: fetched images 3 (index 1) then 2 (index 0). Newest sorts the images by index,
	// but the post-level fields come from image 3 (the first as fetched).
	p := buildPost(10, []Image{img(3, 10, 1, 4, 77, 5, t0), img(2, 10, 0, 1, 77, 1, t0)}, SortNewest,
		map[int]Review{77: {Rating: 5, ID: 9}}, false, false)
	ids := []int64{}
	imgs, _ := p.wire.Get("images")
	for _, w := range imgs.([]any) {
		v, _ := w.(superjson.Object).Get("id")
		ids = append(ids, v.(int64))
	}
	if len(ids) != 2 || ids[0] != 2 || ids[1] != 3 {
		t.Fatalf("Newest image order = %v, want [2 3]", ids)
	}
	if n, _ := p.wire.Get("nsfwLevel"); n != int64(5) {
		t.Fatalf("post nsfwLevel = %v, want 5 (OR of 4 and 1)", n)
	}
	if r, _ := p.wire.Get("review"); r == nil {
		t.Fatal("review missing")
	}
	// getReactionTotals reads images[0] of the built post: image 2 after the index sort.
	if p.reactions != 1 {
		t.Fatalf("reactions = %d, want 1", p.reactions)
	}

	// MostReactions: stable on ties, so equal totals keep ascending postId order.
	posts := []post{
		buildPost(1, []Image{img(11, 1, 0, 1, 1, 2, t0)}, SortMostReactions, nil, false, false),
		buildPost(2, []Image{img(12, 2, 0, 1, 1, 9, t0)}, SortMostReactions, nil, false, false),
		buildPost(3, []Image{img(13, 3, 0, 1, 1, 2, t0)}, SortMostReactions, nil, false, false),
	}
	sortPosts(posts, SortMostReactions)
	order := []int64{}
	for _, p := range posts {
		v, _ := p.wire.Get("postId")
		order = append(order, v.(int64))
	}
	if order[0] != 2 || order[1] != 1 || order[2] != 3 {
		t.Fatalf("MostReactions order = %v, want [2 1 3]", order)
	}
	if r, _ := posts[1].wire.Get("review"); r != (superjson.Undefined{}) {
		t.Fatalf("no review must be undefined, got %v", r)
	}
}

func TestBuildImagesPublishedFilter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	past, future := now.Add(-time.Hour), now.Add(time.Hour)
	unpub := "2025-12-01"
	rows := []RawImage{
		{ID: 1, UserID: 5, PostID: 1, PublishedAt: &past},
		{ID: 2, UserID: 5, PostID: 2, PublishedAt: &future},
		{ID: 3, UserID: 6, PostID: 3, PublishedAt: &past, UnpublishedAt: &unpub},
		{ID: 4, UserID: 6, PostID: 4},
	}
	hy := &Hydrated{}
	got := BuildImages(rows, hy, Viewer{ID: 6}, now)
	ids := []int{}
	for _, i := range got {
		ids = append(ids, i.ID)
	}
	// 1 published; 2 scheduled and not the viewer's -> dropped; 3 and 4 are the viewer's own -> kept.
	if len(ids) != 3 || ids[0] != 1 || ids[1] != 3 || ids[2] != 4 {
		t.Fatalf("kept %v, want [1 3 4]", ids)
	}
	if got := BuildImages(rows, hy, Viewer{ID: 1, IsModerator: true}, now); len(got) != 4 {
		t.Fatalf("moderators keep everything, got %d", len(got))
	}
	// publishedAt on the wire is sortAt when published, undefined otherwise.
	if got[0].PublishedAt == (superjson.Undefined{}) {
		t.Fatal("published image lost its publishedAt")
	}
}

func TestParseGallerySettings(t *testing.T) {
	if s, err := ParseGallerySettings([]byte(`{"none":true,"hiddenTags":[],"pinnedPosts":{}}`)); err != nil || s != nil {
		t.Fatalf("none marker: %v %v", s, err)
	}
	for _, stale := range []string{`null`, `{"hiddenTags":[],"level":3}`, `not json`} {
		if _, err := ParseGallerySettings([]byte(stale)); fallback.Reason(err) != "gallery-settings-stale" {
			t.Fatalf("%s: err %v, want gallery-settings-stale", stale, err)
		}
	}
	s, err := ParseGallerySettings([]byte(`{"level":3,"sfwHeld":true,"pinnedPosts":{"9":[1,2]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if lvl, ok := s.HeldLevel(); !ok || lvl != 3 {
		t.Fatalf("held = %d %v", lvl, ok)
	}
	if p := s.PinnedFor(9); len(p) != 2 {
		t.Fatalf("pinned = %v", p)
	}
	s, _ = ParseGallerySettings([]byte(`{"sfwHeld":false,"level":3}`))
	if _, ok := s.HeldLevel(); ok {
		t.Fatal("not held when sfwHeld is false")
	}
	var nilSettings *GallerySettings
	if p := nilSettings.PinnedFor(9); p != nil {
		t.Fatal("nil settings have no pins")
	}
}

func TestResultValueNextCursor(t *testing.T) {
	got, _ := superjson.Serialize((&Result{}).Value())
	if want := `{"json":{"items":[]},"meta":{"values":{"nextCursor":["undefined"]},"v":1}}`; string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
	got, _ = superjson.Serialize((&Result{NextCursor: Cursor{N: 12}}).Value())
	if want := `{"json":{"nextCursor":12,"items":[]}}`; string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
	// The feed service's cursor is a plain string on the wire.
	got, _ = superjson.Serialize((&Result{NextCursor: Cursor{S: "feed:1700000000000:12"}}).Value())
	if want := `{"json":{"nextCursor":"feed:1700000000000:12","items":[]}}`; string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func mustContain(t *testing.T, sql string, parts ...string) {
	t.Helper()
	for _, p := range parts {
		if !strings.Contains(sql, p) {
			t.Errorf("SQL lacks %q", p)
		}
	}
}

func hasArg(args []any, n int) bool {
	for _, a := range args {
		if v, ok := a.(int); ok && v == n {
			return true
		}
	}
	return false
}

func hasNil(args []any) bool {
	for _, a := range args {
		if a == nil {
			return true
		}
	}
	return false
}
