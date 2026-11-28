package shadow

import (
	"encoding/json"
	"reflect"
	"testing"
)

func categories(ds []Diff) []string {
	out := make([]string, 0, len(ds))
	for _, d := range ds {
		out = append(out, d.Category+"/"+d.Kind)
	}
	return out
}

func TestCompareResponse(t *testing.T) {
	private := "max-age=0, private, no-cache"
	public := "public, max-age=60, s-maxage=60, stale-while-revalidate=30"
	cases := []struct {
		name      string
		goHeaders map[string]string
		node      map[string]string
		want      []string
	}{
		{"same", map[string]string{"cache-control": public}, map[string]string{"cache-control": public}, []string{}},
		{"cache-control value", map[string]string{"cache-control": private}, map[string]string{"cache-control": public},
			[]string{"header:cache-control/value"}},
		{"cache-control directive order and case are noise", map[string]string{"cache-control": "public, s-maxage=60, max-age=60, stale-while-revalidate=30"},
			map[string]string{"cache-control": "Public,max-age=60 , s-maxage=060, stale-while-revalidate=30"}, []string{}},
		{"cache-tag only on node", map[string]string{"cache-control": public},
			map[string]string{"cache-control": public, "cache-tag": "images, user-1"}, []string{"header:cache-tag/missing-in-go"}},
		{"cache-tag order is noise", map[string]string{"cache-tag": "user-1, images"}, map[string]string{"cache-tag": "images,user-1"}, []string{}},
		{"set-cookie by presence", map[string]string{"set-cookie": "a=b"}, map[string]string{"set-cookie": "present"}, []string{}},
		{"set-cookie only from go", map[string]string{"set-cookie": "a=b"}, map[string]string{}, []string{"header:set-cookie/missing-in-node"}},
		{"vary as a set", map[string]string{"vary": "Accept-Encoding, Cookie"}, map[string]string{"vary": "cookie,accept-encoding"}, []string{}},
		{"update required only on node", nil, map[string]string{"x-update-required": "true"}, []string{"header:x-update-required/missing-in-go"}},
		{"an empty value is absent", map[string]string{"vary": " "}, map[string]string{}, []string{}},
		{"uncompared header ignored", map[string]string{"x-handled-by": "pod-a"}, map[string]string{"x-handled-by": "pod-b"}, []string{}},
		{"case-insensitive names", map[string]string{"Cache-Control": public}, map[string]string{"cache-control": public}, []string{}},
	}
	for _, c := range cases {
		if got := categories(CompareResponse(c.goHeaders, c.node)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

// The REST list: ComparedHeaders plus the ETag, the CORS headers, X-Frame-Options and X-Expires, each
// with its own noise rule. The base list (CompareResponse) never compares the extra ones.
func TestCompareResponseHeadersREST(t *testing.T) {
	want := []string{"cache-control", "vary", "cache-tag", "set-cookie", "x-update-required", "etag",
		"access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods",
		"access-control-expose-headers", "x-frame-options", "x-expires"}
	if !reflect.DeepEqual(RESTComparedHeaders, want) {
		t.Fatalf("RESTComparedHeaders = %v", RESTComparedHeaders)
	}
	if len(ComparedHeaders) != 5 {
		t.Fatalf("building the REST list changed the base list: %v", ComparedHeaders)
	}
	cases := []struct {
		name      string
		goHeaders map[string]string
		node      map[string]string
		want      []string
	}{
		{"same etag", map[string]string{"etag": `"abc12"`}, map[string]string{"etag": `"abc12"`}, []string{}},
		{"etag exact (case matters)", map[string]string{"etag": `"abc12"`}, map[string]string{"etag": `"ABC12"`}, []string{"header:etag/value"}},
		{"etag only from go", map[string]string{"etag": `"a"`}, map[string]string{}, []string{"header:etag/missing-in-node"}},
		{"allow-headers as a set", map[string]string{"access-control-allow-headers": "Authorization, Content-Type, *"},
			map[string]string{"access-control-allow-headers": "content-type,*, authorization"}, []string{}},
		{"allow-headers differ", map[string]string{"access-control-allow-headers": "Authorization, Content-Type, *"},
			map[string]string{"access-control-allow-headers": "Authorization, Content-Type"}, []string{"header:access-control-allow-headers/value"}},
		{"allow-methods as a set", map[string]string{"access-control-allow-methods": "GET, OPTIONS"},
			map[string]string{"access-control-allow-methods": "options,get"}, []string{}},
		{"allow-origin exact", map[string]string{"access-control-allow-origin": "*"},
			map[string]string{"access-control-allow-origin": "https://a.example"}, []string{"header:access-control-allow-origin/value"}},
		{"expose-headers only on node", nil, map[string]string{"access-control-expose-headers": "Retry-After"},
			[]string{"header:access-control-expose-headers/missing-in-go"}},
		{"x-frame-options case-insensitive", map[string]string{"x-frame-options": "DENY"}, map[string]string{"x-frame-options": "deny"}, []string{}},
		{"x-frame-options differ", map[string]string{"x-frame-options": "DENY"}, map[string]string{"x-frame-options": "SAMEORIGIN"},
			[]string{"header:x-frame-options/value"}},
		{"x-expires only on node", nil, map[string]string{"x-expires": "2026-11-21T00:00:00.000Z"}, []string{"header:x-expires/missing-in-go"}},
	}
	for _, c := range cases {
		if got := categories(CompareResponseHeaders(c.goHeaders, c.node, RESTComparedHeaders)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	if got := CompareResponse(map[string]string{"etag": `"a"`}, map[string]string{"etag": `"b"`, "x-expires": "x"}); len(got) != 0 {
		t.Fatalf("the base list compared a REST header: %v", categories(got))
	}
}

// Integers past 2^53 compare exactly: as float64, 9007199254740993 reads as 9007199254740992, so the
// old compare called them equal. Large integers that differ by one compare unequal at any size the
// relative tolerance would have equated, too; a float and its integer spelling still match.
func TestSameNumberIsExactForIntegers(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"9007199254740993", "9007199254740992", false},
		{"9007199254740993", "9007199254740993", true},
		{"1000000000000001", "1000000000000000", false}, // below 2^53, inside the old 1e-12 tolerance
		{"123456789012345678901234567890", "123456789012345678901234567891", false},
		{"123456789012345678901234567890", "123456789012345678901234567890", true},
		{"-0", "0", true},
		{"1", "1.0", true},
		{"1e3", "1000", true},
		{"0.1", "0.10000000000000001", true},
	}
	for _, c := range cases {
		if got := sameNumber(json.Number(c.a), json.Number(c.b)); got != c.want {
			t.Errorf("sameNumber(%s, %s) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// End to end through Compare: a page whose id differs past 2^53 is a value diff.
func TestCompareBigIntegerIDs(t *testing.T) {
	r, err := Compare([]byte(`{"json":{"items":[{"id":9007199254740993}]}}`), []byte(`{"json":{"items":[{"id":9007199254740992}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if r.Match || len(r.Diffs) != 1 || r.Diffs[0].Path != "items.0.id" || r.Diffs[0].Kind != "value" {
		t.Fatalf("report = %+v, want one value diff at items.0.id", r)
	}
}
