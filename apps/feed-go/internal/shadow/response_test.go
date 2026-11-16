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
		name       string
		goStatus   int
		goHeaders  map[string]string
		nodeStatus int
		node       map[string]string
		want       []string
	}{
		{"same", 200, map[string]string{"cache-control": public}, 200, map[string]string{"cache-control": public}, []string{}},
		{"status", 200, nil, 451, map[string]string{}, []string{"status/value"}},
		{"status not sent", 200, nil, 0, nil, []string{}},
		{"go status differs", 503, nil, 200, map[string]string{}, []string{"status/value"}},
		{"headers not sent: status only", 200, map[string]string{"cache-control": public}, 200, nil, []string{}},
		{"cache-control value", 200, map[string]string{"cache-control": private}, 200, map[string]string{"cache-control": public},
			[]string{"header:cache-control/value"}},
		{"cache-control directive order and case are noise", 200, map[string]string{"cache-control": "public, s-maxage=60, max-age=60, stale-while-revalidate=30"},
			200, map[string]string{"cache-control": "Public,max-age=60 , s-maxage=060, stale-while-revalidate=30"}, []string{}},
		{"cache-tag only on node", 200, map[string]string{"cache-control": public}, 200,
			map[string]string{"cache-control": public, "cache-tag": "images, user-1"}, []string{"header:cache-tag/missing-in-go"}},
		{"cache-tag order is noise", 200, map[string]string{"cache-tag": "user-1, images"}, 200, map[string]string{"cache-tag": "images,user-1"}, []string{}},
		{"set-cookie by presence", 200, map[string]string{"set-cookie": "a=b"}, 200, map[string]string{"set-cookie": "present"}, []string{}},
		{"set-cookie only from go", 200, map[string]string{"set-cookie": "a=b"}, 200, map[string]string{}, []string{"header:set-cookie/missing-in-node"}},
		{"vary as a set", 200, map[string]string{"vary": "Accept-Encoding, Cookie"}, 200, map[string]string{"vary": "cookie,accept-encoding"}, []string{}},
		{"update required only on node", 200, nil, 200, map[string]string{"x-update-required": "true"}, []string{"header:x-update-required/missing-in-go"}},
		{"an empty value is absent", 200, map[string]string{"vary": " "}, 200, map[string]string{}, []string{}},
		{"uncompared header ignored", 200, map[string]string{"x-handled-by": "pod-a"}, 200, map[string]string{"x-handled-by": "pod-b"}, []string{}},
		{"case-insensitive names", 200, map[string]string{"Cache-Control": public}, 200, map[string]string{"cache-control": public}, []string{}},
	}
	for _, c := range cases {
		if got := categories(CompareResponse(c.goStatus, c.goHeaders, c.nodeStatus, c.node)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
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
