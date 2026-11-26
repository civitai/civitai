package shadow

import (
	"bytes"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

func TestCompareIgnoresKeyOrderAndReferentialEqualities(t *testing.T) {
	goEnv := []byte(`{"json":{"items":[{"postId":1,"user":{"id":2,"username":"a"}}]},"meta":{"values":{"items.0.createdAt":["Date"]},"v":1}}`)
	nodeEnv := []byte(`{"json":{"items":[{"user":{"username":"a","id":2},"postId":1}]},` +
		`"meta":{"values":{"items.0.createdAt":["Date"]},"referentialEqualities":{"items.0.user":["items.0.images.0.user"]},"v":1}}`)
	r, err := Compare(goEnv, nodeEnv)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Match {
		t.Fatalf("want match, got %+v", r.Diffs)
	}
	if got := Classify(r, goEnv, nodeEnv); got != "match" {
		t.Fatalf("classify = %s", got)
	}
}

func TestCompareFindsValueMissingAndAnnotationDiffs(t *testing.T) {
	goEnv := []byte(`{"json":{"items":[{"postId":1,"images":[{"stats":{"likeCountAllTime":3},"metadata":{"a":1}}]}]},"meta":{"values":{"items.0.sortAt":["Date"]},"v":1}}`)
	nodeEnv := []byte(`{"json":{"items":[{"postId":1,"images":[{"stats":{"likeCountAllTime":4},"metadata":{"a":2},"extra":true}]}]},"meta":{"values":{"items.0.sortAt":["Date"],"items.0.review":["undefined"]},"v":1}}`)
	r, err := Compare(goEnv, nodeEnv)
	if err != nil {
		t.Fatal(err)
	}
	if r.Match {
		t.Fatal("want diffs")
	}
	got := map[string]string{}
	for _, d := range r.Diffs {
		got[d.Category] = d.Kind
	}
	want := map[string]string{
		"items.*.images.*.stats.likeCountAllTime": "value",
		"items.*.images.*.metadata":               "value", // truncated at the opaque key
		"items.*.images.*.extra":                  "missing-in-go",
		"items.*.review":                          "annotation",
	}
	for cat, kind := range want {
		if got[cat] != kind {
			t.Errorf("category %s: kind %q, want %q (all: %v)", cat, got[cat], kind, got)
		}
	}
	if len(got) != len(want) {
		t.Errorf("got %d categories, want %d: %v", len(got), len(want), got)
	}
	if c := Classify(r, goEnv, nodeEnv); c != "fields" {
		t.Fatalf("classify = %s, want fields", c)
	}
}

// superjson.serialize writes an undefined object member as `null` annotated ["undefined"]
// (transformValue: undefined -> null), and superjson.deserialize sets every annotated path back to
// undefined (setDeep assigns `parent[lastKey]` unconditionally). This service's writer now writes the
// same bytes (asserted below); before 0.0.51 it omitted the member, which deserializes to the same
// object, so an omitted member still matches (TestCompareOmittedUndefinedMember). The first live shadow
// window counted every such member as missing-in-go (`images.*.tags`, `images.*.thumbnailUrl` on
// every non-video image, `review` on every post without one): a comparator artifact, not a parity gap.
func TestCompareAppliesUndefinedAnnotations(t *testing.T) {
	item := superjson.Object{
		{Key: "postId", Val: int64(1)},
		{Key: "images", Val: []any{superjson.Object{
			{Key: "id", Val: int64(5)},
			{Key: "tags", Val: superjson.Undefined{}},
			{Key: "tagIds", Val: []any{int64(3)}},
			{Key: "thumbnailUrl", Val: superjson.Undefined{}},
		}}},
		{Key: "review", Val: superjson.Undefined{}},
	}
	goEnv, err := superjson.Serialize(superjson.Object{{Key: "items", Val: []any{item}}})
	if err != nil {
		t.Fatal(err)
	}
	// What superjson.serialize (2.x) writes for the same JS object, then JSON.stringify.
	nodeEnv := []byte(`{"json":{"items":[{"postId":1,"images":[{"id":5,"tags":null,"tagIds":[3],"thumbnailUrl":null}],"review":null}]},` +
		`"meta":{"values":{"items.0.images.0.tags":["undefined"],"items.0.images.0.thumbnailUrl":["undefined"],"items.0.review":["undefined"]},"v":1}}`)
	if !bytes.Equal(goEnv, nodeEnv) {
		t.Fatalf("not Node's bytes:\ngo:   %s\nnode: %s", goEnv, nodeEnv)
	}
	r, err := Compare(goEnv, nodeEnv)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Match {
		t.Fatalf("want match, got %+v\ngo:   %s", r.Diffs, goEnv)
	}
	if got := Classify(r, goEnv, nodeEnv); got != "match" {
		t.Fatalf("classify = %s", got)
	}
}

// The bytes a writer that omits an undefined member writes (feed-go before 0.0.51; a replayed capture)
// still match Node's annotated null: both deserialize to the same object.
func TestCompareOmittedUndefinedMember(t *testing.T) {
	omitted := []byte(`{"json":{"items":[{"id":5}]},"meta":{"values":{"nextCursor":["undefined"],"items.0.tags":["undefined"]},"v":1}}`)
	node := []byte(`{"json":{"items":[{"id":5,"tags":null}],"nextCursor":null},"meta":{"values":{"items.0.tags":["undefined"],"nextCursor":["undefined"]},"v":1}}`)
	r, err := Compare(omitted, node)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Match {
		t.Fatalf("an omitted undefined member must match an annotated null: %+v", r.Diffs)
	}
}

// A real null (no annotation) is not undefined after decode, and an undefined member on one side only
// is still a difference.
func TestCompareUndefinedIsNotNull(t *testing.T) {
	goEnv := []byte(`{"json":{"a":{"x":1}},"meta":{"values":{"a.review":["undefined"]},"v":1}}`)
	nodeEnv := []byte(`{"json":{"a":{"x":1,"review":null}}}`)
	r, err := Compare(goEnv, nodeEnv)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, d := range r.Diffs {
		got[d.Path+"/"+d.Kind] = true
	}
	if len(r.Diffs) != 2 || !got["a.review/type"] || !got["a.review/annotation"] {
		t.Fatalf("want a type and an annotation diff on a.review, got %+v", r.Diffs)
	}

	// Undefined on the Go side, a value on the Node side.
	nodeEnv = []byte(`{"json":{"a":{"x":1,"review":{"id":2}}}}`)
	r, err = Compare(goEnv, nodeEnv)
	if err != nil {
		t.Fatal(err)
	}
	if r.Match {
		t.Fatal("undefined vs an object must differ")
	}

	// Undefined inside an array: both writers emit null + annotation.
	r, err = Compare(
		[]byte(`{"json":{"a":[null,1]},"meta":{"values":{"a.0":["undefined"]},"v":1}}`),
		[]byte(`{"json":{"a":[null,1]},"meta":{"values":{"a.0":["undefined"]},"v":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !r.Match {
		t.Fatalf("array undefined: %+v", r.Diffs)
	}
}

// An ["undefined"] annotation on one side only, with the member absent from the other side, is ONE
// difference (the annotation), not also a missing-in-* from the walk. Both directions, so each half
// of the walk's skip case is pinned.
func TestCompareOneSidedUndefinedIsOneAnnotationDiff(t *testing.T) {
	plain := []byte(`{"json":{"a":{"x":1}}}`)
	annotated := []byte(`{"json":{"a":{"x":1,"review":null}},"meta":{"values":{"a.review":["undefined"]},"v":1}}`)
	for name, envs := range map[string][2][]byte{
		"node annotated": {plain, annotated},
		"go annotated":   {annotated, plain},
	} {
		r, err := Compare(envs[0], envs[1])
		if err != nil {
			t.Fatal(err)
		}
		if r.Match || len(r.Diffs) != 1 || r.Diffs[0].Path != "a.review" || r.Diffs[0].Kind != "annotation" {
			t.Errorf("%s: want exactly one a.review annotation diff, got %+v", name, r.Diffs)
		}
	}
}

func TestCompareNumbersNumerically(t *testing.T) {
	r, err := Compare([]byte(`{"json":{"a":1.0,"b":[1,2]}}`), []byte(`{"json":{"a":1,"b":[1,2,3]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Diffs) != 1 || r.Diffs[0].Kind != "length" || r.Diffs[0].Path != "b" {
		t.Fatalf("want exactly the length diff on b, got %+v", r.Diffs)
	}
}

func TestClassifyOrderVsMembership(t *testing.T) {
	a := []byte(`{"json":{"items":[{"postId":1},{"postId":2}]}}`)
	b := []byte(`{"json":{"items":[{"postId":2},{"postId":1}]}}`)
	c := []byte(`{"json":{"items":[{"postId":2},{"postId":3}]}}`)
	r, _ := Compare(a, b)
	if got := Classify(r, a, b); got != "order" {
		t.Fatalf("a vs b = %s, want order", got)
	}
	r, _ = Compare(a, c)
	if got := Classify(r, a, c); got != "membership" {
		t.Fatalf("a vs c = %s, want membership", got)
	}
}

// image.getInfinite's flat page: classified by image id, with the diff categories of the flat shape.
func TestClassifyFlat(t *testing.T) {
	base := []byte(`{"json":{"items":[{"id":1,"stats":{"likeCountAllTime":2}},{"id":2,"stats":{"likeCountAllTime":0}}],"nextCursor":"feed:1:2","source":"feed"}}`)
	cases := []struct {
		name, node, want string
		categories       []string
	}{
		{"match", string(base), "match", nil},
		{"order", `{"json":{"items":[{"id":2,"stats":{"likeCountAllTime":0}},{"id":1,"stats":{"likeCountAllTime":2}}],"nextCursor":"feed:1:2","source":"feed"}}`,
			"order", []string{"items.*.id", "items.*.stats.likeCountAllTime"}},
		{"membership", `{"json":{"items":[{"id":1,"stats":{"likeCountAllTime":2}},{"id":3,"stats":{"likeCountAllTime":0}}],"nextCursor":"feed:1:2","source":"feed"}}`,
			"membership", []string{"items.*.id"}},
		{"fields", `{"json":{"items":[{"id":1,"stats":{"likeCountAllTime":3}},{"id":2,"stats":{"likeCountAllTime":0}}],"nextCursor":"feed:1:3","source":"db"}}`,
			"fields", []string{"items.*.stats.likeCountAllTime", "nextCursor", "source"}},
		// A posts envelope has no image ids at the top: every id reads as "" and the two sides agree.
		{"not a flat page", `{"json":{"items":[{"postId":9},{"postId":8}]}}`, "membership", nil},
	}
	for _, c := range cases {
		r, err := Compare(base, []byte(c.node))
		if err != nil {
			t.Fatal(err)
		}
		if got := ClassifyFlat(r, base, []byte(c.node)); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
		if c.categories == nil {
			continue
		}
		seen := map[string]bool{}
		var cats []string
		for _, d := range r.Diffs {
			if !seen[d.Category] {
				seen[d.Category] = true
				cats = append(cats, d.Category)
			}
		}
		if strings.Join(cats, ",") != strings.Join(c.categories, ",") {
			t.Errorf("%s: categories %v, want %v", c.name, cats, c.categories)
		}
	}
	// An undecodable side is "fields" (the report already says it differs), as for Classify.
	r := &Report{Diffs: []Diff{{Path: "x"}}}
	if got := ClassifyFlat(r, []byte(`not json`), base); got != "fields" {
		t.Fatalf("undecodable = %s, want fields", got)
	}
	// The gallery classifier would call two different image pages "fields" (no postId): the flat
	// one is what tells membership apart.
	m := []byte(`{"json":{"items":[{"id":1},{"id":3}]}}`)
	r, _ = Compare(base, m)
	if got := Classify(r, base, m); got != "fields" {
		t.Fatalf("control: Classify on a flat page = %s", got)
	}
}

func TestSplitPathUnescapes(t *testing.T) {
	got := splitPath(`a\.b.c\\d.0`)
	want := []string{"a.b", `c\d`, "0"}
	if len(got) != len(want) {
		t.Fatalf("got %q", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %q want %q", got, want)
		}
	}
}

func TestDiffsAreBounded(t *testing.T) {
	g := []byte(`{"json":{"a":[` + repeat("1", 100) + `]}}`)
	n := []byte(`{"json":{"a":[` + repeat("2", 100) + `]}}`)
	r, err := Compare(g, n)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Diffs) != MaxDiffs || !r.Truncated || r.Match {
		t.Fatalf("diffs=%d truncated=%v match=%v", len(r.Diffs), r.Truncated, r.Match)
	}
}

func repeat(s string, n int) string {
	return strings.TrimSuffix(strings.Repeat(s+",", n), ",")
}
