package v1models

import (
	_ "embed"
	"encoding/json"
	"strings"
	"sync"
	"unicode/utf16"
)

// jsCanonJSON is ECMA-262's Canonicalize (22.2.2.7.3) for a non-unicode, ignoreCase RegExp, as the
// Node app's engine computes it: each UTF-16 code unit whose canonical value is not itself, with that
// value (every other unit is its own). Written by testdata/golden/gen-v1-filenames.mjs from the Node
// engine itself (V8 derives it from ICU's toUpper), each entry checked there against the RegExp
// engine; src/server/services/__tests__/feed-go-js-canonicalize.parity.test.ts recomputes it in the
// Node the app runs on and fails when the two differ, so a Node upgrade that moves a case mapping is
// caught there and this file is regenerated.
//
//go:embed jscanon.json
var jsCanonJSON []byte

// jsTables are jsCanonJSON's two tables: the canonical value of every code unit, and the code units
// String.prototype.trim removes.
type jsTables struct {
	canon []uint16
	trim  map[rune]bool
}

var jsTablesOnce = sync.OnceValue(func() *jsTables {
	var t struct {
		Canon [][2]uint16 `json:"canon"`
		Trim  []uint16    `json:"trim"`
	}
	if err := json.Unmarshal(jsCanonJSON, &t); err != nil || len(t.Trim) == 0 {
		panic("v1models: jscanon.json does not hold the tables")
	}
	out := &jsTables{canon: make([]uint16, 0x10000), trim: make(map[rune]bool, len(t.Trim))}
	for i := range out.canon {
		out.canon[i] = uint16(i) //nolint:gosec // G115: i < 0x10000
	}
	for _, p := range t.Canon {
		out.canon[p[0]] = p[1]
	}
	for _, u := range t.Trim {
		out.trim[rune(u)] = true
	}
	return out
})

func jsCanon() []uint16 { return jsTablesOnce().canon }

// replaceInsensitiveUTF16 is `value.replace(new RegExp(<search, escaped>, 'gi'), "")` for any text:
// the pattern is a literal, so it matches wherever the next len(search) UTF-16 code units of value
// have, one by one, the canonical values of search's (jsCanon); each match, leftmost first and never
// overlapping, is removed. Both strings are valid UTF-8 (Postgres text), so their UTF-16 forms hold
// no lone surrogate, and a surrogate (its own canonical value) only ever matches itself.
func replaceInsensitiveUTF16(value, search string) string {
	canon := jsCanon()
	v := utf16.Encode([]rune(value))
	s := utf16.Encode([]rune(search))
	want := make([]uint16, len(s))
	for i, u := range s {
		want[i] = canon[u]
	}
	out := make([]uint16, 0, len(v))
	for i := 0; i < len(v); {
		if i+len(want) <= len(v) && canonEqual(canon, v[i:i+len(want)], want) {
			i += len(want)
			continue
		}
		out = append(out, v[i])
		i++
	}
	return string(utf16.Decode(out))
}

func canonEqual(canon, units, want []uint16) bool {
	for i, u := range units {
		if canon[u] != want[i] {
			return false
		}
	}
	return true
}

// jsTrimText is String.prototype.trim: the leading and trailing code points of the Node engine's
// WhiteSpace and LineTerminator set (jscanon.json's `trim`, all in the BMP) removed.
func jsTrimText(s string) string {
	trim := jsTablesOnce().trim
	return strings.TrimFunc(s, func(r rune) bool { return trim[r] })
}
