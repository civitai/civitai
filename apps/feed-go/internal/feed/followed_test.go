package feed

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
)

// followedSQL is the page query's follow clause (getAllImagesUncaptured's `i."userId" IN (…)`).
const followedSQL = `i."userId" = ANY($`

// boundInts reports whether args binds exactly want as one list.
func boundInts(args []any, want []int) bool {
	for _, a := range args {
		if reflect.DeepEqual(a, want) {
			return true
		}
	}
	return false
}

// `followed: true` parses on image.getInfinite (Followed) and only as a boolean; false or null is no
// filter; the posts gallery still falls back on it. Regression: before the port every `followed: true`
// fell back with input-followed.
func TestParseInfiniteFollowed(t *testing.T) {
	in, err := ParseInfinite(parseObj(t, `{"followed":true,"limit":3}`))
	if err != nil {
		t.Fatalf("followed: true: reason %q (err %v), want it parsed", fallback.Reason(err), err)
	}
	if !in.Followed {
		t.Fatal("followed: true parsed without Followed")
	}
	for _, input := range []string{`{}`, `{"followed":false}`, `{"followed":null}`} {
		in, err := ParseInfinite(parseObj(t, input))
		if err != nil || in.Followed {
			t.Errorf("ParseInfinite %s: err %v, Followed %v; want parsed without it", input, err, in != nil && in.Followed)
		}
	}
	// z.boolean() is not coerced: anything else is the schema's BAD_REQUEST, which Node answers.
	for _, input := range []string{`{"followed":"true"}`, `{"followed":1}`, `{"followed":[true]}`} {
		_, err := ParseInfinite(parseObj(t, input))
		if fallback.Reason(err) != "input-invalid" || fallback.SafeDetail(err) != "followed" {
			t.Errorf("ParseInfinite %s: reason %q detail %q, want input-invalid / followed", input, fallback.Reason(err), fallback.SafeDetail(err))
		}
	}
	// The gallery is not widened.
	if _, err := Parse(parseObj(t, `{"followed":true}`)); fallback.Reason(err) != "input-followed" {
		t.Errorf("Parse followed: reason %q (err %v), want input-followed", fallback.Reason(err), err)
	}
}

// Signed in on the feed path: the viewer's follow list is read once, sent as the feed's `userIds`, and
// bound into the hydrate's page query as the follow clause (never cached); the feed's page is the
// answer. Regression: before the port this request fell back (input-followed).
func TestServeInfiniteFollowedFeedPath(t *testing.T) {
	f := newInfFixture(t)
	f.deps.Sources.(*fakeV1Sources).follows = map[int][]int{9: {6, 5}}
	const q = "levels=1&excludedTags=9901&userIds=6%2C5&excludePoi=1&viewerId=9&sort=newest&limit=2"
	f.feed.answers[q] = feedsvc.Answer{Status: 200, IDs: []int{12, 11}, NextCursor: "1700000000000|11"}
	f.rows = []RawImage{infRow(11, 100), infRow(12, 100)}
	j, _, ans, err := serveInf(t, f, map[string]any{"followed": true, "sort": "Newest", "limit": num("2")},
		InfiniteRequest{Cap: 1, Viewer: &Viewer{ID: 9}, ViewerUsername: "nine"})
	if err != nil {
		t.Fatalf("serve: %v (queries %v)", err, f.feed.queries)
	}
	if !reflect.DeepEqual(f.feed.queries, []string{q}) {
		t.Fatalf("feed queries = %v, want [%s]", f.feed.queries, q)
	}
	if got := itemIDs(j); !reflect.DeepEqual(got, []float64{12, 11}) || j["nextCursor"] != "feed:1700000000000:11" || j["source"] != "feed" || ans.Trivial {
		t.Fatalf("answer ids %v next %v source %v trivial %v", got, j["nextCursor"], j["source"], ans.Trivial)
	}
	if got := f.deps.Sources.(*fakeV1Sources).followsAsked; !reflect.DeepEqual(got, []int{9}) {
		t.Fatalf("follow reads %v, want one for the viewer 9", got)
	}
	if len(f.sql) != 1 || !strings.Contains(f.sql[0], followedSQL) || !boundInts(f.sqlArgs[0], []int{6, 5}) {
		t.Fatalf("hydrate query without the follow clause over [6 5]:\n%v\nargs %v", f.sql, f.sqlArgs)
	}
}

