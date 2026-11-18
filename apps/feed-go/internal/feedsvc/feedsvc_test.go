package feedsvc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

// Expected strings are what mapSearchInputToFeedQuery's URLSearchParams.toString() writes for the
// same input (keys in insertion order, `,` as %2C and `|` as %7C).
func TestMapQueries(t *testing.T) {
	cases := []struct {
		name string
		q    Query
		want string
	}{
		{
			name: "first page of a version gallery, signed in, poi excluded",
			q: Query{BrowsingLevel: 31, ExcludedTagIDs: []int{5161, 5162}, ModelID: 7, ModelVersionID: 9,
				DisablePoi: true, ViewerID: 42, Sort: "Most Reactions", Period: "AllTime", Limit: 100},
			want: "levels=1%2C2%2C4%2C8%2C16&excludedTags=5161%2C5162&versionIds=9&excludePoi=1&viewerId=42&sort=reactions&limit=100",
		},
		{
			name: "feed keyset cursor, every flag, limit clamped",
			q: Query{BrowsingLevel: 1, ModelVersionID: 9, Sort: "Newest", Period: "Week", Limit: 400,
				CursorText: "feed:1700000000000:123", Types: []string{"image", "video"}, WithMeta: true,
				FromPlatform: true, DisableMinor: true, ExcludedUserIDs: []int{3, 3, -1, 4}},
			want: "levels=1&excludedUserIds=3%2C4&versionIds=9&types=image%2Cvideo&withMeta=1&fromPlatform=1&excludeMinor=1&sort=newest&periodDays=7&limit=200&cursor=1700000000000%7C123",
		},
		{
			name: "offset|entry cursor on Newest freezes the set at the entry minute",
			q:    Query{BrowsingLevel: 1, ModelVersionID: 9, Sort: "Newest", Limit: 100, CursorText: "500|1724677401898"},
			want: "levels=1&versionIds=9&sort=newest&limit=100&offset=500&before=1724677380000",
		},
		{
			name: "offset|entry cursor on another sort drops the entry",
			q:    Query{BrowsingLevel: 1, ModelVersionID: 9, Sort: "Most Comments", Limit: 100, CursorText: "500|1724677401898"},
			want: "levels=1&versionIds=9&sort=comments&limit=100&offset=500",
		},
		{
			name: "numeric cursor is an offset, not an image id",
			q:    Query{BrowsingLevel: 1, ModelVersionID: 9, Sort: "Most Collected", Period: "Year", Limit: 50, CursorNum: 250},
			want: "levels=1&versionIds=9&sort=collected&periodDays=365&limit=50&offset=250",
		},
		{
			name: "post completion: deduped post ids, the version scope kept",
			q:    Query{BrowsingLevel: 31, ModelVersionID: 9, PostIDs: []int{30, 10, 30}, Sort: "Most Reactions", Limit: 27},
			want: "levels=1%2C2%2C4%2C8%2C16&versionIds=9&postIds=30%2C10&sort=reactions&limit=27",
		},
		{
			name: "model3d gallery, limit 0 asks for the default page",
			q:    Query{BrowsingLevel: 3, Model3DID: 5, Sort: "Oldest", Limit: 0},
			want: "levels=1%2C2&model3dIds=5&sort=oldest&limit=100",
		},
		{
			// image.getInfinite's creator and tag scopes: `tags` right after `levels` (insertion order
			// of the mapper), non-positive ids dropped, no dedupe; `userIds` after the version scope.
			name: "creator and tag scope (image.getInfinite)",
			q: Query{BrowsingLevel: 3, ExcludedTagIDs: []int{9901}, Tags: []int{77, -1, 77, 5}, UserID: 1001,
				DisablePoi: true, ViewerID: 1001, Sort: "Newest", Limit: 50},
			want: "levels=1%2C2&tags=77%2C77%2C5&excludedTags=9901&userIds=1001&excludePoi=1&viewerId=1001&sort=newest&limit=50",
		},
		{
			// `tools` after the POI exclusion and before the post ids; the positive ids only, in order,
			// repeats kept (feed-shadow's `ints`, no dedupe).
			name: "tools on a post completion",
			q: Query{BrowsingLevel: 1, ExcludedTagIDs: []int{9901}, ModelVersionID: 9, DisablePoi: true, ViewerID: 1003,
				PostIDs: []int{7001}, Tools: []int{42, 0, -3, 42, 41}, Sort: "Most Reactions", Limit: 2},
			want: "levels=1&excludedTags=9901&versionIds=9&excludePoi=1&viewerId=1003&tools=42%2C42%2C41&postIds=7001&sort=reactions&limit=2",
		},
		{
			name: "tools of only non-positive ids send no tools",
			q:    Query{BrowsingLevel: 1, ModelVersionID: 9, Tools: []int{0, -1}, Sort: "Newest", Limit: 10},
			want: "levels=1&versionIds=9&sort=newest&limit=10",
		},
		{
			name: "the Blocked bit is a feed level",
			q:    Query{BrowsingLevel: 32 | 4, ModelVersionID: 2, Sort: "Oldest", Limit: 10, CursorText: "0"},
			want: "levels=4%2C32&versionIds=2&sort=oldest&limit=10",
		},
	}
	for _, c := range cases {
		got, ref := Map(c.q)
		if ref != nil {
			t.Errorf("%s: refused %+v", c.name, ref)
			continue
		}
		if got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

func TestMapRefusals(t *testing.T) {
	base := func() Query { return Query{BrowsingLevel: 31, ModelVersionID: 9, Sort: "Newest", Limit: 100} }
	many := make([]int, 101)
	for i := range many {
		many[i] = i + 1
	}
	cases := []struct {
		name     string
		edit     func(*Query)
		reason   string
		rejected bool
	}{
		{"pipe cursor with a non-numeric entry", func(q *Query) { q.CursorText = "12|ab" }, "cursor:unparsed", true},
		{"garbage cursor", func(q *Query) { q.CursorText = "abc" }, "cursor:unparsed", true},
		{"date cursor", func(q *Query) { q.CursorText = "2024-01-01T00:00:00.000Z" }, "cursor:unparsed", true},
		{"feed cursor with three parts", func(q *Query) { q.CursorText = "feed:1:2:3" }, "cursor:unparsed", true},
		{"deep offset", func(q *Query) { q.CursorText = "20001" }, "offset>20000", true},
		{"deep numeric offset", func(q *Query) { q.CursorNum = 20001 }, "offset>20000", true},
		{"model without a version", func(q *Query) { q.ModelVersionID = 0; q.ModelID = 7 }, "modelId", false},
		{"no level", func(q *Query) { q.BrowsingLevel = 0 }, "browsingLevel:0", false},
		{"too many excluded tags", func(q *Query) { q.ExcludedTagIDs = many }, "excludedTags>100", false},
		{"only impossible tags", func(q *Query) { q.Tags = []int{0, -3} }, "tags:none", false},
		{"too many tags", func(q *Query) { q.Tags = many }, "tags>100", false},
		// Tags are checked before the excluded tags, as in the mapper.
		{"tags before excluded tags", func(q *Query) { q.Tags = many; q.ExcludedTagIDs = many }, "tags>100", false},
		{"generation", func(q *Query) { q.HasGeneration = true }, "input:generation", false},
		{"remixOfId", func(q *Query) { q.HasRemixOfID = true }, "input:remixOfId", false},
		{"requiringMeta", func(q *Query) { q.RequiringMeta = true }, "flag:requiringMeta", false},
		{"completion past one feed page", func(q *Query) { q.PostIDs = []int{1}; q.Limit = 201 }, "postIds:limit>200", false},
		// The mapper reports the FIRST reason: generation is checked before the cursor.
		{"first reason wins", func(q *Query) { q.HasGeneration = true; q.CursorText = "abc" }, "input:generation", false},
		// UNSUPPORTED_KEYS: prioritizedUserIds comes before generation, and before any refusal Node
		// answers with a 400 (a malformed cursor, an unknown sort).
		{"prioritizedUserIds", func(q *Query) { q.HasPrioritizedUserIDs = true }, "input:prioritizedUserIds", false},
		{"prioritizedUserIds before generation", func(q *Query) { q.HasPrioritizedUserIDs = true; q.HasGeneration = true }, "input:prioritizedUserIds", false},
		{"prioritizedUserIds before a bad cursor", func(q *Query) { q.HasPrioritizedUserIDs = true; q.CursorText = "abc" }, "input:prioritizedUserIds", false},
		{"prioritizedUserIds before an unknown sort", func(q *Query) { q.HasPrioritizedUserIDs = true; q.Sort = "Random" }, "input:prioritizedUserIds", false},
		// UNSUPPORTED_FLAGS: pending after requiringMeta, and after every unsupported key.
		{"pending", func(q *Query) { q.Pending = true }, "flag:pending", false},
		{"requiringMeta before pending", func(q *Query) { q.RequiringMeta = true; q.Pending = true }, "flag:requiringMeta", false},
		{"remixOfId before pending", func(q *Query) { q.HasRemixOfID = true; q.Pending = true }, "input:remixOfId", false},
		{"pending before a bad cursor", func(q *Query) { q.Pending = true; q.CursorText = "abc" }, "flag:pending", false},
	}
	for _, c := range cases {
		q := base()
		c.edit(&q)
		got, ref := Map(q)
		if ref == nil {
			t.Errorf("%s: mapped to %q, want refusal %q", c.name, got, c.reason)
			continue
		}
		if ref.Reason != c.reason || ref.Rejected != c.rejected {
			t.Errorf("%s: refusal %+v, want {%s %v}", c.name, *ref, c.reason, c.rejected)
		}
	}
	// 100 excluded tags is still mapped (the ceiling is "more than 100").
	q := base()
	q.ExcludedTagIDs = many[:100]
	if _, ref := Map(q); ref != nil {
		t.Fatalf("100 excluded tags refused: %+v", ref)
	}
}

func TestCursorCodec(t *testing.T) {
	if got := EncodeCursor("1700|12"); got != "feed:1700:12" {
		t.Fatalf("EncodeCursor = %q", got)
	}
	if got := ParseCursor("feed:1700:12"); got != "1700|12" {
		t.Fatalf("ParseCursor = %q", got)
	}
	for _, bad := range []string{"feed:1:2:3", "feed:12345678901234567:1", "feed:1:1234567890123", "1700|12", "feed:a:1"} {
		if got := ParseCursor(bad); got != "" {
			t.Errorf("ParseCursor(%q) = %q, want none", bad, got)
		}
	}
}

func TestClientFetch(t *testing.T) {
	var gotPath, gotQuery, gotSource, gotReplay string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		gotSource, gotReplay = r.Header.Get("x-request-source"), r.Header.Get("x-replay-id")
		if r.URL.Query().Get("sort") == "oldest" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("bad"))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{30, 10, "x", -2, 2.5, 20}, "nextCursor": "1700|10", "route": "walk",
		})
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL + "/", HTTP: srv.Client()}
	shadowCtx := WithShadow(context.Background())
	a, err := c.Fetch(shadowCtx, "levels=1&sort=newest&limit=2")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/feed" || gotQuery != "levels=1&sort=newest&limit=2" {
		t.Fatalf("request = %s ? %s", gotPath, gotQuery)
	}
	// Shadow calls are marked as such: never the served-traffic source, and out of the live series.
	if gotSource != "shadow" || gotReplay != "feed-go-shadow" {
		t.Fatalf("headers: x-request-source=%q x-replay-id=%q, want shadow / feed-go-shadow", gotSource, gotReplay)
	}
	if a.Status != 200 || !reflect.DeepEqual(a.IDs, []int{30, 10, 20}) || a.NextCursor != "1700|10" {
		t.Fatalf("answer = %+v", a)
	}
	a, err = c.Fetch(shadowCtx, "sort=oldest")
	if err != nil || a.Status != 400 || len(a.IDs) != 0 {
		t.Fatalf("a 400 is an answer with its status: %+v %v", a, err)
	}
}

