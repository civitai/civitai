package devalue

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"reflect"
	"strconv"
	"testing"
	"time"
	"unicode/utf8"
	"unsafe"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// gen builds random values in the superjson value model, with references reused at random so the
// same object, array or Date sits at several places (the dedup the writer must get right).
type gen struct {
	r      *rand.Rand
	shared []any // containers and *time.Time built so far, reusable as a second reference
	raws   []json.RawMessage
}

var genStrings = []string{"", "a", "b", "user", "<", "</script>", "\"", "\\", "\n", "\t\r", "\x00", "\x1f", "\x7f",
	"\u2028", "\u2029", "\u00e9", "\U0001F600", "mixed <a href=\"x\">\\n</a>", "1", "01"}

var genKeys = []string{"id", "name", "a", "b", "1", "2", "10", "01", "-1", "<", "\"q\"", "", "k.k", "\u2028"}

func (g *gen) leaf() any {
	switch g.r.IntN(13) {
	case 0:
		return nil
	case 1:
		return g.r.IntN(2) == 0
	case 2, 3:
		return genStrings[g.r.IntN(len(genStrings))]
	case 4:
		return int64(g.r.IntN(2000) - 1000)
	case 5:
		return g.r.Int64N(1<<53) - 1<<52
	case 6:
		return []float64{0.1, 1.5, -2.25, 1e21, 1e-7, 123456.789, 5e-324, math.Copysign(0, -1), 1e300}[g.r.IntN(9)]
	case 7:
		return superjson.Undefined{}
	case 8:
		return time.UnixMilli(g.r.Int64N(4e12) - 1e12).UTC()
	case 9:
		t := new(time.Time)
		*t = time.UnixMilli(g.r.Int64N(4e12)).UTC()
		g.shared = append(g.shared, t)
		return t
	case 10:
		return g.r.Int32N(100)
	case 11:
		return g.r.Uint32N(100)
	default:
		return float32(0.5)
	}
}

func (g *gen) value(depth int) any {
	if depth <= 0 || g.r.IntN(3) == 0 {
		if len(g.shared) > 0 && g.r.IntN(6) == 0 {
			return g.shared[g.r.IntN(len(g.shared))]
		}
		return g.leaf()
	}
	switch g.r.IntN(5) {
	case 0, 1:
		n := g.r.IntN(5)
		// Capacity 0 for some empty objects: those are new values each time they are reached.
		obj := make(superjson.Object, 0, n)
		seen := map[string]bool{}
		for i := 0; i < n; i++ {
			k := genKeys[g.r.IntN(len(genKeys))]
			if seen[k] {
				continue
			}
			seen[k] = true
			obj = append(obj, superjson.Field{Key: k, Val: g.value(depth - 1)})
		}
		if cap(obj) > 0 {
			g.shared = append(g.shared, obj)
		}
		return obj
	case 2:
		n := g.r.IntN(5)
		arr := make([]any, n)
		for i := range arr {
			arr[i] = g.value(depth - 1)
		}
		if n > 0 {
			g.shared = append(g.shared, arr)
		}
		return arr
	case 3:
		ints := make([]int, g.r.IntN(4))
		for i := range ints {
			ints[i] = g.r.IntN(5)
		}
		if len(ints) > 0 {
			g.shared = append(g.shared, ints)
		}
		return ints
	default:
		if len(g.raws) > 0 && g.r.IntN(3) == 0 {
			return g.raws[g.r.IntN(len(g.raws))]
		}
		str, _ := json.Marshal(genStrings[g.r.IntN(len(genStrings))])
		raw := json.RawMessage(fmt.Sprintf(`{"b":%d,"a":[%s,{"c":null}],"2":true}`, g.r.IntN(5), str))
		g.raws = append(g.raws, raw)
		return raw
	}
}

