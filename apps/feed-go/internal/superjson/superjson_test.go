package superjson

import (
	"bytes"
	"encoding/json"
	"math"
	"math/rand/v2"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// Expected strings below are what `superjson.serialize` (2.2.x) produces for the equivalent JS value,
// written out by hand from its walker (node_modules/superjson/dist/plainer.js): annotations are a flat
// path map in traversal order, an undefined object member is dropped from `json` but annotated, an
// undefined array element becomes null and is annotated, and `meta.v` is 1 whenever meta exists.

func TestSerializePlainHasNoMeta(t *testing.T) {
	got, err := Serialize(Object{{"a", 1}, {"b", "x"}, {"c", []any{true, nil}}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"json":{"a":1,"b":"x","c":[true,null]}}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestSerializeDatesAndUndefined(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 6_000_000, time.UTC)
	v := Object{
		{"a", ts},
		{"b", Undefined{}},
		{"c", []any{Undefined{}, 1}},
		{"d", Object{{"e", ts}}},
	}
	got, err := Serialize(v)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"json":{"a":"2024-01-02T03:04:05.006Z","c":[null,1],"d":{"e":"2024-01-02T03:04:05.006Z"}},` +
		`"meta":{"values":{"a":["Date"],"b":["undefined"],"c.0":["undefined"],"d.e":["Date"]},"v":1}}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestSerializeEscapesDotsInPathKeys(t *testing.T) {
	ts := time.Date(2024, 1, 2, 0, 0, 0, 0, time.FixedZone("x", 3600))
	got, err := Serialize(Object{{"x.y", Object{{`a\b`, ts}}}})
	if err != nil {
		t.Fatal(err)
	}
	// The date is rendered in UTC, like Date#toISOString.
	want := `{"json":{"x.y":{"a\\b":"2024-01-01T23:00:00.000Z"}},"meta":{"values":{"x\\.y.a\\\\b":["Date"]},"v":1}}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestSerializeRawJSONPassThrough(t *testing.T) {
	got, err := Serialize(Object{{"m", json.RawMessage(`{"k":[1,2]}`)}, {"n", json.RawMessage(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"json":{"m":{"k":[1,2]},"n":null}}`; string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestSerializeRootDate(t *testing.T) {
	got, err := Serialize(time.Date(2020, 5, 6, 7, 8, 9, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"json":"2020-05-06T07:08:09.000Z","meta":{"values":["Date"],"v":1}}`; string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestSerializeRejectsUnknownTypes(t *testing.T) {
	if _, err := Serialize(Object{{"x", struct{}{}}}); err == nil {
		t.Fatal("want an error for an unsupported type, got nil")
	}
}

func TestFormatNumberMatchesJS(t *testing.T) {
	cases := map[float64]string{
		0:        "0",
		1:        "1",
		-3:       "-3",
		0.5:      "0.5",
		1.25e-7:  "1.25e-7",
		1e21:     "1e+21",
		123456.7: "123456.7",
	}
	for in, want := range cases {
		if got := FormatNumber(in); got != want {
			t.Errorf("FormatNumber(%v) = %q, want %q", in, got, want)
		}
	}
}

func TestObjectSetKeepsPosition(t *testing.T) {
	o := Object{{"a", 1}, {"b", 2}}
	o.Set("a", 3)
	o.Set("c", 4)
	got, _ := Serialize(o)
	if want := `{"json":{"a":3,"b":2,"c":4}}`; string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

// stdlibString is the oracle for appendString: what the previous implementation wrote, the encoding/json
// encoder with HTML escaping off, minus the encoder's trailing newline.
func stdlibString(t testing.TB, s string) string {
	t.Helper()
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		t.Fatal(err)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// Expected values are written out by hand from encoding/json's appendString (encode.go, Go 1.26) with
// escapeHTML=false, NOT computed from the code under test.
var stringCases = []struct {
	name, in, want string
}{
	{"empty", "", `""`},
	{"plain", "hello world", `"hello world"`},
	{"quote", `a"b`, `"a\"b"`},
	{"backslash", `a\b`, `"a\\b"`},
	{"backspace", "\b", `"\b"`},
	{"formfeed", "\f", `"\f"`},
	{"newline", "\n", `"\n"`},
	{"carriage return", "\r", `"\r"`},
	{"tab", "\t", `"\t"`},
	{"nul", "\x00", `"\u0000"`},
	{"vertical tab", "\x0b", `"\u000b"`},
	{"escape", "\x1b", `"\u001b"`},
	{"unit separator", "\x1f", `"\u001f"`},
	{"space is not escaped", " ", `" "`},
	{"DEL is not escaped", "\x7f", "\"\x7f\""},
	{"line separator", "a\u2028b", `"a\u2028b"`},
	{"paragraph separator", "\u2029", `"\u2029"`},
	{"html is not escaped", "<a href='x'>&amp;</a>", `"<a href='x'>&amp;</a>"`},
	{"invalid byte", "\xff", `"\ufffd"`},
	{"invalid bytes in text", "a\xfe\xffb", `"a\ufffd\ufffdb"`},
	{"truncated multibyte", "x\xe2\x82", `"x\ufffd\ufffd"`},
	{"truncated multibyte mid-string", "\xe2\x82z", `"\ufffd\ufffdz"`},
	{"surrogate half", "\xed\xa0\x80", `"\ufffd\ufffd\ufffd"`},
	{"overlong encoding", "\xc0\xaf", `"\ufffd\ufffd"`},
	{"two-byte rune", "café", "\"café\""},
	{"three-byte rune", "€5", "\"€5\""},
	{"emoji", "hi 😀!", "\"hi 😀!\""},
	{"mixed", "\"\\\n\u2028é\x01", `"\"\\\n\u2028` + "é" + `\u0001"`},
}

func TestAppendStringLiterals(t *testing.T) {
	for _, c := range stringCases {
		if got := string(appendString(nil, c.in)); got != c.want {
			t.Errorf("%s: appendString(%q) = %s, want %s", c.name, c.in, got, c.want)
		}
		// The same bytes reach the envelope as a value and as a key.
		got, err := Serialize(Object{{c.in, c.in}})
		if err != nil {
			t.Fatal(err)
		}
		if want := `{"json":{` + c.want + `:` + c.want + `}}`; string(got) != want {
			t.Errorf("%s: Serialize = %s, want %s", c.name, got, want)
		}
	}
}

func TestAppendStringAppendsToExistingBytes(t *testing.T) {
	if got := string(appendString([]byte("x:"), "a\nb")); got != `x:"a\nb"` {
		t.Fatalf("got %s", got)
	}
}

// TestAppendStringMatchesEncodingJSON compares appendString against encoding/json (an independent
// implementation) over the literal cases, every single byte, and a deterministic pseudo-random corpus
// mixing raw bytes 0x00–0xff with runes that need care.
func TestAppendStringMatchesEncodingJSON(t *testing.T) {
	var corpus []string
	for _, c := range stringCases {
		corpus = append(corpus, c.in)
	}
	for b := 0; b < 256; b++ {
		corpus = append(corpus, string([]byte{byte(b)}), "a"+string([]byte{byte(b)})+"z")
	}
	pieces := []string{
		"\u2028", "\u2029", "\u2027", "\u202a", "\ufffd", "\U0010ffff", "é", "😀", "<", ">", "&",
		"\xed\xa0\x80", "\xed\xbf\xbf", // UTF-8-encoded surrogates: invalid in Go
		"\xe2\x80", "\xf0\x9f\x98", "\xf4\x90\x80\x80", "\xc0\x80",
	}
	rng := rand.New(rand.NewPCG(1, 2)) //nolint:gosec // G404: a seeded, reproducible test corpus
	for n := 0; n < 5000; n++ {
		var b []byte
		for l := rng.IntN(24); l > 0; l-- {
			switch rng.IntN(3) {
			case 0:
				b = append(b, byte(rng.IntN(256))) //nolint:gosec // G115: IntN(256) fits a byte
			case 1:
				b = append(b, pieces[rng.IntN(len(pieces))]...)
			default:
				b = utf8.AppendRune(b, rune(rng.IntN(0x110000))) //nolint:gosec // G115: IntN(0x110000) fits a rune
			}
		}
		corpus = append(corpus, string(b))
	}
	for _, s := range corpus {
		if got, want := string(appendString(nil, s)), stdlibString(t, s); got != want {
			t.Fatalf("appendString(%q) = %s, encoding/json = %s", s, got, want)
		}
	}
}

func TestAppendNumberMatchesFormatNumber(t *testing.T) {
	floats := []float64{0, math.Copysign(0, -1), 1, -1, 0.5, 1e-6, 9.99e-7, 1e-7, 1.25e-7, 1e20, 1e21,
		-1e21, 123456.7, 0.1 + 0.2, math.MaxFloat64, math.SmallestNonzeroFloat64, 1e100, 1e-100}
	rng := rand.New(rand.NewPCG(3, 4)) //nolint:gosec // G404: a seeded, reproducible test corpus
	for n := 0; n < 2000; n++ {
		floats = append(floats, math.Float64frombits(rng.Uint64()))
	}
	for _, f := range floats {
		if math.IsNaN(f) || math.IsInf(f, 0) {
			continue
		}
		if got, want := string(appendNumber([]byte("x"), f)), "x"+FormatNumber(f); got != want {
			t.Fatalf("appendNumber(%v) = %s, want %s", f, got, want)
		}
	}
}

func TestSerializeScalars(t *testing.T) {
	got, err := Serialize([]any{true, false, int(-7), int32(-2147483648), int64(9007199254740993),
		uint32(4294967295), uint64(18446744073709551615), float32(0.5), 2.5, 1e21, 1.25e-7,
		[]int{1, -2, 30}, []int{}, (*time.Time)(nil), (*Object)(nil), &Object{{"k", "v"}}, ""})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"json":[true,false,-7,-2147483648,9007199254740993,4294967295,18446744073709551615,` +
		`0.5,2.5,1e+21,1.25e-7,[1,-2,30],[],null,null,{"k":"v"},""]}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestSerializeRootUndefined(t *testing.T) {
	got, err := Serialize(Undefined{})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"meta":{"values":["undefined"],"v":1}}`; string(got) != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

// The path stack must report the same `meta.values` keys as the old copy-per-level paths: indexes in
// decimal, keys run through EscapeKey, siblings popped correctly, in traversal order.
func TestSerializeDeepPaths(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 6_000_000, time.UTC)
	v := Object{
		{"a.b", []any{
			Object{{`k\`, Object{{"x", Undefined{}}, {"d", ts}}}},
			Undefined{},
			[]any{ts},
		}},
		{"z", 1},
		{"p", &Object{{"q", &ts}}},
	}
	got, err := Serialize(v)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"json":{"a.b":[{"k\\":{"d":"2024-01-02T03:04:05.006Z"}},null,["2024-01-02T03:04:05.006Z"]],` +
		`"z":1,"p":{"q":"2024-01-02T03:04:05.006Z"}},` +
		`"meta":{"values":{"a\\.b.0.k\\\\.x":["undefined"],"a\\.b.0.k\\\\.d":["Date"],` +
		`"a\\.b.1":["undefined"],"a\\.b.2.0":["Date"],"p.q":["Date"]},"v":1}}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestSerializeErrorsReportPath(t *testing.T) {
	_, err := Serialize(Object{{"a", []any{1, Object{{"ok", 1}, {"b.c", struct{}{}}}}}})
	if want := `superjson: unsupported type struct {} at "a.1.b\\.c"`; err == nil || err.Error() != want {
		t.Fatalf("got %v, want %s", err, want)
	}
	_, err = Serialize(Object{{"x", []any{math.NaN()}}})
	if want := `superjson: non-finite number at "x.0"`; err == nil || err.Error() != want {
		t.Fatalf("got %v, want %s", err, want)
	}
}

// feedPage is shaped like a feed response: an object holding ~50 items of ~20 fields each, with
// strings, ints, floats, a nested object, a tag array and a Date.
func feedPage() Object {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 6_000_000, time.UTC)
	items := make([]any, 50)
	for i := range items {
		items[i] = Object{
			{"id", 1000 + i}, {"name", "A post title with some words"}, {"url", "a1b2c3d4-e5f6.jpeg"},
			{"nsfwLevel", 1}, {"width", 832}, {"height", 1216}, {"hash", "UGF4mDof00of~qayM{j[00ay-;j["},
			{"type", "image"}, {"createdAt", ts}, {"postId", int64(5000 + i)}, {"modelVersionId", nil},
			{"needsReview", false}, {"hasMeta", true}, {"onSite", false}, {"remixOfId", Undefined{}},
			{"metadata", Object{{"size", 123456}, {"ratio", 0.684}}}, {"tagIds", []int{1, 2, 3, 4, 5}},
			{"user", Object{{"id", 42}, {"username", "someone"}, {"image", nil}}},
			{"stats", Object{{"likeCountAllTime", 17}, {"heartCountAllTime", 3}}},
			{"description", "Line one\nLine \"two\" — with café"},
		}
	}
	return Object{{"items", items}, {"nextCursor", "1|1700000000000"}}
}

// TestSerializeAllocations guards the allocation-free string/path writing. The old writer allocated
// at least once per object member and array element (the path copy) plus an encoder per string,
// i.e. well over a thousand times for this page. Now the remaining allocations are the output
// buffer's growth, the path stack, the annotations and their joined paths. The ceiling is set with
// headroom (it is not a measured number) and still sits orders of magnitude below the old cost.
func TestSerializeAllocations(t *testing.T) {
	page := feedPage()
	allocs := testing.AllocsPerRun(20, func() {
		if _, err := Serialize(page); err != nil {
			t.Fatal(err)
		}
	})
	if allocs > 250 {
		t.Fatalf("Serialize allocated %v times per call, want <= 250", allocs)
	}
}

func BenchmarkSerialize(b *testing.B) {
	page := feedPage()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := Serialize(page); err != nil {
			b.Fatal(err)
		}
	}
}

// Plain is JSON.stringify: a Date is its ISO string with no annotation, an undefined member is
// omitted, an undefined array element is null, and there is no envelope.
func TestPlainIsJSONStringify(t *testing.T) {
	v := Object{
		{Key: "createdAt", Val: time.Date(2024, 3, 1, 10, 0, 0, 123_000_000, time.UTC)},
		{Key: "tags", Val: Undefined{}},
		{Key: "list", Val: []any{int64(1), Undefined{}, nil}},
		{Key: "meta", Val: nil},
	}
	got, err := Plain(v)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"createdAt":"2024-03-01T10:00:00.123Z","list":[1,null,null],"meta":null}` {
		t.Fatalf("Plain = %s", got)
	}
	if _, err := Plain(Undefined{}); err == nil {
		t.Fatal("an undefined root has no JSON form")
	}
}
