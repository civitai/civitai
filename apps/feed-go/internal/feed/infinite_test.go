package feed

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

func TestParseInfiniteReadsTheScopes(t *testing.T) {
	in, err := ParseInfinite(map[string]any{
		"userId": num("5"), "username": "a_B9", "postId": num("7"), "tags": []any{num("3"), num("-4")},
		"include": []any{"cosmetics", "profilePictures"}, "limit": num("10"), "hatTeams": []any{"red"},
		"hatTurfMine": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if in.UserID != 5 || in.Username != "a_B9" || in.PostID != 7 || !reflect.DeepEqual(in.Tags, []int{3, -4}) ||
		!in.IncludeProfilePictures || in.Limit != 10 || in.Sort != SortMostReactions || in.Period != "AllTime" {
		t.Fatalf("parsed = %+v", in)
	}
	// Without the include, profile pictures are not asked for.
	in, err = ParseInfinite(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if in.IncludeProfilePictures || in.UserID != 0 || in.PostID != 0 || in.Tags != nil || in.Limit != 100 {
		t.Fatalf("defaults = %+v", in)
	}
}

func TestParseInfiniteFallsBack(t *testing.T) {
	cases := []struct {
		name string
		m    map[string]any
		want string
	}{
		{"a hat sort", map[string]any{"hatSort": "most"}, "infinite-hat-turf"},
		{"the hidden worn hats", map[string]any{"hideWornHats": true}, "infinite-hat-turf"},
		{"the hidden turf hats", map[string]any{"hideTurfHats": true}, "infinite-hat-turf"},
		{"the viewer's own hats", map[string]any{"hatTurfMine": true}, "infinite-hat-turf"},
		{"the viewer's expired hats", map[string]any{"hatTurfExpired": true}, "infinite-hat-turf"},
		{"userId 0", map[string]any{"userId": num("0")}, "infinite-user-zero"},
		{"a negative userId", map[string]any{"userId": num("-1")}, "input-invalid"},
		{"a username outside the schema", map[string]any{"username": "a-b"}, "input-invalid"},
		{"a numeric username", map[string]any{"username": num("5")}, "input-invalid"},
		{"a fractional postId", map[string]any{"postId": num("1.5")}, "input-invalid"},
		{"tags not a list", map[string]any{"tags": "1"}, "input-invalid"},
		{"a collection of id 0", map[string]any{"collectionId": num("0")}, "collection-id"},
		{"a collection tag without a collection", map[string]any{"collectionTagId": num("3")}, "input-collectionTagId"},
		{"Recently Added without a collection", map[string]any{"sort": "Recently Added"}, "input-sort"},
		{"a hub", map[string]any{"hubId": num("3")}, "input-hubId"},
		{"post ids", map[string]any{"postIds": []any{num("1")}}, "input-postIds"},
		{"published only", map[string]any{"publishedOnly": true}, "input-publishedOnly"},
		{"a Random sort", map[string]any{"sort": "Random"}, "input-sort"},
	}
	for _, c := range cases {
		_, err := ParseInfinite(c.m)
		if got := fallback.Reason(err); got != c.want {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.want)
		}
	}
	// The gallery's own list is unchanged by the infinite one (a creator scope still falls back there).
	if _, err := Parse(map[string]any{"userId": num("5")}); fallback.Reason(err) != "input-userId" {
		t.Fatalf("gallery Parse of userId: %v", err)
	}
}

func TestInfiniteOwnScopeAndPath(t *testing.T) {
	// The viewer is 5 / "alice" unless the case says otherwise; creator 6 is "bob".
	cases := []struct {
		name     string
		in       InfiniteInput
		viewerID int
		viewer   string
		want     bool
	}{
		{"own id", InfiniteInput{UserID: 5}, 5, "alice", true},
		{"own name, case-insensitively", InfiniteInput{Username: "ALICE"}, 5, "alice", true},
		{"own id and own name", InfiniteInput{UserID: 5, Username: "Alice"}, 5, "alice", true},
		{"another creator's id", InfiniteInput{UserID: 6}, 5, "alice", false},
		{"another creator's name", InfiniteInput{Username: "bob"}, 5, "alice", false},
		{"another creator's id with the viewer's name", InfiniteInput{UserID: 6, Username: "alice"}, 5, "alice", false},
		{"own id beside a name that does not match (a slugified one)", InfiniteInput{UserID: 5, Username: "johndoe"}, 5, "john.doe", true},
		{"a prefix is not the name", InfiniteInput{Username: "alice2"}, 5, "alice", false},
		{"no creator scope", InfiniteInput{}, 5, "alice", false},
		{"signed out, by id", InfiniteInput{UserID: 5}, 0, "", false},
		{"signed out, by name", InfiniteInput{Username: "alice"}, 0, "", false},
		{"a viewer without a name (v1), own id beside a name", InfiniteInput{UserID: 5, Username: "alice"}, 5, "", true},
		{"a viewer without a name (v1), by name alone", InfiniteInput{Username: "alice"}, 5, "", false},
	}
	for _, c := range cases {
		in := c.in
		if got := in.ownScoped(c.viewerID, c.viewer); got != c.want {
			t.Errorf("%s: ownScoped(%d, %q) on {UserID: %d, Username: %q} = %v, want %v", c.name, c.viewerID, c.viewer, in.UserID, in.Username, got, c.want)
		}
	}
	for _, c := range []struct {
		in   InfiniteInput
		want bool
	}{
		{InfiniteInput{PostID: 1}, true},
		{InfiniteInput{Input: Input{ModelID: 2}}, true},
		{InfiniteInput{Input: Input{ModelID: 2, ModelVersionID: 3}}, false},
		{InfiniteInput{UserID: 4, Input: Input{Tags: []int{1}}}, false},
	} {
		if got := c.in.dbPath(); got != c.want {
			t.Errorf("dbPath(%+v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestBlockedTags(t *testing.T) {
	got, err := ParseBlockedTags([]byte(`[{"id":5161,"name":"a"},{"id":5351,"name":"b"}]`))
	if err != nil || !reflect.DeepEqual(got, map[int]bool{5161: true, 5351: true}) {
		t.Fatalf("parse = %v, %v", got, err)
	}
	for _, bad := range []string{`null`, `{}`, `[{"id":1.5}]`, `[{"name":"no id"}]`, `not json`} {
		if _, err := ParseBlockedTags([]byte(bad)); fallback.Reason(err) != "blocked-tags-stale" {
			t.Errorf("%s: err %v, want blocked-tags-stale", bad, err)
		}
	}
	r := testkit.NewRedis()
	b := &BlockedTags{Cache: r, Prefix: "ns:"}
	if _, err := b.IDs(context.Background()); fallback.Reason(err) != "blocked-tags-miss" {
		t.Fatalf("absent key: %v", err)
	}
	r.SetString("ns:"+BlockedTagsKey, []byte(`[{"id":9,"name":"x"}]`))
	if got, err := b.IDs(context.Background()); err != nil || !reflect.DeepEqual(got, map[int]bool{9: true}) {
		t.Fatalf("ids = %v, %v", got, err)
	}
}

func TestParseBlockedTagNames(t *testing.T) {
	got, err := ParseBlockedTagNames([]byte(`[{"id":1,"name":"Foo"},{"id":2,"name":"bar"}]`))
	if err != nil || !reflect.DeepEqual(got, map[string]bool{"foo": true, "bar": true}) {
		t.Fatalf("%v %v", got, err)
	}
	for _, bad := range []string{`null`, `{}`, `[{"id":1}]`, `nope`} {
		if _, err := ParseBlockedTagNames([]byte(bad)); fallback.Reason(err) != "blocked-tags-stale" {
			t.Errorf("%s: %v", bad, err)
		}
	}
}

// Names and IDs share one memo (one read serves both), and an entry only one of them cannot use
// fails only that one.
func TestBlockedTagsNamesShareTheMemo(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(BlockedTagsKey, []byte(`[{"id":9,"name":"Mixed Case"},{"id":10}]`))
	b := &BlockedTags{Cache: r}
	ctx := context.Background()
	if _, err := b.Names(ctx); fallback.Reason(err) != "blocked-tags-stale" {
		t.Fatalf("names with a nameless entry: %v, want blocked-tags-stale", err)
	}
	if got, err := b.IDs(ctx); err != nil || !reflect.DeepEqual(got, map[int]bool{9: true, 10: true}) {
		t.Fatalf("ids = %v, %v", got, err)
	}
	// The memo holds the list read above: a new value is not read within the TTL.
	r.SetString(BlockedTagsKey, []byte(`[{"id":11,"name":"Other"}]`))
	if _, err := b.Names(ctx); fallback.Reason(err) != "blocked-tags-stale" {
		t.Fatalf("names within the TTL: %v, want the memoized list's blocked-tags-stale", err)
	}
	fresh := &BlockedTags{Cache: r}
	if got, err := fresh.Names(ctx); err != nil || !reflect.DeepEqual(got, map[string]bool{"other": true}) {
		t.Fatalf("names = %v, %v", got, err)
	}
}

// The blocked-tag list is memoized in-process for BlockedTagsTTL, as getBlockedBrowsingTags'
// createTtlMemo: a fresh list is served without a read, an expired one is read again, an error is
// never memoized, and concurrent callers of an expired memo share one read.
func TestBlockedTagsMemo(t *testing.T) {
	r := testkit.NewRedis()
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b := &BlockedTags{Cache: r, Now: func() time.Time { return clock }}
	ctx := context.Background()
	// An error is not memoized: the key absent twice is two reads.
	for i := 0; i < 2; i++ {
		if _, err := b.IDs(ctx); fallback.Reason(err) != "blocked-tags-miss" {
			t.Fatalf("absent key, call %d: %v", i, err)
		}
	}
	if r.Calls != 2 {
		t.Fatalf("reads after two misses = %d, want 2", r.Calls)
	}
	r.SetString(BlockedTagsKey, []byte(`[{"id":1,"name":"a"}]`))
	if got, err := b.IDs(ctx); err != nil || !reflect.DeepEqual(got, map[int]bool{1: true}) {
		t.Fatalf("first read = %v, %v", got, err)
	}
	// Within the TTL the cache is not read, so a changed key is not seen yet.
	r.SetString(BlockedTagsKey, []byte(`[{"id":2,"name":"b"}]`))
	clock = clock.Add(29 * time.Second)
	if got, err := b.IDs(ctx); err != nil || !reflect.DeepEqual(got, map[int]bool{1: true}) || r.Calls != 3 {
		t.Fatalf("within the TTL = %v, %v after %d reads; want the memo and 3 reads", got, err, r.Calls)
	}
	// Past it the next call reads the new list.
	clock = clock.Add(2 * time.Second)
	if got, err := b.IDs(ctx); err != nil || !reflect.DeepEqual(got, map[int]bool{2: true}) || r.Calls != 4 {
		t.Fatalf("past the TTL = %v, %v after %d reads; want the new list and 4 reads", got, err, r.Calls)
	}
	// A negative TTL turns the memo off (the control: every call reads).
	off := &BlockedTags{Cache: r, TTL: -1}
	_, _ = off.IDs(ctx)
	_, _ = off.IDs(ctx)
	if r.Calls != 6 {
		t.Fatalf("memo off: %d reads, want 6", r.Calls)
	}

	// Single flight: twenty callers of an empty memo, the read held long enough to overlap them all.
	slow := testkit.NewRedis()
	slow.SetString(BlockedTagsKey, []byte(`[{"id":3,"name":"c"}]`))
	slow.Delay = 100 * time.Millisecond
	shared := &BlockedTags{Cache: slow}
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := shared.IDs(ctx)
			if err == nil && !got[3] {
				err = errors.New("wrong list")
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if slow.Calls != 1 {
		t.Fatalf("concurrent callers made %d reads, want 1", slow.Calls)
	}
	// A caller that leaves does not fail the shared read, and gets its own context's error.
	gone := &BlockedTags{Cache: slow}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := gone.IDs(cctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled caller: %v", err)
	}
}

func TestInfiniteFilters(t *testing.T) {
	addons := []browsing.Addon{
		{Type: "some", NsfwLevels: []int{1}, DisablePoi: boolPtr(true), ExcludedTagIDs: []int{9901}},
		{Type: "some", NsfwLevels: []int{4, 8, 16}, DisableMinor: boolPtr(true), ExcludedTagIDs: []int{9911}},
	}
	in := &InfiniteInput{Input: Input{ExcludedTagIDs: []int{7, 7}, HideChallenges: true}}
	got := infiniteFilters(in, addons, 31, Viewer{}, "")
	want := AddonFilters{ExcludedTagIDs: []int{7, 9901, 9911, challengeTagID}, DisablePoi: true, DisableMinor: true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("signed out at 31 = %+v, want %+v", got, want)
	}
	// The viewer's own feed (by name): the tag exclusions stay off, POI and minor do not.
	in = &InfiniteInput{Username: "Me"}
	got = infiniteFilters(in, addons, 31, Viewer{ID: 3}, "me")
	if want := (AddonFilters{DisablePoi: true, DisableMinor: true}); !reflect.DeepEqual(got, want) {
		t.Fatalf("own feed = %+v, want %+v", got, want)
	}
	// A moderator: no addons at all; level 0 resolves at PG.
	got = infiniteFilters(&InfiniteInput{}, addons, 0, Viewer{ID: 3, IsModerator: true}, "")
	if want := (AddonFilters{}); !reflect.DeepEqual(got, want) {
		t.Fatalf("moderator = %+v, want %+v", got, want)
	}
	got = infiniteFilters(&InfiniteInput{}, addons, 0, Viewer{}, "")
	if want := (AddonFilters{ExcludedTagIDs: []int{9901}, DisablePoi: true}); !reflect.DeepEqual(got, want) {
		t.Fatalf("level 0 = %+v, want %+v", got, want)
	}
}

// --- ServeInfinite over fakes -------------------------------------------------------------------

// infFixture is ServeInfinite's world: a feed, the replica (page queries, the model rows), the cache
// (gallery settings, the blocked tags), a fixed hydration, the post/version/username lookups.
type infFixture struct {
	deps     *InfiniteDeps
	feed     *fakeFeed
	hydrator *recordingHydrator
	cache    *testkit.Redis
	rows     []RawImage
	sql      []string
	sqlArgs  [][]any
	models   map[int]string // model id -> mode ("" = live)
	pageErr  error
}

const infNow = "2024-03-02T09:00:00Z"

func newInfFixture(t *testing.T) *infFixture {
	t.Helper()
	now, _ := time.Parse(time.RFC3339, infNow)
	f := &infFixture{
		feed:     &fakeFeed{answers: map[string]feedsvc.Answer{}},
		hydrator: &recordingHydrator{page: &hydrate.Page{Basic: map[int]hydrate.BasicUser{5: {ID: 5, Username: "alice"}}}},
		cache:    testkit.NewRedis(),
		models:   map[int]string{},
	}
	sys := testkit.NewRedis()
	sys.SetString("system:browsing-setting-addons", []byte(`[{"type":"some","nsfwLevels":[1,2],"disablePoi":true,"excludedTagIds":[9901]}]`))
	f.cache.SetString(BlockedTagsKey, []byte(`[{"id":5161,"name":"blocked"}]`))
	db := &testkit.DB{Routes: []testkit.Route{
		{Match: `"cursorId"`, SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			f.sql = append(f.sql, sql)
			f.sqlArgs = append(f.sqlArgs, args)
			if f.pageErr != nil {
				return nil, f.pageErr
			}
			return infRows(f.rows, strings.Contains(sql, `JOIN ct ON ct."imageId" = i.id`)), nil
		}},
		{Match: `SELECT "userId", mode::text FROM "Model"`, Rows: func(args []any) (*testkit.Rows, error) {
			var out [][]any
			for _, id := range args[0].([]int) {
				if mode, ok := f.models[id]; ok {
					var m any
					if mode != "" {
						m = mode
					}
					out = append(out, []any{1, m})
				}
			}
			return testkit.NewRows([]string{"userId", "mode"}, out...), nil
		}},
	}}
	f.deps = &InfiniteDeps{
		Deps: &Deps{
			DB:       db,
			Hydrator: f.hydrator,
			Gallery:  &GalleryStore{Cache: f.cache, DB: db},
			Addons:   &AddonSource{Sys: sys},
			Feed:     f.feed,
			Config:   Config{ImageIndexFeed: true},
			Now:      func() time.Time { return now },
		},
		Sources: &fakeV1Sources{
			posts:     map[int]int{700: 60, 701: 0},
			versions:  map[int]int{60: 50, 61: 51},
			usernames: map[string]int{"alice": 5},
		},
		Blocked: &BlockedTags{Cache: f.cache},
	}
	return f
}

// infRows is the page query's answer over rows; collection: the query joined a collection, so each
// row also carries its item's note, status and adder (a row without RawImage.Collection: an ACCEPTED
// item with neither).
func infRows(rows []RawImage, collection bool) *testkit.Rows {
	cols := []string{"id", "name", "url", "nsfwLevel", "width", "height", "hash", "hideMeta", "hasMeta",
		"hasPositivePrompt", "onSite", "remixOfId", "createdAt", "sortAt", "mimeType", "type", "metadata",
		"ingestion", "blockedFor", "scannedAt", "needsReview", "userId", "postId", "postTitle", "index",
		"publishedAt", "unpublishedAt", "modelVersionId", "model3dId", "availability", "minor", "poi",
		"acceptableMinor", "restricted", "cursorId"}
	if collection {
		cols = append(cols, "collectionItemNote", "collectionItemStatus", "collectionItemAddedById")
	}
	ptr := func(p *int) any {
		if p == nil {
			return nil
		}
		return *p
	}
	data := make([][]any, 0, len(rows))
	for _, r := range rows {
		var meta, cursor any
		if r.Metadata != nil {
			meta = string(r.Metadata)
		}
		if !r.CursorNull {
			cursor = r.CursorID
		}
		var published any
		if r.PublishedAt != nil {
			published = *r.PublishedAt
		}
		cells := []any{r.ID, nil, strOrNil(r.URL), r.NsfwLevel, ptr(r.Width), ptr(r.Height), strOrNil(r.Hash),
			false, true, true, nil, nil, r.SortAt, r.SortAt, nil, r.Type, meta, "Scanned", nil, nil, nil, r.UserID,
			r.PostID, nil, ptr(r.Index), published, nil, nil, nil, r.Availability, false, false, false, false, cursor}
		if collection {
			item := CollectionItem{Status: "ACCEPTED"}
			if r.Collection != nil {
				item = *r.Collection
			}
			cells = append(cells, strOrNil(item.Note), item.Status, ptr(item.AddedByID))
		}
		data = append(data, cells)
	}
	return testkit.NewRows(cols, data...)
}

func infRow(id, postID int) RawImage {
	r := row(id, postID, "image", "u", 1, "")
	r.Availability, r.CursorID = "Public", id
	return r
}

// serveInf runs one request and decodes the answer's json and annotations.
func serveInf(t *testing.T, f *infFixture, m map[string]any, req InfiniteRequest) (map[string]any, map[string]any, *InfiniteAnswer, error) {
	t.Helper()
	in, err := ParseInfinite(m)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	req.Input = in
	ans, err := ServeInfinite(context.Background(), f.deps, req)
	if err != nil {
		return nil, nil, nil, err
	}
	raw, err := superjson.Serialize(ans.Value)
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		JSON map[string]any `json:"json"`
		Meta struct {
			Values map[string]any `json:"values"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	return env.JSON, env.Meta.Values, ans, nil
}

func itemIDs(j map[string]any) []float64 {
	items, _ := j["items"].([]any)
	out := make([]float64, 0, len(items))
	for _, it := range items {
		out = append(out, it.(map[string]any)["id"].(float64))
	}
	return out
}

func TestServeInfiniteFeedPage(t *testing.T) {
	f := newInfFixture(t)
	f.rows = []RawImage{infRow(11, 100), infRow(10, 100), infRow(12, 100)}
	const q = "levels=1&tags=7&excludedTags=9901&userIds=5&excludePoi=1&sort=newest&limit=3"
	f.feed.answers[q] = feedsvc.Answer{Status: 200, IDs: []int{10, 12, 11}, NextCursor: "1700000000000|11"}
	j, ann, ans, err := serveInf(t, f, map[string]any{
		"username": "alice", "tags": []any{num("7"), num("5161")}, "sort": "Newest", "limit": num("3"),
	}, InfiniteRequest{Cap: 1})
	if err != nil {
		t.Fatalf("serve: %v (queries %v)", err, f.feed.queries)
	}
	if !reflect.DeepEqual(f.feed.queries, []string{q}) {
		t.Fatalf("feed queries = %v", f.feed.queries)
	}
	// The feed's order, its cursor, the source; nothing trivial about it.
	if got := itemIDs(j); !reflect.DeepEqual(got, []float64{10, 12, 11}) || j["nextCursor"] != "feed:1700000000000:11" || j["source"] != "feed" || ans.Trivial {
		t.Fatalf("answer ids %v next %v source %v trivial %v", got, j["nextCursor"], j["source"], ans.Trivial)
	}
	// The flat wire: the gallery's fields plus availability, meta, judgeScore, and an undefined baseModel.
	first := j["items"].([]any)[0].(map[string]any)
	if first["availability"] != "Public" || first["meta"] != nil || first["judgeScore"] != nil {
		t.Fatalf("infinite wire fields: %v", first)
	}
	for _, k := range []string{"meta", "judgeScore", "availability", "cosmetic", "eventDecoration"} {
		if _, ok := first[k]; !ok {
			t.Errorf("%s missing from the wire", k)
		}
	}
	if v, ok := first["baseModel"]; !ok || v != nil {
		t.Errorf("baseModel = %v (present %v), want undefined: null plus its annotation", v, ok)
	}
	if a, _ := ann["items.0.baseModel"].([]any); len(a) != 1 || a[0] != "undefined" {
		t.Fatalf("baseModel annotation = %v", ann["items.0.baseModel"])
	}
	if pp := first["user"].(map[string]any)["profilePicture"]; pp != nil {
		t.Fatalf("profilePicture = %v, want null (not in include)", pp)
	}
	if !f.hydrator.req.NoProfilePictures {
		t.Fatal("the hydration must skip profile pictures without the include")
	}
	// The hydrate: the feed's ids, the creator and the tag scope (blocked tag stripped), no paging.
	if len(f.sql) != 1 {
		t.Fatalf("page queries = %d, want 1", len(f.sql))
	}
	mustContain(t, f.sql[0], `i."id" = ANY($`, `WHERE "tagId" = ANY($`, ` AND i."userId" = $`, `ORDER BY i."id" DESC`)
	if strings.Contains(f.sql[0], `date_trunc`) || strings.Contains(f.sql[0], `"index" >=`) {
		t.Fatalf("hydrate carries a period or a cursor: %s", f.sql[0])
	}
	found := false
	for _, a := range f.sqlArgs[0] {
		found = found || reflect.DeepEqual(a, []int{7})
	}
	if !found {
		t.Fatalf("the stripped tag list [7] is not bound: %v", f.sqlArgs[0])
	}
}

func TestServeInfiniteEmptyAnswers(t *testing.T) {
	const handlerEmpty = `{"items":[],"nextCursor":null}|{"nextCursor":["undefined"]}`
	cases := []struct {
		name     string
		m        map[string]any
		setup    func(*infFixture)
		want     string // json|meta.values
		trivial  bool
		uncapped bool
		viewer   *Viewer
		noQuery  bool
	}{
		{
			name:  "a withheld version",
			m:     map[string]any{"modelVersionId": num("60")},
			setup: func(f *infFixture) { f.models[50] = "TakenDown" },
			want:  handlerEmpty, trivial: true,
		},
		{
			name: "a version that cannot be found",
			m:    map[string]any{"modelVersionId": num("99")},
			want: handlerEmpty, trivial: true,
		},
		{
			name: "a fully held model",
			m:    map[string]any{"modelVersionId": num("61"), "browsingLevel": num("4")},
			setup: func(f *infFixture) {
				f.cache.SetString("model:gallery-settings:51", []byte(`{"level":3,"sfwHeld":true,"pinnedPosts":{}}`))
			},
			want: handlerEmpty, trivial: true, uncapped: true,
		},
		{
			name: "only blocked tags (index path: no source)",
			m:    map[string]any{"tags": []any{num("5161")}},
			want: `{"items":[],"nextCursor":null}|{"nextCursor":["undefined"]}`, trivial: true,
		},
		{
			name:  "only blocked tags (Postgres path: the handler's source)",
			m:     map[string]any{"tags": []any{num("5161")}, "postId": num("701")},
			setup: func(f *infFixture) {},
			want:  `{"items":[],"nextCursor":null,"source":"db"}|{"nextCursor":["undefined"]}`, trivial: true,
		},
		{
			name: "a moderator's level of unselectable bits only (Postgres path)",
			m:    map[string]any{"postId": num("701"), "browsingLevel": num("32")},
			want: `{"items":[],"nextCursor":null,"source":"db"}|{"nextCursor":["undefined"]}`, trivial: true,
			uncapped: true, viewer: &Viewer{ID: 7, IsModerator: true}, noQuery: true,
		},
		{
			name: "a signed-in level asks the feed at its selectable part",
			m:    map[string]any{"limit": num("2"), "browsingLevel": num("33")},
			setup: func(f *infFixture) {
				f.feed.answers["levels=1&excludedTags=9901&excludePoi=1&viewerId=7&sort=reactions&limit=2"] = feedsvc.Answer{Status: 200, NextCursor: "9|9"}
			},
			want: `{"items":[],"nextCursor":"feed:9:9","source":"feed"}|null`, trivial: true,
			uncapped: true, viewer: &Viewer{ID: 7},
		},
		{
			name:     "a signed-in level of unselectable bits only",
			m:        map[string]any{"limit": num("2"), "browsingLevel": num("32")},
			want:     `{"items":[],"nextCursor":null,"source":"feed"}|{"nextCursor":["undefined"]}`,
			trivial:  true,
			uncapped: true, viewer: &Viewer{ID: 7},
		},
		{
			name: "a shape the feed cannot express",
			m:    map[string]any{"generation": []any{"txt2img"}},
			want: `{"items":[],"nextCursor":null,"source":"feed"}|{"nextCursor":["undefined"]}`, trivial: true,
		},
		{
			name: "a feed page with no ids keeps its cursor",
			m:    map[string]any{"limit": num("2")},
			setup: func(f *infFixture) {
				f.feed.answers["levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=2"] = feedsvc.Answer{Status: 200, NextCursor: "9|9"}
			},
			want: `{"items":[],"nextCursor":"feed:9:9","source":"feed"}|null`, trivial: true,
		},
	}
	for _, c := range cases {
		f := newInfFixture(t)
		if c.setup != nil {
			c.setup(f)
		}
		req := InfiniteRequest{Cap: 1}
		if c.uncapped {
			req.Cap = 0
		}
		req.Viewer = c.viewer
		j, ann, ans, err := serveInf(t, f, c.m, req)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		jb, _ := json.Marshal(j)
		ab, _ := json.Marshal(ann)
		if c.noQuery && len(f.sql) != 0 {
			t.Errorf("%s: page queries %d, want none", c.name, len(f.sql))
		}
		if got := string(jb) + "|" + string(ab); got != c.want || ans.Trivial != c.trivial {
			t.Errorf("%s: %s trivial=%v, want %s trivial=%v", c.name, got, ans.Trivial, c.want, c.trivial)
		}
	}
}

func TestServeInfiniteFallbacks(t *testing.T) {
	cases := []struct {
		name  string
		m     map[string]any
		setup func(*infFixture)
		want  string
	}{
		{"no feed service", nil, func(f *infFixture) { f.deps.Feed = nil }, "index-feed-unconfigured"},
		{"an unparsed cursor", map[string]any{"cursor": "nope"}, nil, "feed-cursor:unparsed"},
		{"a feed failure", nil, func(f *infFixture) { f.feed.err = errors.New("down") }, "feed-unavailable"},
		{"a feed refusal", nil, nil, "feed-status"}, // fakeFeed answers 400 to an unknown query
		{"an unknown username", map[string]any{"username": "zed"}, nil, "username-miss"},
		{"no blocked-tag reader", map[string]any{"tags": []any{num("1")}}, func(f *infFixture) { f.deps.Blocked = nil }, "blocked-tags-unconfigured"},
		{"the blocked-tag key absent", map[string]any{"tags": []any{num("1")}}, func(f *infFixture) { f.deps.Blocked = &BlockedTags{Cache: testkit.NewRedis()} }, "blocked-tags-miss"},
		{"a held model with no level", map[string]any{"modelVersionId": num("61")}, func(f *infFixture) {
			f.cache.SetString("model:gallery-settings:51", []byte(`{"sfwHeld":true,"pinnedPosts":{}}`))
		}, "held-level-unset"},
		{"a feed cursor on the Postgres path", map[string]any{"postId": num("701"), "cursor": "feed:1:2"}, nil, "input-cursor"},
		{"an emptied hydrate", map[string]any{"limit": num("2")}, func(f *infFixture) {
			f.feed.answers["levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=2"] = feedsvc.Answer{Status: 200, IDs: []int{40}}
		}, "feed-hydrate-empty"},
		{"a failed hydrate", map[string]any{"limit": num("2")}, func(f *infFixture) {
			f.feed.answers["levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=2"] = feedsvc.Answer{Status: 200, IDs: []int{40}}
			f.pageErr = errors.New("replica down")
		}, "feed-hydrate-error"},
		{"a hydration fallback keeps its own reason", map[string]any{"limit": num("2")}, func(f *infFixture) {
			f.feed.answers["levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=2"] = feedsvc.Answer{Status: 200, IDs: []int{11}}
			f.rows = []RawImage{infRow(11, 100)}
			f.hydrator.pageErr = fallback.New("metrics-miss")
		}, "metrics-miss"},
	}
	for _, c := range cases {
		f := newInfFixture(t)
		if c.setup != nil {
			c.setup(f)
		}
		m := c.m
		if m == nil {
			m = map[string]any{}
		}
		_, _, _, err := serveInf(t, f, m, InfiniteRequest{Cap: 1})
		if got := fallback.Reason(err); got != c.want {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.want)
		}
	}
}

func TestServeInfinitePostScopeIsThePostgresPage(t *testing.T) {
	f := newInfFixture(t)
	idx := func(n int) *int { return &n }
	a, b, c := infRow(21, 701), infRow(22, 701), infRow(23, 701)
	a.Index, b.Index, c.Index = idx(0), idx(1), idx(2)
	a.CursorID, b.CursorID, c.CursorID = 0, 1, 2
	f.rows = []RawImage{a, b, c}
	j, _, ans, err := serveInf(t, f, map[string]any{"postId": num("701"), "limit": num("2"), "cursor": num("1"), "include": []any{"cosmetics", "profilePictures"}}, InfiniteRequest{Cap: 1, Viewer: &Viewer{ID: 9}, ViewerUsername: "nine"})
	if err != nil {
		t.Fatal(err)
	}
	if len(f.feed.queries) != 0 {
		t.Fatalf("a post scope must not ask the feed: %v", f.feed.queries)
	}
	// Two images and the look-ahead row's index as the cursor; the handler's source.
	if got := itemIDs(j); !reflect.DeepEqual(got, []float64{21, 22}) || j["nextCursor"] != float64(2) || j["source"] != "db" || ans.Trivial {
		t.Fatalf("answer ids %v next %v source %v trivial %v", got, j["nextCursor"], j["source"], ans.Trivial)
	}
	mustContain(t, f.sql[0], `i."postId" = $`, `i."index" "cursorId"`, `((i."index" >= $`, `ORDER BY i."index", i."id"`)
	if f.hydrator.req.NoProfilePictures {
		t.Fatal("profile pictures were asked for")
	}
	// A NULL index on the look-ahead row is a null cursor, an index of 0 a 0.
	c.CursorID, c.CursorNull = 0, true
	f.rows = []RawImage{a, b, c}
	j, ann, _, err := serveInf(t, f, map[string]any{"postId": num("701"), "limit": num("2")}, InfiniteRequest{Cap: 1})
	if err != nil {
		t.Fatal(err)
	}
	// A real null: written as null with NO ["undefined"] annotation (an undefined is null plus one).
	if v, ok := j["nextCursor"]; !ok || v != nil || ann["nextCursor"] != nil {
		t.Fatalf("null index cursor = %v (present %v, annotation %v)", v, ok, ann["nextCursor"])
	}
	c.CursorNull = false
	f.rows = []RawImage{a, b, c}
	j, _, _, err = serveInf(t, f, map[string]any{"postId": num("701"), "limit": num("2")}, InfiniteRequest{Cap: 1})
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := j["nextCursor"]; !ok || v != float64(0) {
		t.Fatalf("index-0 cursor = %v (present %v)", v, ok)
	}
	// The end of the post: no look-ahead row, an undefined cursor.
	f.rows = []RawImage{a}
	j, ann, _, err = serveInf(t, f, map[string]any{"postId": num("701"), "limit": num("2")}, InfiniteRequest{Cap: 1})
	if err != nil {
		t.Fatal(err)
	}
	// Undefined, as Node's superjson writes it: null in json plus the ["undefined"] annotation.
	if v, ok := j["nextCursor"]; !ok || v != nil {
		t.Fatalf("end of post: nextCursor = %v (present %v), want null", v, ok)
	}
	if a, _ := ann["nextCursor"].([]any); len(a) != 1 || a[0] != "undefined" {
		t.Fatalf("end of post: nextCursor annotation = %v, want [undefined]", ann["nextCursor"])
	}
}

func TestServeInfiniteModeratorSkipsTheGates(t *testing.T) {
	f := newInfFixture(t)
	f.models[50] = "TakenDown"
	f.rows = []RawImage{infRow(11, 700)}
	const q = "levels=1%2C2%2C4%2C8%2C16&versionIds=60&sort=reactions&limit=5"
	f.feed.answers[q] = feedsvc.Answer{Status: 200, IDs: []int{11}}
	j, _, _, err := serveInf(t, f, map[string]any{"modelVersionId": num("60"), "limit": num("5"), "browsingLevel": num("31")},
		InfiniteRequest{Viewer: &Viewer{ID: 1, IsModerator: true}})
	if err != nil {
		t.Fatalf("serve: %v (queries %v)", err, f.feed.queries)
	}
	if got := itemIDs(j); !reflect.DeepEqual(got, []float64{11}) {
		t.Fatalf("ids = %v", got)
	}
}

func TestBuildTagScopeAndIndexOrder(t *testing.T) {
	q := ImagesQuery{Limit: 2, Sort: SortNewest, BrowsingLevel: 1, ModelVersionID: 9, TagIDs: []int{4, 5}}
	b := q.Build()
	mustContain(t, b.SQL, `i.id IN (`, `FROM "TagsOnImageDetails"`, `WHERE "tagId" = ANY($`, `AND "disabled" = FALSE`)
	if b.CacheTTL != 0 || b.CacheTags != nil {
		t.Fatalf("a tag scope is personalized (never cached): %+v", b)
	}
	q = ImagesQuery{Limit: 2, Sort: SortOldest, BrowsingLevel: 1, PostID: 3, IndexOrder: true, Cursor: 4}
	b = q.Build()
	mustContain(t, b.SQL, `i."index" "cursorId"`, `((i."index" >= $`, `ORDER BY i."index", i."id"`)
	if strings.Contains(b.SQL, `ORDER BY i."id" ASC`) {
		t.Fatal("a post's media ignore the sort")
	}
}

func TestBuildInfiniteImagesAddsTheInfiniteWireFields(t *testing.T) {
	r := infRow(11, 100)
	images := BuildInfiniteImages([]RawImage{r}, &Hydrated{}, Viewer{}, published.Add(time.Hour))
	if len(images) != 1 {
		t.Fatalf("images = %d", len(images))
	}
	// The Node object's key order (an image.getInfinite item of the Node goldens): the devalue body
	// writes keys in this order, so it is part of the bytes.
	want := []string{"id", "name", "url", "nsfwLevel", "width", "height", "hash", "hasMeta", "hasPositivePrompt",
		"onSite", "remixOfId", "createdAt", "sortAt", "type", "metadata", "ingestion", "blockedFor", "needsReview",
		"postId", "index", "publishedAt", "modelVersionId", "model3dId", "availability", "minor", "poi", "restricted",
		"meta", "modelVersionIds", "modelVersionIdsManual", "baseModel", "user", "stats", "reactions", "tags", "tagIds",
		"cosmetic", "eventDecoration", "thumbnailUrl", "judgeScore"}
	if keys := wireKeys(images[0].Wire); !reflect.DeepEqual(keys, want) {
		t.Fatalf("keys = %v\nwant   %v", keys, want)
	}
	if v, _ := images[0].Wire.Get("availability"); v != "Public" {
		t.Fatalf("availability = %v", v)
	}
	if v, _ := images[0].Wire.Get("baseModel"); v != (superjson.Undefined{}) {
		t.Fatalf("baseModel = %v", v)
	}
	// The gallery wire is not touched (BuildImages' own slice keeps its length).
	if g := BuildImages([]RawImage{r}, &Hydrated{}, Viewer{}, published.Add(time.Hour)); len(g[0].Wire) != len(images[0].Wire)-4 {
		t.Fatalf("gallery wire %d keys, infinite %d", len(g[0].Wire), len(images[0].Wire))
	}
	// An unpublished image of someone else is dropped, as in the gallery.
	r.PublishedAt = nil
	if got := BuildInfiniteImages([]RawImage{r}, &Hydrated{}, Viewer{ID: 99}, published); len(got) != 0 {
		t.Fatalf("unpublished image kept: %v", got)
	}
}

// `include: ['tags']`: the hydration is asked for the votable tags (PageRequest.Tags) and each image
// carries what it answered, an image it answered none for `tags: undefined`; without the include the
// hydration is not asked for them. Regression: before the port the request fell back (input-include).
func TestServeInfiniteIncludeTags(t *testing.T) {
	const q = "levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=2"
	for _, include := range []bool{true, false} {
		f := newInfFixture(t)
		f.feed.answers[q] = feedsvc.Answer{Status: 200, IDs: []int{11, 12}}
		f.rows = []RawImage{infRow(11, 100), infRow(12, 100)}
		f.hydrator.page.Tags = map[int][]any{11: {superjson.Object{{Key: "id", Val: int64(21)}, {Key: "name", Val: "red"}}}}
		m := map[string]any{"limit": num("2")}
		if include {
			m["include"] = []any{"cosmetics", "tags"}
		}
		j, ann, _, err := serveInf(t, f, m, InfiniteRequest{Cap: 1})
		if err != nil {
			t.Fatalf("include %v: serve: %v (queries %v)", include, err, f.feed.queries)
		}
		if f.hydrator.req.Tags != include {
			t.Fatalf("include %v: hydration asked for tags = %v", include, f.hydrator.req.Tags)
		}
		items := j["items"].([]any)
		if len(items) != 2 {
			t.Fatalf("include %v: %d items", include, len(items))
		}
		// The page's tags reach the wire only through the hydration's answer: the recording hydrator
		// answers them either way, so without the include they must still be ignored.
		tags, ok := items[0].(map[string]any)["tags"]
		if include {
			list, _ := tags.([]any)
			if !ok || len(list) != 1 || list[0].(map[string]any)["name"] != "red" {
				t.Fatalf("image 11 tags = %v, want the hydration's", tags)
			}
		} else if a, _ := ann["items.0.tags"].([]any); ok && tags != nil || len(a) != 1 || a[0] != "undefined" {
			t.Fatalf("without the include: image 11 tags = %v (annotation %v), want undefined", tags, ann["items.0.tags"])
		}
		if a, _ := ann["items.1.tags"].([]any); len(a) != 1 || a[0] != "undefined" {
			t.Fatalf("include %v: image 12 tags annotation = %v, want undefined", include, ann["items.1.tags"])
		}
	}
}