// identity is a value's JS object identity, or ok false for a value that has none (a primitive, a
// time.Time, a slice without capacity).
func identity(v any) (ref, bool) {
	switch t := v.(type) {
	case superjson.Object:
		return sliceRef(refObject, t)
	case *superjson.Object:
		return sliceRef(refObject, *t)
	case []any:
		return sliceRef(refArray, t)
	case []int:
		return sliceRef(refInts, t)
	case Map:
		return sliceRef(refMap, t)
	case Set:
		return sliceRef(refSet, t)
	case *time.Time:
		return ref{kind: refDate, p: unsafe.Pointer(t)}, true //nolint:gosec // G103: identity only, never dereferenced
	}
	return ref{}, false
}

// graph checks that out (Parse's value) is in (the written value): equal leaves, and a bijection
// between in's object identities and out's, so every shared reference is shared in the text and
// nothing else is.
type graph struct {
	t    *testing.T
	fwd  map[ref]ref
	back map[ref]bool
	raws map[ref]any
}

func (g *graph) walk(path string, in, out any) {
	g.t.Helper()
	if raw, ok := in.(json.RawMessage); ok {
		r, has := sliceRef(refRaw, raw)
		parsed, seen := g.raws[r]
		if !seen || !has {
			var err error
			if parsed, err = ParseJSON(raw); err != nil {
				g.t.Fatalf("%s: %v", path, err)
			}
			if has {
				g.raws[r] = parsed
			}
		}
		in = parsed
	}
	if p, ok := in.(*superjson.Object); ok && p != nil {
		in = *p
	}
	switch t := in.(type) {
	case superjson.Object, []any, []int, Map, Set, *time.Time:
		if t == (*time.Time)(nil) {
			break
		}
		oi, ok := identity(out)
		if !ok {
			g.t.Fatalf("%s: written %T, read back %T without identity", path, in, out)
		}
		if ii, has := identity(in); has {
			if prev, seen := g.fwd[ii]; seen {
				if prev != oi {
					g.t.Fatalf("%s: one value written twice is two values read back", path)
				}
				return
			}
			g.fwd[ii] = oi
		}
		if g.back[oi] {
			g.t.Fatalf("%s: two values written are one value read back", path)
		}
		g.back[oi] = true
	}
	switch t := in.(type) {
	case nil:
		if out != nil {
			g.t.Fatalf("%s: nil read back as %#v", path, out)
		}
	case *time.Time:
		if t == nil {
			if out != nil {
				g.t.Fatalf("%s: nil *time.Time read back as %#v", path, out)
			}
			return
		}
		g.date(path, *t, out)
	case time.Time:
		g.date(path, t, out)
	case superjson.Undefined:
		if _, ok := out.(superjson.Undefined); !ok {
			g.t.Fatalf("%s: undefined read back as %#v", path, out)
		}
	case bool, string:
		want := in
		if s, ok := in.(string); ok && !utf8.ValidString(s) {
			want = string([]rune(s))
		}
		if out != want {
			g.t.Fatalf("%s: %#v read back as %#v", path, in, out)
		}
	case superjson.Object:
		o, ok := out.(superjson.Object)
		if !ok || len(o) != len(t) {
			g.t.Fatalf("%s: object read back as %#v", path, out)
		}
		for _, f := range t {
			v, ok := o.Get(f.Key)
			if !ok {
				g.t.Fatalf("%s: key %q lost", path, f.Key)
			}
			g.walk(path+"."+f.Key, f.Val, v)
		}
	case []any:
		a, ok := out.([]any)
		if !ok || len(a) != len(t) {
			g.t.Fatalf("%s: array read back as %#v", path, out)
		}
		for i := range t {
			g.walk(path+"."+strconv.Itoa(i), t[i], a[i])
		}
	case []int:
		a, ok := out.([]any)
		if !ok || len(a) != len(t) {
			g.t.Fatalf("%s: []int read back as %#v", path, out)
		}
		for i := range t {
			g.walk(path+"."+strconv.Itoa(i), t[i], a[i])
		}
	default:
		f, ok := toFloat(in)
		if !ok {
			g.t.Fatalf("%s: unexpected %T", path, in)
		}
		o, _ := out.(float64)
		if !(o == f && math.Signbit(o) == math.Signbit(f)) && !(math.IsNaN(o) && math.IsNaN(f)) {
			g.t.Fatalf("%s: %v read back as %#v", path, in, out)
		}
	}
}

