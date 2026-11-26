package shadow

import (
	"reflect"
	"testing"
)

// The REST /api/v1/images body is plain JSON (`res.json`): no envelope, no meta.values, a Date is its
// ISO string. Key order is ignored, as for the superjson envelope.
func TestCompareJSONMatchIgnoresKeyOrder(t *testing.T) {
	g := []byte(`{"items":[{"id":11,"createdAt":"2024-03-01T10:00:00.000Z","stats":{"likeCount":0,"heartCount":2}}],"metadata":{"nextCursor":"feed:1:2"}}`)
	n := []byte(`{"metadata":{"nextCursor":"feed:1:2"},"items":[{"stats":{"heartCount":2,"likeCount":0},"createdAt":"2024-03-01T10:00:00.000Z","id":11}]}`)
	r, err := CompareJSON(g, n)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Match || len(r.Diffs) != 0 {
		t.Fatalf("want match, got %+v", r.Diffs)
	}
	if got := ClassifyJSON(r, g, n); got != "match" {
		t.Fatalf("classify = %s, want match", got)
	}
}

// `metadata` is opaque in the superjson envelope (image metadata), but here it is the paging object,
// so its paths keep their keys; the image generation `meta` is the opaque one.
func TestCompareJSONCategories(t *testing.T) {
	g := []byte(`{"items":[{"id":11,"stats":{"likeCount":3},"meta":{"prompt":"a"},"username":"alice"}],"metadata":{"nextCursor":"feed:1:2","nextPage":"https://h/api/v1/images?cursor=feed%3A1%3A2"}}`)
	n := []byte(`{"items":[{"id":11,"stats":{"likeCount":4},"meta":{"prompt":"b"},"username":null,"baseModel":null}],"metadata":{"nextCursor":"feed:1:3"}}`)
	r, err := CompareJSON(g, n)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, d := range r.Diffs {
		got[d.Category] = d.Kind
	}
	want := map[string]string{
		"items.*.stats.likeCount": "value",
		"items.*.meta":            "value", // truncated at the opaque key
		"items.*.username":        "type",  // a string against null
		"items.*.baseModel":       "missing-in-go",
		"metadata.nextCursor":     "value",
		"metadata.nextPage":       "missing-in-node",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("categories:\n got %v\nwant %v", got, want)
	}
	if c := ClassifyJSON(r, g, n); c != "fields" {
		t.Fatalf("classify = %s, want fields (same images, same order)", c)
	}
}

func TestClassifyJSONByImageID(t *testing.T) {
	a := []byte(`{"items":[{"id":1,"postId":9},{"id":2,"postId":9}],"metadata":{}}`)
	b := []byte(`{"items":[{"id":2,"postId":9},{"id":1,"postId":9}],"metadata":{}}`)
	c := []byte(`{"items":[{"id":2,"postId":9},{"id":3,"postId":9}],"metadata":{}}`)
	r, _ := CompareJSON(a, b)
	if got := ClassifyJSON(r, a, b); got != "order" {
		t.Fatalf("a vs b = %s, want order (the same post's images reordered)", got)
	}
	r, _ = CompareJSON(a, c)
	if got := ClassifyJSON(r, a, c); got != "membership" {
		t.Fatalf("a vs c = %s, want membership", got)
	}
}

func TestCompareJSONRejectsANonObjectNodeBody(t *testing.T) {
	if _, err := CompareJSON([]byte(`{"items":[]}`), []byte(`[1]`)); err == nil {
		t.Fatal("a Node body that is not an object must be a bad_request, not a comparison")
	}
	if _, err := CompareJSON([]byte(`{"items":[]}`), []byte(`{"items":`)); err == nil {
		t.Fatal("truncated Node JSON must be an error")
	}
}

// The envelope comparator's categories are unchanged by the per-report opaque set.
func TestCategoryOfTheEnvelopeStillStopsAtMetadata(t *testing.T) {
	if got := Category([]string{"items", "0", "images", "3", "metadata", "width"}); got != "items.*.images.*.metadata" {
		t.Fatalf("Category = %q", got)
	}
}

