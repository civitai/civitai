package feed

import (
	"context"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The gallery used to hand every request carrying `tags` or `techniques` back to Node (input-tags /
// input-techniques). Both are now answered, on both image procedures, while a value the schema
// rejects or one Postgres would cast is still not.
func TestParseNoLongerFallsBackOnTagsAndTechniques(t *testing.T) {
	parsers := map[string]func(map[string]any) error{
		"Parse":         func(m map[string]any) error { _, err := Parse(m); return err },
		"ParseInfinite": func(m map[string]any) error { _, err := ParseInfinite(m); return err },
	}
	for name, parse := range parsers {
		for _, input := range []string{
			`{"tags":[501]}`,
			`{"tags":[5161,502,0,-1]}`,
			`{"techniques":[3]}`,
			`{"techniques":[4,0,4,-2]}`,
			`{"tags":[501],"techniques":[3],"tools":[42],"modelVersionId":9}`,
		} {
			if err := parse(parseObj(t, input)); err != nil {
				t.Errorf("%s %s: reason %q (err %v), want it answered", name, input, fallback.Reason(err), err)
			}
		}
		for input, want := range map[string]string{
			// Schema rejections (Node's BAD_REQUEST).
			`{"tags":"501"}`:        "input-invalid",
			`{"tags":[501,"502"]}`:  "input-invalid",
			`{"techniques":3}`:      "input-invalid",
			`{"techniques":[null]}`: "input-invalid",
			`{"tags":null}`:         "input-invalid",
			`{"techniques":null}`:   "input-invalid",
			`{"techniques":[true]}`: "input-invalid",
			// Numbers the schema accepts that Postgres would have to cast: still Node's.
			`{"techniques":[1.5]}`:          "input-techniques",
			`{"techniques":[3,2147483648]}`: "input-techniques",
			`{"techniques":[-2147483649]}`:  "input-techniques",
			// Another unported key still names the fallback.
			`{"tags":[501],"techniques":[3],"hidden":true}`: "input-hidden",
		} {
			if err := parse(parseObj(t, input)); fallback.Reason(err) != want {
				t.Errorf("%s %s: reason %q (err %v), want %q", name, input, fallback.Reason(err), err, want)
			}
		}
	}
}

// Both lists are kept as sent: order, repeats, zero and negative ids (getAllImages binds them as is;
// the feed query keeps the positive ones). An empty list filters nothing.
func TestParseTagsAndTechniquesAsSent(t *testing.T) {
	parsers := map[string]func(map[string]any) (*Input, error){
		"Parse": Parse,
		"ParseInfinite": func(m map[string]any) (*Input, error) {
			in, err := ParseInfinite(m)
			if err != nil {
				return nil, err
			}
			return &in.Input, nil
		},
	}
	for name, parse := range parsers {
		for _, c := range []struct {
			input      string
			tags, tech []int
		}{
			{`{"limit":10}`, nil, nil},
			{`{"tags":[],"techniques":[]}`, []int{}, []int{}},
			{`{"tags":[7,3,7,0,-2]}`, []int{7, 3, 7, 0, -2}, nil},
			{`{"techniques":[9,4,9,0,-5]}`, nil, []int{9, 4, 9, 0, -5}},
			{`{"tags":[2147483647],"techniques":[-2147483648]}`, []int{2147483647}, []int{-2147483648}},
		} {
			in, err := parse(parseObj(t, c.input))
			if err != nil {
				t.Errorf("%s %s: reason %q (err %v), want it parsed", name, c.input, fallback.Reason(err), err)
				continue
			}
			if !reflect.DeepEqual(in.Tags, c.tags) || !reflect.DeepEqual(in.Techniques, c.tech) {
				t.Errorf("%s %s: Tags %#v Techniques %#v, want %#v %#v", name, c.input, in.Tags, in.Techniques, c.tags, c.tech)
			}
		}
	}
}

// The techniques clause: getAllImagesUncaptured's EXISTS over the image's ImageTechnique rows, the
// list bound once as sent, right after the tools clause, and the query's cache policy untouched
// (Node does not mark it personalized).
func TestBuildTechniquesClause(t *testing.T) {
	const clause = `EXISTS (
      SELECT 1
      FROM "ImageTechnique" it
      WHERE it."imageId" = i.id AND it."techniqueId" = ANY($`
	base := ImagesQuery{Limit: 10, Sort: SortNewest, BrowsingLevel: 1, ModelVersionID: 9}
	if b := base.Build(); strings.Contains(b.SQL, `"ImageTechnique"`) {
		t.Fatal("no techniques: the query must not read ImageTechnique")
	}
	empty := base
	empty.Techniques = []int{}
	if b := empty.Build(); strings.Contains(b.SQL, `"ImageTechnique"`) {
		t.Fatal("an empty techniques list filters nothing (`!!techniques?.length`)")
	}
	q := base
	q.Techniques = []int{9, 4, 9, 0}
	q.Tools = []int{42}
	b := q.Build()
	i := strings.Index(b.SQL, clause)
	if i < 0 {
		t.Fatalf("SQL lacks the techniques clause:\n%s", b.SQL)
	}
	if tools := strings.Index(b.SQL, `"ImageTool"`); tools < 0 || tools > i {
		t.Fatalf("the techniques clause must follow the tools clause, as in getAllImagesUncaptured:\n%s", b.SQL)
	}
	rest := b.SQL[i+len(clause):]
	end := strings.Index(rest, "::int[])\n    )")
	if end < 0 {
		t.Fatalf("techniques clause not closed as `$n::int[]) )`:\n%s", b.SQL)
	}
	n, err := strconv.Atoi(rest[:end])
	if err != nil || n < 1 || n > len(b.Args) {
		t.Fatalf("techniques clause binds %q, not one of the %d args", rest[:end], len(b.Args))
	}
	if got, ok := b.Args[n-1].([]int); !ok || !reflect.DeepEqual(got, []int{9, 4, 9, 0}) {
		t.Fatalf("techniques clause binds %#v, want []int{9, 4, 9, 0} (as sent)", b.Args[n-1])
	}
	if strings.Count(b.SQL, `"ImageTechnique"`) != 1 {
		t.Fatal("the techniques clause must appear once")
	}
	// Same cache policy as without techniques: a version gallery stays cached under its tag.
	if b.CacheTTL != 10*time.Minute || !reflect.DeepEqual(b.CacheTags, []string{"images-modelVersion:9"}) {
		t.Fatalf("cache policy with techniques = %v %v, want 10m [images-modelVersion:9]", b.CacheTTL, b.CacheTags)
	}
}

// stripBlockedTags is stripBlockedTagIds: the unblocked ids in order (repeats and impossible ids
// kept), allBlocked only when none is left, nothing read without tags.
func TestStripBlockedTags(t *testing.T) {
	ctx := context.Background()
	r := testkit.NewRedis()
	r.SetString(BlockedTagsKey, []byte(`[{"id":5161,"name":"a"},{"id":5351,"name":"b"}]`))
	blocked := &BlockedTags{Cache: r}
	for _, c := range []struct {
		tags       []int
		kept       []int
		allBlocked bool
	}{
		{[]int{5161, 77, 0, 77, 5351, -3}, []int{77, 0, 77, -3}, false},
		{[]int{77}, []int{77}, false},
		{[]int{5161, 5351, 5161}, []int{}, true},
	} {
		kept, all, err := stripBlockedTags(ctx, blocked, c.tags)
		if err != nil || !reflect.DeepEqual(kept, c.kept) || all != c.allBlocked {
			t.Errorf("%v: kept %#v allBlocked %v err %v, want %#v %v", c.tags, kept, all, err, c.kept, c.allBlocked)
		}
	}
	// No tags: the list is not needed, so neither a missing reader nor a missing key matters.
	for _, tags := range [][]int{nil, {}} {
		if kept, all, err := stripBlockedTags(ctx, nil, tags); err != nil || all || len(kept) != 0 {
			t.Errorf("%#v without a reader: %v %v %v", tags, kept, all, err)
		}
	}
	if _, _, err := stripBlockedTags(ctx, nil, []int{77}); fallback.Reason(err) != "blocked-tags-unconfigured" {
		t.Errorf("no reader: err %v, want blocked-tags-unconfigured", err)
	}
	if _, _, err := stripBlockedTags(ctx, &BlockedTags{Cache: testkit.NewRedis()}, []int{77}); fallback.Reason(err) != "blocked-tags-miss" {
		t.Errorf("absent key: err %v, want blocked-tags-miss", err)
	}
}

// On the gallery's feed path the blocked tags are stripped before the query is mapped: the feed is
// sent the rest (positive ids only) and the techniques after the POI exclusion. A tag list made only of
// blocked ids is an empty gallery with no feed call; one the list cannot be read for falls back.
func TestServeGalleryTagsAndTechniques(t *testing.T) {
	// A Model3D gallery (no model gates), signed out, so capped at PG, where the default addons
	// exclude POI and the people tags. The feed page is empty, so nothing is hydrated.
	const excluded = "excludedTags=5161%2C5162%2C5188%2C5249%2C130818%2C130820%2C133182%2C130401%2C110980"
	const want = "levels=1&tags=77&" + excluded + "&excludePoi=1&techniques=4%2C4&model3dIds=5&sort=reactions&limit=20"
	listed := testkit.NewRedis()
	listed.SetString(BlockedTagsKey, []byte(`[{"id":5161,"name":"a"},{"id":5351,"name":"b"}]`))
	serve := func(blocked *BlockedTags, input string) (*Result, []string, error) {
		t.Helper()
		feed := &fakeFeed{answers: map[string]feedsvc.Answer{want: {Status: 200}}}
		d := &Deps{Feed: feed, Blocked: blocked, Config: Config{ImageIndexFeed: true, LazyPostImages: true}, Now: func() time.Time { return time.Unix(0, 0) }}
		in, err := Parse(parseObj(t, input))
		if err != nil {
			t.Fatalf("%s: parse: %v", input, err)
		}
		res, err := Serve(context.Background(), d, Request{Input: in, Cap: 1})
		return res, feed.queries, err
	}

	res, queries, err := serve(&BlockedTags{Cache: listed}, `{"model3dId":5,"limit":10,"tags":[5161,77,0],"techniques":[4,0,4]}`)
	if err != nil || !reflect.DeepEqual(queries, []string{want}) {
		t.Fatalf("serve: err %v, feed queries\n%v\nwant\n%v", err, queries, []string{want})
	}
	if len(res.Items) != 0 || !res.NextCursor.None() {
		t.Fatalf("result = %+v", res)
	}

	res, queries, err = serve(&BlockedTags{Cache: listed}, `{"model3dId":5,"limit":10,"tags":[5161,5351],"techniques":[4]}`)
	if err != nil || len(queries) != 0 || res == nil || len(res.Items) != 0 || !res.NextCursor.None() {
		t.Fatalf("only blocked tags: result %+v, err %v, feed queries %v; want an empty gallery and no feed call", res, err, queries)
	}

	for _, c := range []struct {
		name    string
		blocked *BlockedTags
		want    string
	}{
		{"no blocked-tag reader", nil, "blocked-tags-unconfigured"},
		{"the blocked-tag key absent", &BlockedTags{Cache: testkit.NewRedis()}, "blocked-tags-miss"},
	} {
		if _, queries, err := serve(c.blocked, `{"model3dId":5,"limit":10,"tags":[77]}`); fallback.Reason(err) != c.want || len(queries) != 0 {
			t.Errorf("%s: err %v, feed queries %v; want %s before any feed call", c.name, err, queries, c.want)
		}
	}
	// Without tags the list is never read: no reader is needed.
	const plain = "levels=1&" + excluded + "&excludePoi=1&model3dIds=5&sort=reactions&limit=20"
	feed := &fakeFeed{answers: map[string]feedsvc.Answer{plain: {Status: 200}}}
	in, err := Parse(parseObj(t, `{"model3dId":5,"limit":10}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Serve(context.Background(), &Deps{Feed: feed, Config: Config{ImageIndexFeed: true}}, Request{Input: in, Cap: 1}); err != nil || !reflect.DeepEqual(feed.queries, []string{plain}) {
		t.Fatalf("no tags, no reader: err %v, feed queries %v", err, feed.queries)
	}
}
