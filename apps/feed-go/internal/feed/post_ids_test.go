package feed

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

var postIDsOn = InfinitePorts{PostIDs: true}

// Off (the default), a non-empty `postIds` falls back as it did before the port; an empty list or a
// null was, and stays, no filter.
func TestPostIDsPortOffFallsBackAsBefore(t *testing.T) {
	for _, input := range []string{`{"postIds":[7]}`, `{"postIds":[7],"postId":7}`, `{"postIds":[1.5]}`} {
		if _, err := ParseInfiniteWith(parseObj(t, input), InfinitePorts{}); fallback.Reason(err) != "input-postIds" {
			t.Errorf("%s off: %v, want input-postIds", input, err)
		}
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != "input-postIds" {
			t.Errorf("%s via ParseInfinite: %v, want input-postIds", input, err)
		}
	}
	for _, input := range []string{`{"postIds":[]}`, `{"postIds":null}`} {
		in, err := ParseInfiniteWith(parseObj(t, input), InfinitePorts{})
		if err != nil || len(in.PostIDs) != 0 {
			t.Errorf("%s off: %+v, %v, want no filter as before", input, in, err)
		}
	}
	// The gallery still falls back on it.
	if _, err := Parse(parseObj(t, `{"postIds":[7]}`)); fallback.Reason(err) != "input-postIds" {
		t.Fatalf("gallery Parse: %v", err)
	}
}

// On, the list is read as sent (order, repeats, zero and negative ids kept); a null, a non-list or a
// non-number entry is the schema's BAD_REQUEST; an entry that is not an int4 integer falls back.
func TestParsePostIDs(t *testing.T) {
	in, err := ParseInfiniteWith(parseObj(t, `{"postIds":[9,3,9,0,-2]}`), postIDsOn)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(in.PostIDs, []int{9, 3, 9, 0, -2}) || !in.dbPath() {
		t.Fatalf("PostIDs = %v (dbPath %v), want [9 3 9 0 -2] on the Postgres path", in.PostIDs, in.dbPath())
	}
	if in, err := ParseInfiniteWith(parseObj(t, `{"postIds":[]}`), postIDsOn); err != nil || len(in.PostIDs) != 0 || in.dbPath() {
		t.Fatalf("an empty list: %+v %v, want no filter and no routing", in, err)
	}
	for input, want := range map[string]string{
		`{"postIds":null}`:         "input-invalid",
		`{"postIds":7}`:            "input-invalid",
		`{"postIds":["7"]}`:        "input-invalid",
		`{"postIds":[1.5]}`:        "input-postIds",
		`{"postIds":[2147483648]}`: "input-postIds",
	} {
		if _, err := ParseInfiniteWith(parseObj(t, input), postIDsOn); fallback.Reason(err) != want {
			t.Errorf("%s: %v, want %s", input, err, want)
		}
	}
	// The port only lifts its own key.
	if _, err := ParseInfiniteWith(parseObj(t, `{"postIds":[7],"imageId":3}`), postIDsOn); fallback.Reason(err) != "input-imageId" {
		t.Fatalf("imageId beside postIds: %v, want input-imageId", err)
	}
}

// The page query: `i."postId" = ANY(<postIds>)` right after the `postId` clause, the list bound as
// sent, and the sort's own order (only a `postId` orders by the post's index).
func TestPostIDsPageQuery(t *testing.T) {
	q := ImagesQuery{Limit: 2, Sort: SortNewest, BrowsingLevel: 1, PostID: 4, PostIDs: []int{9, 3}}
	b := q.Build()
	post := strings.Index(b.SQL, `i."postId" = $`)
	posts := strings.Index(b.SQL, `i."postId" = ANY($`)
	if post < 0 || posts < 0 || posts < post {
		t.Fatalf("want the postIds clause after the postId clause:\n%s", b.SQL)
	}
	found := false
	for _, a := range b.Args {
		if v, ok := a.([]int); ok && slices.Equal(v, []int{9, 3}) {
			found = true
		}
	}
	if !found {
		t.Fatalf("postIds not bound as sent: %v", b.Args)
	}
	q.PostID = 0
	if b := q.Build(); !strings.Contains(b.SQL, `ORDER BY i."id" DESC`) {
		t.Fatalf("postIds alone: want the sort's order:\n%s", b.SQL)
	}
}

// postVersionsOnly is a modelResolver over fixed post→version and version→model maps.
type postVersionsOnly struct{ posts, versions map[int]int }

func (p postVersionsOnly) PostVersions(_ context.Context, ids []int) (map[int]int, error) {
	out := map[int]int{}
	for _, id := range ids {
		if v, ok := p.posts[id]; ok {
			out[id] = v
		}
	}
	return out, nil
}

func (p postVersionsOnly) VersionModels(_ context.Context, ids []int) (map[int]int, error) {
	out := map[int]int{}
	for _, id := range ids {
		if m, ok := p.versions[id]; ok {
			out[id] = m
		}
	}
	return out, nil
}

// resolveImageModelIds folds every `postIds` entry's model into the gallery gates' model set, beside
// a `postId`'s; a listed post the cache does not hold is skipped, only a missing `postId` makes the
// selector unresolvable (withheld).
func TestResolveImageModelIDsWithPostIDs(t *testing.T) {
	s := postVersionsOnly{posts: map[int]int{71: 61, 72: 62, 73: 0}, versions: map[int]int{61: 51, 62: 52}}
	ctx := context.Background()
	for _, c := range []struct {
		name    string
		postID  int
		postIDs []int
		want    []int
		ok      bool
	}{
		{"postIds alone", 0, []int{71, 72}, []int{51, 52}, true},
		{"a listed post with no version", 0, []int{73, 71}, []int{51}, true},
		{"a listed post the cache does not hold", 0, []int{99, 72}, []int{52}, true},
		{"beside a postId", 71, []int{72}, []int{51, 52}, true},
		{"a postId the cache does not hold", 99, []int{71}, nil, false},
	} {
		got, ok, err := resolveImageModelIDs(ctx, s, 0, 0, c.postID, c.postIDs)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		slices.Sort(got)
		if ok != c.ok || !slices.Equal(got, c.want) {
			t.Errorf("%s: %v, %v; want %v, %v", c.name, got, ok, c.want, c.ok)
		}
	}
}
