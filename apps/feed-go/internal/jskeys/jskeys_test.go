package jskeys

import (
	"math/rand/v2"
	"slices"
	"strconv"
	"testing"
)

// The canonical-index rule, at its bound and on every non-canonical spelling.
func TestArrayIndex(t *testing.T) {
	for k, want := range map[string]int64{
		"0": 0, "7": 7, "17": 17, "4294967294": 4294967294,
		"4294967295": -1, "4294967296": -1, "99999999999": -1, "18446744073709551616": -1,
		"": -1, "00": -1, "01": -1, "-1": -1, "+1": -1, "1e3": -1, " 1": -1, "1 ": -1, "1_0": -1,
		"0x1": -1, "1.0": -1, "a": -1,
	} {
		n, ok := ArrayIndex(k)
		if want < 0 {
			if ok {
				t.Errorf("ArrayIndex(%q) = %d, true; want not an index", k, n)
			}
			continue
		}
		if !ok || n != uint64(want) {
			t.Errorf("ArrayIndex(%q) = %d, %v; want %d, true", k, n, ok, want)
		}
	}
}

func keyOf(s string) string { return s }

func TestOrder(t *testing.T) {
	in := []string{"b", "2", "1", "a", "10", "01", "-1", "4294967295", "4294967294", "0"}
	want := []string{"0", "1", "2", "10", "4294967294", "b", "a", "01", "-1", "4294967295"}
	if got := Order(in, keyOf); !slices.Equal(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
	// No index key: the slice itself, untouched.
	plain := []string{"b", "a", "01"}
	if got := Order(plain, keyOf); &got[0] != &plain[0] || !slices.Equal(got, []string{"b", "a", "01"}) {
		t.Fatalf("no index key: got %v", got)
	}
	// Two items with one index keep their order (stable).
	type kv struct{ k, v string }
	dup := []kv{{"x", "x"}, {"3", "first"}, {"1", "one"}, {"3", "second"}}
	got := Order(dup, func(e kv) string { return e.k })
	if want := []kv{{"1", "one"}, {"3", "first"}, {"3", "second"}, {"x", "x"}}; !slices.Equal(got, want) {
		t.Fatalf("stable: got %v", got)
	}
}

// Many index keys, inserted shuffled between named ones: ascending numeric order, then the names in
// insertion order.
func TestOrderManyIndexKeys(t *testing.T) {
	const n = 2000
	r := rand.New(rand.NewPCG(1, 2)) //nolint:gosec // G404: a reproducible shuffle, not a secret
	perm := r.Perm(n)
	in, names := make([]string, 0, n+n/100), make([]string, 0, n/100)
	for i, p := range perm {
		in = append(in, strconv.Itoa(p))
		if i%100 == 0 {
			name := "k" + strconv.Itoa(i)
			in = append(in, name)
			names = append(names, name)
		}
	}
	got := Order(in, keyOf)
	if len(got) != n+len(names) {
		t.Fatalf("%d keys, want %d", len(got), n+len(names))
	}
	for i := 0; i < n; i++ {
		if got[i] != strconv.Itoa(i) {
			t.Fatalf("position %d = %q, want %q", i, got[i], strconv.Itoa(i))
		}
	}
	if !slices.Equal(got[n:], names) {
		t.Fatalf("named keys %v, want %v", got[n:], names)
	}
}