// A served request is the site's own traffic: it sends Node's served source and no replay id, so it
// lands in the feed service's live series. Only a shadow compute (WithShadow) is marked as replay.
func TestClientFetchServedRequestIsNotMarkedShadow(t *testing.T) {
	var gotSource string
	var replaySent bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSource = r.Header.Get("x-request-source")
		_, replaySent = r.Header["X-Replay-Id"]
		_, _ = w.Write([]byte(`{"items":[5]}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, HTTP: srv.Client()}
	if _, err := c.Fetch(context.Background(), "levels=1&sort=newest&limit=1"); err != nil {
		t.Fatal(err)
	}
	if gotSource != "primary" || replaySent {
		t.Fatalf("served: x-request-source=%q replay header sent=%v, want primary and none", gotSource, replaySent)
	}
	// The mark is carried by the context, through derived contexts too.
	derived, cancel := context.WithTimeout(WithShadow(context.Background()), time.Minute)
	defer cancel()
	if _, err := c.Fetch(derived, "levels=1&sort=newest&limit=1"); err != nil {
		t.Fatal(err)
	}
	if gotSource != "shadow" || !replaySent {
		t.Fatalf("shadow: x-request-source=%q replay header sent=%v, want shadow and sent", gotSource, replaySent)
	}
	if IsShadow(context.Background()) || !IsShadow(derived) {
		t.Fatal("IsShadow must be false for an unmarked context and true for a marked one")
	}
}

// The public images endpoint ('rest' caller): a post's media are paged in the requested sort, and the
// creator filter is sent as `userIds`, between versionIds and types as URLSearchParams appends them.
func TestMapRestCaller(t *testing.T) {
	q := Query{Rest: true, BrowsingLevel: 1, ExcludedTagIDs: []int{5}, ModelVersionID: 9, PostID: 30, UserID: 42,
		Types: []string{"video"}, DisableMinor: true, DisablePoi: true, ViewerID: 7, Sort: "Oldest", Period: "Week",
		Limit: 50, CursorText: "100"}
	got, ref := Map(q)
	if ref != nil {
		t.Fatalf("refused %+v", ref)
	}
	want := "levels=1&excludedTags=5&versionIds=9&userIds=42&types=video&excludeMinor=1&excludePoi=1&viewerId=7&postIds=30&sort=oldest&periodDays=7&limit=50&offset=100"
	if got != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
	// The site's own post page keeps the author's order, which the feed cannot give.
	q.Rest = false
	if _, ref := Map(q); ref == nil || ref.Reason != "input:postId" || ref.Rejected {
		t.Fatalf("website postId: %+v, want the input:postId skip", ref)
	}
	// The completion's limit bound applies to the completion only.
	rest := Query{Rest: true, BrowsingLevel: 1, PostID: 30, Sort: "Newest", Limit: 300}
	if got, ref := Map(rest); ref != nil || got != "levels=1&postIds=30&sort=newest&limit=200" {
		t.Fatalf("rest postId over the feed limit: %q %+v", got, ref)
	}
}
