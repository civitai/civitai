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
