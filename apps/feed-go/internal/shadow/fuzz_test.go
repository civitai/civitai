package shadow

import (
	"sort"
	"testing"
)

// swapped is a report's diffs with the two sides exchanged (missing-in-go <-> missing-in-node), as
// sorted strings: comparing (b, a) must give exactly this for (a, b).
func swapped(r *Report) []string {
	out := make([]string, 0, len(r.Diffs))
	for _, d := range r.Diffs {
		kind := d.Kind
		switch kind {
		case "missing-in-go":
			kind = "missing-in-node"
		case "missing-in-node":
			kind = "missing-in-go"
		}
		out = append(out, d.Path+"|"+d.Category+"|"+kind)
	}
	sort.Strings(out)
	return out
}

func diffs(r *Report) []string {
	out := make([]string, 0, len(r.Diffs))
	for _, d := range r.Diffs {
		out = append(out, d.Path+"|"+d.Category+"|"+d.Kind)
	}
	sort.Strings(out)
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// checkSymmetric: (a, b) and (b, a) either both fail or report the same differences with the sides
// exchanged, and the same verdict.
func checkSymmetric(t *testing.T, ab, ba *Report, errAB, errBA error, a, b []byte) {
	t.Helper()
	if (errAB == nil) != (errBA == nil) {
		t.Fatalf("asymmetric errors: (a,b) %v, (b,a) %v\na=%q\nb=%q", errAB, errBA, a, b)
	}
	if errAB != nil {
		return
	}
	if ab.Match != ba.Match || ab.Truncated != ba.Truncated {
		t.Fatalf("asymmetric verdict: (a,b) match=%v truncated=%v, (b,a) match=%v truncated=%v\na=%q\nb=%q",
			ab.Match, ab.Truncated, ba.Match, ba.Truncated, a, b)
	}
	if !ab.Truncated && !equal(diffs(ab), swapped(ba)) {
		t.Fatalf("asymmetric diffs:\n(a,b) %v\n(b,a) swapped %v\na=%q\nb=%q", diffs(ab), swapped(ba), a, b)
	}
}

// FuzzCompare: Compare never panics, an envelope always matches itself, and comparing (b, a) is the
// mirror of comparing (a, b). Seed corpus: testdata/fuzz/FuzzCompare.
func FuzzCompare(f *testing.F) {
	f.Add([]byte(`{"json":{"a":1}}`), []byte(`{"json":{"a":1.0}}`))
	f.Add([]byte(`{"json":{"a":null,"b":[1,null]},"meta":{"values":{"a":["undefined"],"b.1":["undefined"]},"v":1}}`),
		[]byte(`{"json":{"b":[1,2]},"meta":{"values":{"a":["undefined"]},"v":1}}`))
	f.Fuzz(func(t *testing.T, a, b []byte) {
		if r, err := Compare(a, a); err == nil && !r.Match {
			t.Fatalf("an envelope does not match itself: %+v\na=%q", r, a)
		}
		ab, errAB := Compare(a, b)
		ba, errBA := Compare(b, a)
		checkSymmetric(t, ab, ba, errAB, errBA, a, b)
		if errAB == nil {
			_ = Classify(ab, a, b)
			// The flat (image.getInfinite) classifier reads the same envelopes; on a match it agrees.
			if got := ClassifyFlat(ab, a, b); ab.Match && got != "match" {
				t.Fatalf("ClassifyFlat of a match = %q\na=%q\nb=%q", got, a, b)
			}
		}
	})
}

// FuzzCompareJSON: the same properties for the plain-JSON comparator. Only the node side must be an
// object, so symmetry is checked when both orders compare. Seed corpus: testdata/fuzz/FuzzCompareJSON.
func FuzzCompareJSON(f *testing.F) {
	f.Add([]byte(`{"items":[{"id":1}],"metadata":{"nextCursor":"2"}}`), []byte(`{"items":[{"id":1,"x":true}]}`))
	f.Fuzz(func(t *testing.T, a, b []byte) {
		if r, err := CompareJSON(a, a); err == nil && !r.Match {
			t.Fatalf("a body does not match itself: %+v\na=%q", r, a)
		}
		ab, errAB := CompareJSON(a, b)
		ba, errBA := CompareJSON(b, a)
		if errAB == nil && errBA == nil {
			checkSymmetric(t, ab, ba, nil, nil, a, b)
		}
		if errAB == nil {
			_ = ClassifyJSON(ab, a, b)
		}
	})
}
