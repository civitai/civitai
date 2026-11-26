// Package jskeys is the one definition of a JS object's own-key order (OrdinaryOwnPropertyKeys, which
// Object.keys, for…in, JSON.stringify, msgpackr and devalue all follow): the array-index keys first,
// ascending by numeric value, then every other key in insertion order.
package jskeys

import (
	"cmp"
	"slices"
	"strconv"
)

// maxArrayIndex is the largest array index, 2^32-2 (an index is below 2^32-1).
const maxArrayIndex = 1<<32 - 2

// ArrayIndex reports whether k is a canonical array index and returns its value: decimal digits only,
// no leading zero ("0" itself is one), at most 2^32-2. "01", "-1", "+1", "1e3" and "4294967295" are
// not.
func ArrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	if err != nil || n > maxArrayIndex {
		return 0, false
	}
	return n, true
}

// Order returns items in JS own-key order, key giving each item's key. With no array-index key it
// returns items itself; otherwise a new slice. Each key is parsed once; the sort is stable, so items
// with one index keep their relative order.
func Order[S ~[]E, E any](items S, key func(E) string) S {
	type indexed struct {
		n   uint64
		pos int
	}
	var idx []indexed
	for i, it := range items {
		if n, ok := ArrayIndex(key(it)); ok {
			idx = append(idx, indexed{n: n, pos: i})
		}
	}
	if len(idx) == 0 {
		return items
	}
	slices.SortStableFunc(idx, func(a, b indexed) int { return cmp.Compare(a.n, b.n) })
	isIndex := make([]bool, len(items))
	out := make(S, 0, len(items))
	for _, x := range idx {
		isIndex[x.pos] = true
		out = append(out, items[x.pos])
	}
	for i, it := range items {
		if !isIndex[i] {
			out = append(out, it)
		}
	}
	return out
}
