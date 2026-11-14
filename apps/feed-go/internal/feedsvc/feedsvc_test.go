package feedsvc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
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
		{"generation", func(q *Query) { q.HasGeneration = true }, "input:generation", false},
		{"remixOfId", func(q *Query) { q.HasRemixOfID = true }, "input:remixOfId", false},
		{"requiringMeta", func(q *Query) { q.RequiringMeta = true }, "flag:requiringMeta", false},
		{"completion past one feed page", func(q *Query) { q.PostIDs = []int{1}; q.Limit = 201 }, "postIds:limit>200", false},
		// The mapper reports the FIRST reason: generation is checked before the cursor.
		{"first reason wins", func(q *Query) { q.HasGeneration = true; q.CursorText = "abc" }, "input:generation", false},
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
	var gotPath, gotQuery, gotSource string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery, gotSource = r.URL.Path, r.URL.RawQuery, r.Header.Get("x-request-source")
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
	c := &Client{BaseURL: srv.URL + "/"}
	a, err := c.Fetch(context.Background(), "levels=1&sort=newest&limit=2")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/feed" || gotQuery != "levels=1&sort=newest&limit=2" || gotSource != "primary" {
		t.Fatalf("request = %s ? %s (source %q)", gotPath, gotQuery, gotSource)
	}
	if a.Status != 200 || !reflect.DeepEqual(a.IDs, []int{30, 10, 20}) || a.NextCursor != "1700|10" || a.Route != "walk" {
		t.Fatalf("answer = %+v", a)
	}
	a, err = c.Fetch(context.Background(), "sort=oldest")
	if err != nil || a.Status != 400 || len(a.IDs) != 0 {
		t.Fatalf("a 400 is an answer with its status: %+v %v", a, err)
	}
}