// Signed out, `followed` is dropped on both paths: no follow read, no `userIds`, no clause; the answer
// is the request's without it.
func TestServeInfiniteFollowedSignedOut(t *testing.T) {
	for _, dbPath := range []bool{false, true} {
		f := newInfFixture(t)
		const q = "levels=1&excludedTags=9901&excludePoi=1&sort=newest&limit=2"
		f.feed.answers[q] = feedsvc.Answer{Status: 200, IDs: []int{11}}
		f.rows = []RawImage{infRow(11, 100)}
		m := map[string]any{"followed": true, "sort": "Newest", "limit": num("2")}
		if dbPath {
			m["postId"] = num("701")
		}
		if _, _, _, err := serveInf(t, f, m, InfiniteRequest{Cap: 1}); err != nil {
			t.Fatalf("db path %v: %v", dbPath, err)
		}
		if got := f.deps.Sources.(*fakeV1Sources).followsAsked; len(got) != 0 {
			t.Fatalf("db path %v: a signed-out request read follows %v", dbPath, got)
		}
		if dbPath != (len(f.feed.queries) == 0) || (!dbPath && f.feed.queries[0] != q) {
			t.Fatalf("db path %v: feed queries %v", dbPath, f.feed.queries)
		}
		if len(f.sql) != 1 || strings.Contains(f.sql[0], followedSQL) {
			t.Fatalf("db path %v: page query %v, want one without a follow clause", dbPath, f.sql)
		}
	}
}

// The feed path's empty pages: no follows (serveFromFeed's own, before it maps the input, so even an
// unparsable cursor is answered with it), more than MAX_FOLLOWED, or a creator scope beside the
// follows (the mapper's refusals, ahead of its sort check). Each is `{items: [], nextCursor:
// undefined, source: 'feed'}` without a feed call or a page query.
func TestServeInfiniteFollowedEmptyFeedPages(t *testing.T) {
	long := make([]int, feedsvc.MaxFollowed+1)
	for i := range long {
		long[i] = i + 1
	}
	for _, c := range []struct {
		name    string
		follows []int
		m       map[string]any
	}{
		{"no follows", nil, map[string]any{"followed": true, "cursor": "not-a-cursor"}},
		{"too many follows", long, map[string]any{"followed": true}},
		{"a creator beside them", []int{6}, map[string]any{"followed": true, "userId": num("5"), "cursor": "not-a-cursor"}},
		{"a creator by name beside them", []int{6}, map[string]any{"followed": true, "username": "alice"}},
	} {
		f := newInfFixture(t)
		if c.follows != nil {
			f.deps.Sources.(*fakeV1Sources).follows = map[int][]int{9: c.follows}
		}
		j, ann, ans, err := serveInf(t, f, c.m, InfiniteRequest{Cap: 1, Viewer: &Viewer{ID: 9}, ViewerUsername: "nine"})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		items, _ := j["items"].([]any)
		next, _ := ann["nextCursor"].([]any)
		if items == nil || len(items) != 0 || j["source"] != "feed" || len(next) != 1 || next[0] != "undefined" || !ans.Trivial {
			t.Fatalf("%s: answer %v (meta %v, trivial %v), want the empty feed page", c.name, j, ann, ans.Trivial)
		}
		if len(f.feed.queries) != 0 || len(f.sql) != 0 {
			t.Fatalf("%s: feed queries %v, page queries %d; want none", c.name, f.feed.queries, len(f.sql))
		}
	}
	// Control: the same unparsable cursor with a follow list is the mapper's BAD_REQUEST, so the empty
	// page above did come before the mapping.
	f := newInfFixture(t)
	f.deps.Sources.(*fakeV1Sources).follows = map[int][]int{9: {6}}
	_, _, _, err := serveInf(t, f, map[string]any{"followed": true, "cursor": "not-a-cursor"}, InfiniteRequest{Cap: 1, Viewer: &Viewer{ID: 9}})
	if got := fallback.Reason(err); got != "feed-cursor:unparsed" {
		t.Fatalf("followed with a cursor the feed cannot read: reason %q (%v), want feed-cursor:unparsed", got, err)
	}
}

