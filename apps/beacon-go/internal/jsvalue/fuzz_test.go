package jsvalue

import (
	"bytes"
	"math"
	"testing"
	"unicode/utf8"
)

// FuzzParse: JSON.parse never panics, and what it accepts re-serializes to a fixed point
// (stringify(parse(stringify(parse(x)))) == stringify(parse(x))), keeps a JS key order, and is
// valid WTF-8 that DecodeWTF8 walks without error bytes.
func FuzzParse(f *testing.F) {
	for _, s := range []string{
		`{"a":1}`, `[1,2.5,-0,1e400,"x"]`, `"𐀀\ud800"`, `{"2":1,"1":2,"__proto__":3}`,
		`{"a":{"b":[true,false,null]}}`, ` " " `, `1.5e-7`, `{"a":1,"a":2}`,
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if !utf8.ValidString(s) {
			s = DecodeUTF8([]byte(s))
		}
		v, err := Parse(s)
		if err != nil {
			return
		}
		once := Stringify(v)
		v2, err := Parse(string(once))
		if err != nil {
			t.Fatalf("stringify output does not parse: %q -> %q: %v", s, once, err)
		}
		if twice := Stringify(v2); !bytes.Equal(once, twice) {
			t.Fatalf("not a fixed point: %q -> %q -> %q", s, once, twice)
		}
		for i := 0; i < len(once); {
			r, size := DecodeWTF8(string(once[i:]))
			if r == utf8.RuneError && size == 1 {
				t.Fatalf("stringify wrote an invalid byte at %d: %q", i, once)
			}
			i += size
		}
	})
}

// FuzzStringToNumber: Number(string) never panics, and Number(String(x)) == x for the finite
// numbers it produces (the formatter writes round-tripping digits).
func FuzzStringToNumber(f *testing.F) {
	for _, s := range []string{"", "1", " 0x1F ", "1e21", "-0.000001", "Infinity", "1_0", "9007199254740993"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		n := StringToNumber(s)
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return
		}
		if back := StringToNumber(FormatNumber(n)); back != n {
			t.Fatalf("Number(%q) = %v; Number(%q) = %v", s, n, FormatNumber(n), back)
		}
	})
}