func (g *graph) date(path string, want time.Time, out any) {
	g.t.Helper()
	got, ok := out.(*time.Time)
	if !ok || !got.Equal(want.Truncate(time.Millisecond)) {
		g.t.Fatalf("%s: Date %v read back as %#v", path, want, out)
	}
}

func toFloat(v any) (float64, bool) {
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(rv.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(rv.Uint()), true
	case reflect.Float32, reflect.Float64:
		return rv.Float(), true
	}
	return 0, false
}

// superjsonValue is v through the Go superjson writer, decoded generically (key order ignored): a
// second, independent reading of the value Parse returned.
func superjsonValue(t *testing.T, v any) any {
	t.Helper()
	b, err := superjson.Serialize(v)
	if err != nil {
		return "error: " + err.Error()
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("superjson wrote invalid JSON %s: %v", b, err)
	}
	return out
}

func checkRoundTrip(t *testing.T, v any) {
	t.Helper()
	text, err := Stringify(v)
	if err != nil {
		t.Fatalf("Stringify: %v", err)
	}
	payload, err := Payload(v)
	if err != nil {
		t.Fatalf("Payload: %v", err)
	}
	var unquoted string
	if err := json.Unmarshal(payload, &unquoted); err != nil || unquoted != text {
		t.Fatalf("payload %s is not the JSON string of %s (%v)", payload, text, err)
	}
	back, err := Parse(text)
	if err != nil {
		t.Fatalf("Parse(%s): %v", text, err)
	}
	again, err := Stringify(back)
	if err != nil || again != text {
		t.Fatalf("Stringify(Parse(text)) = %s, %v; want %s", again, err, text)
	}
	(&graph{t: t, fwd: map[ref]ref{}, back: map[ref]bool{}, raws: map[ref]any{}}).walk("$", v, back)
	if a, b := superjsonValue(t, v), superjsonValue(t, back); !reflect.DeepEqual(a, b) {
		t.Fatalf("superjson of the value %v\nsuperjson of the value read back %v\ntext %s", a, b, text)
	}
}

// FuzzRoundTrip: a random value with shared references, written, is read back (Parse) as the same
// value: equal leaves, every shared reference shared and nothing else, the same superjson; writing
// what was read gives the same text again. The seeds run on every `go test`.
func FuzzRoundTrip(f *testing.F) {
	for seed := uint64(0); seed < 400; seed++ {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, seed uint64) {
		g := &gen{r: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))} //nolint:gosec // G404: a reproducible test generator, not a secret
		checkRoundTrip(t, g.value(5))
	})
}

// FuzzString: any string, valid UTF-8 or not, is written as one entry that reads back as the string
// a JS reader holds (U+FFFD for each invalid byte), and the payload is a JSON string.
func FuzzString(f *testing.F) {
	for _, s := range genStrings {
		f.Add(s)
	}
	f.Add("a\xffb\xc3")
	f.Fuzz(func(t *testing.T, s string) {
		text, err := Stringify([]any{s, s})
		if err != nil {
			t.Fatal(err)
		}
		back, err := Parse(text)
		if err != nil {
			t.Fatalf("Parse(%q): %v", text, err)
		}
		arr, _ := back.([]any)
		want := string([]rune(s)) // each invalid byte as U+FFFD
		if len(arr) != 2 || arr[0] != want || arr[1] != want {
			t.Fatalf("%q read back as %#v", s, back)
		}
		var entries []json.RawMessage
		if err := json.Unmarshal([]byte(text), &entries); err != nil || len(entries) != 2 {
			t.Fatalf("%q: %d entries (%v), want the array and one string", s, len(entries), err)
		}
	})
}