// The Postgres path (a post's media): the follow list bound as the page query's clause, and no clause
// for an empty list (`prefetchedUserFollows?.length`: the unfiltered page, not an empty one). A list
// past the bound falls back; a failed follow read is the request's error.
func TestServeInfiniteFollowedPostgresPath(t *testing.T) {
	for _, c := range []struct {
		name    string
		follows []int
		clause  bool
	}{
		{"follows", []int{5, 7}, true},
		{"no follows", nil, false},
	} {
		f := newInfFixture(t)
		if c.follows != nil {
			f.deps.Sources.(*fakeV1Sources).follows = map[int][]int{9: c.follows}
		}
		f.rows = []RawImage{infRow(21, 701)}
		j, _, _, err := serveInf(t, f, map[string]any{"followed": true, "postId": num("701"), "limit": num("2")},
			InfiniteRequest{Cap: 1, Viewer: &Viewer{ID: 9}, ViewerUsername: "nine"})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if j["source"] != "db" || len(f.feed.queries) != 0 {
			t.Fatalf("%s: source %v, feed queries %v; want the Postgres page", c.name, j["source"], f.feed.queries)
		}
		if len(f.sql) != 1 || strings.Contains(f.sql[0], followedSQL) != c.clause || (c.clause && !boundInts(f.sqlArgs[0], c.follows)) {
			t.Fatalf("%s: page query %v args %v, want the follow clause %v", c.name, f.sql, f.sqlArgs, c.clause)
		}
	}

	long := make([]int, maxFollowedBinds+1)
	f := newInfFixture(t)
	f.deps.Sources.(*fakeV1Sources).follows = map[int][]int{9: long}
	_, _, _, err := serveInf(t, f, map[string]any{"followed": true, "postId": num("701")}, InfiniteRequest{Cap: 1, Viewer: &Viewer{ID: 9}})
	if fallback.Reason(err) != "followed-db-many" || fallback.SafeDetail(err) != "10001" || len(f.sql) != 0 {
		t.Fatalf("a follow list past the bind bound: reason %q detail %q (%v), page queries %d; want followed-db-many / 10001",
			fallback.Reason(err), fallback.SafeDetail(err), err, len(f.sql))
	}

	f = newInfFixture(t)
	readErr := fallback.New("user-follows-miss")
	f.deps.Sources.(*fakeV1Sources).followsErr = readErr
	_, _, _, err = serveInf(t, f, map[string]any{"followed": true}, InfiniteRequest{Cap: 1, Viewer: &Viewer{ID: 9}})
	if !errors.Is(err, readErr) || len(f.feed.queries) != 0 {
		t.Fatalf("a failed follow read: err %v, feed queries %v; want that error and no feed call", err, f.feed.queries)
	}
}

// Inputs `followed` does not widen still fall back, as before the port: a hub, the viewer's hidden
// images beside it, and a Hat Turf sort. (`newCreators` beside it is answered: an empty page,
// TestServeInfiniteNewCreatorsEmptyAnswers.)
func TestServeInfiniteFollowedStillFallsBack(t *testing.T) {
	for input, reason := range map[string]string{
		`{"followed":true,"hubId":7}`:        "input-hubId",
		`{"followed":true,"hidden":true}`:    "input-hidden",
		`{"followed":true,"hatSort":"most"}`: "infinite-hat-turf",
	} {
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != reason {
			t.Errorf("ParseInfinite %s: reason %q (err %v), want %q", input, fallback.Reason(err), err, reason)
		}
	}
}

// The follow clause: `i."userId" = ANY(<follows>)` after the creator clause and before the tag scope
// (getAllImagesUncaptured's order), the list bound as given; the query is personalized (never
// cached), so a version gallery that is cached without it is not with it. No list, no clause.
func TestBuildFollowed(t *testing.T) {
	b := (&ImagesQuery{Limit: 5, Sort: SortNewest, BrowsingLevel: 1, ModelVersionID: 60, TargetUserID: 5, TagIDs: []int{7},
		FollowedUserIDs: []int{6, 5, 8}}).Build()
	creator := strings.Index(b.SQL, `AND i."userId" = $`)
	followed := strings.Index(b.SQL, followedSQL)
	tags := strings.Index(b.SQL, `WHERE "tagId" = ANY($`)
	if creator < 0 || followed < 0 || tags < 0 || creator >= followed || followed >= tags {
		t.Fatalf("clause order creator %d, followed %d, tags %d:\n%s", creator, followed, tags, b.SQL)
	}
	if !boundInts(b.Args, []int{6, 5, 8}) {
		t.Fatalf("the follow list is not bound as given: %v", b.Args)
	}
	b = (&ImagesQuery{Limit: 5, BrowsingLevel: 1, ModelVersionID: 60, FollowedUserIDs: []int{6}}).Build()
	if b.CacheTTL != 0 || b.CacheTags != nil {
		t.Fatalf("a follow set is personalized (never cached): ttl %v tags %v", b.CacheTTL, b.CacheTags)
	}
	// Positive control: the same version gallery without it is cached, and carries no follow clause.
	b = (&ImagesQuery{Limit: 5, BrowsingLevel: 1, ModelVersionID: 60}).Build()
	if b.CacheTTL != 10*time.Minute || strings.Contains(b.SQL, followedSQL) {
		t.Fatalf("control: ttl %v, follow clause %v", b.CacheTTL, strings.Contains(b.SQL, followedSQL))
	}
}