// CompareV1Images compares `items.*.modelVersionIds` as a multiset of numbers: the same ids in another
// order match (image 79140094's ids as the two sides' image-resources lookups ordered them before
// both carried an ORDER BY). A missing, extra, repeated or changed id still differs, under the same
// category. CompareJSON, the other REST routes' comparator, keeps array order everywhere.
func TestCompareV1ImagesModelVersionIDsAreAMultiset(t *testing.T) {
	body := func(ids string) []byte {
		return []byte(`{"items":[{"id":79140094,"modelVersionIds":` + ids + `,"baseModel":"Pony"}],"metadata":{}}`)
	}
	goIDs := body(`[331598,354657,454217,671164,1768080,1833157]`)
	nodeIDs := body(`[1833157,1768080,671164,454217,354657,331598]`)
	r, err := CompareV1Images(goIDs, nodeIDs)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Match || len(r.Diffs) != 0 {
		t.Fatalf("permuted ids: want match, got %+v", r.Diffs)
	}
	if got := ClassifyJSON(r, goIDs, nodeIDs); got != "match" {
		t.Fatalf("permuted ids: classify = %s, want match", got)
	}
	// Control: the same bodies under CompareJSON differ, so the match above is CompareV1Images' own.
	if r, _ := CompareJSON(goIDs, nodeIDs); r.Match {
		t.Fatal("CompareJSON matched permuted ids; it must keep array order")
	}

	for _, c := range []struct {
		name, g, n string
		want       []Diff
	}{
		{"a changed id", `[5,1,3]`, `[3,1,6]`, []Diff{{Path: "items.0.modelVersionIds.2", Category: "items.*.modelVersionIds.*", Kind: "value"}}},
		{"an extra id", `[2,1]`, `[1,2,2]`, []Diff{{Path: "items.0.modelVersionIds", Category: "items.*.modelVersionIds", Kind: "length"}}},
		{"a repeated id", `[1,1,2]`, `[2,1,2]`, []Diff{{Path: "items.0.modelVersionIds.1", Category: "items.*.modelVersionIds.*", Kind: "value"}}},
		{"not all numbers: compared in order", `[7,null]`, `[null,7]`, []Diff{
			{Path: "items.0.modelVersionIds.0", Category: "items.*.modelVersionIds.*", Kind: "type"},
			{Path: "items.0.modelVersionIds.1", Category: "items.*.modelVersionIds.*", Kind: "type"},
		}},
	} {
		g, n := body(c.g), body(c.n)
		r, err := CompareV1Images(g, n)
		if err != nil {
			t.Fatal(err)
		}
		if r.Match || !reflect.DeepEqual(r.Diffs, c.want) {
			t.Errorf("%s: diffs %+v, want %+v", c.name, r.Diffs, c.want)
		}
		if got := ClassifyJSON(r, g, n); got != "fields" {
			t.Errorf("%s: classify = %s, want fields", c.name, got)
		}
	}

	// Nothing else is unordered: another array of numbers, the items themselves, and baseModel.
	for _, c := range []struct {
		name, g, n, class string
	}{
		{"another number array", `{"items":[{"id":3,"tagIds":[41,42]}],"metadata":{}}`, `{"items":[{"id":3,"tagIds":[42,41]}],"metadata":{}}`, "fields"},
		{"the items", `{"items":[{"id":3},{"id":4}],"metadata":{}}`, `{"items":[{"id":4},{"id":3}],"metadata":{}}`, "order"},
		{"baseModel", `{"items":[{"id":3,"modelVersionIds":[8,9],"baseModel":"Pony"}],"metadata":{}}`, `{"items":[{"id":3,"modelVersionIds":[9,8],"baseModel":"SDXL 1.0"}],"metadata":{}}`, "fields"},
	} {
		r, err := CompareV1Images([]byte(c.g), []byte(c.n))
		if err != nil {
			t.Fatal(err)
		}
		if got := ClassifyJSON(r, []byte(c.g), []byte(c.n)); r.Match || got != c.class {
			t.Errorf("%s: match %v, classify %s; want a %s diff", c.name, r.Match, got, c.class)
		}
	}
}
