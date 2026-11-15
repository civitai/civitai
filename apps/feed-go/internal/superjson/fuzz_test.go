package superjson

import (
	"encoding/json"
	"math"
	"strconv"
	"testing"
	"time"
	"unicode/utf8"
)

// FuzzAppendString: appendString is byte-for-byte encoding/json's string encoding (HTML escaping
// off), so the bytes decode back to the input (invalid UTF-8 bytes to U+FFFD, as encoding/json does).
// Seed corpus: testdata/fuzz/FuzzAppendString.
func FuzzAppendString(f *testing.F) {
	for _, c := range stringCases {
		f.Add(c.in)
	}
	f.Fuzz(func(t *testing.T, s string) {
		got := appendString(nil, s)
		if want := stdlibString(t, s); string(got) != want {
			t.Fatalf("appendString(%q) = %s, encoding/json = %s", s, got, want)
		}
		var back string
		if err := json.Unmarshal(got, &back); err != nil {
			t.Fatalf("appendString(%q) = %s is not a JSON string: %v", s, got, err)
		}
		if utf8.ValidString(s) && back != s {
			t.Fatalf("appendString(%q) decodes to %q", s, back)
		}
	})
}

// decodedString is what a JSON reader sees for s once written: s with each invalid UTF-8 byte
// replaced by U+FFFD (the oracle is encoding/json, not the code under test).
func decodedString(t *testing.T, s string) string {
	t.Helper()
	var out string
	if err := json.Unmarshal([]byte(stdlibString(t, s)), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// FuzzSerialize: for any key, string, number and bool, Serialize never panics, writes valid JSON in
// the `{json, meta}` shape, carries the values through, and annotates the undefined members and the
// Date at their escaped paths. A non-finite float is refused, never written. Seed corpus:
// testdata/fuzz/FuzzSerialize.
func FuzzSerialize(f *testing.F) {
	f.Add("key", "value", int64(1), 1.5, true)
	f.Add("a.b\\c", "line\nbreak   \xff", int64(-1), 1e21, false)
	f.Fuzz(func(t *testing.T, key, val string, n int64, fl float64, b bool) {
		at := time.Date(2024, 1, 2, 3, 4, 5, 6_000_000, time.UTC)
		v := Object{
			{"k", Object{{key, val}}},
			{"u", Object{{key, Undefined{}}}},
			{"n", n},
			{"f", fl},
			{"b", b},
			{"a", []any{val, Undefined{}, nil}},
			{"t", at},
		}
		out, err := Serialize(v)
		finite := !math.IsNaN(fl) && !math.IsInf(fl, 0)
		if !finite {
			if err == nil {
				t.Fatalf("Serialize wrote a non-finite float: %s", out)
			}
			return
		}
		if err != nil {
			t.Fatalf("Serialize: %v", err)
		}
		var env struct {
			JSON struct {
				K map[string]string `json:"k"`
				U map[string]any    `json:"u"`
				N json.Number       `json:"n"`
				F float64           `json:"f"`
				B bool              `json:"b"`
				A []any             `json:"a"`
				T string            `json:"t"`
			} `json:"json"`
			Meta struct {
				Values map[string][]string `json:"values"`
				V      int                 `json:"v"`
			} `json:"meta"`
		}
		if err := json.Unmarshal(out, &env); err != nil {
			t.Fatalf("Serialize wrote invalid JSON %s: %v", out, err)
		}
		wantKey, wantVal := decodedString(t, key), decodedString(t, val)
		if got, ok := env.JSON.K[wantKey]; !ok || got != wantVal || len(env.JSON.K) != 1 {
			t.Fatalf("k = %v, want {%q: %q}", env.JSON.K, wantKey, wantVal)
		}
		if len(env.JSON.U) != 0 {
			t.Fatalf("an undefined member was written: u = %v", env.JSON.U)
		}
		if env.JSON.N.String() != strconv.FormatInt(n, 10) || env.JSON.F != fl || env.JSON.B != b {
			t.Fatalf("scalars: n %s f %v b %v, want %d %v %v", env.JSON.N, env.JSON.F, env.JSON.B, n, fl, b)
		}
		if len(env.JSON.A) != 3 || env.JSON.A[0] != wantVal || env.JSON.A[1] != nil || env.JSON.A[2] != nil {
			t.Fatalf("a = %v", env.JSON.A)
		}
		if env.JSON.T != FormatDate(at) {
			t.Fatalf("t = %q", env.JSON.T)
		}
		undefPath := "u." + decodedString(t, EscapeKey(key))
		want := map[string]string{undefPath: "undefined", "a.1": "undefined", "t": "Date"}
		if len(env.Meta.Values) != len(want) || env.Meta.V != 1 {
			t.Fatalf("meta = %+v, want values %v", env.Meta, want)
		}
		for p, typ := range want {
			if got := env.Meta.Values[p]; len(got) != 1 || got[0] != typ {
				t.Fatalf("meta.values[%q] = %v, want [%s] (all: %v)", p, got, typ, env.Meta.Values)
			}
		}
		plain, err := Plain(v)
		if err != nil || !json.Valid(plain) {
			t.Fatalf("Plain = %s, %v", plain, err)
		}
	})
}
