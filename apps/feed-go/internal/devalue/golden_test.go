package devalue

import (
	"encoding/json"
	"math"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// specialGolden is testdata/golden/devalue/special.json, written by the Node devalue the repo
// resolves (testdata/golden/gen-devalue.mjs): per case, devalue.stringify(value) and the tRPC body.
const specialGolden = "../../testdata/golden/devalue/special.json"

type specialCase struct {
	Name string `json:"name"`
	Text string `json:"text"`
	Body string `json:"body"`
}

func loadSpecial(t *testing.T) []specialCase {
	t.Helper()
	b, err := os.ReadFile(specialGolden)
	if err != nil {
		t.Fatal(err)
	}
	var cases []specialCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

func utc(y int, mo time.Month, d, h, mi, s, ms int) time.Time {
	return time.Date(y, mo, d, h, mi, s, ms*int(time.Millisecond), time.UTC)
}

// specialValues builds, per golden case, the Go value the Node script's value stands for. Number
// kinds are mixed on purpose: every Go int/uint/float kind is one JS number.
func specialValues() map[string]any {
	u := superjson.Undefined{}
	d := new(time.Time)
	*d = utc(2026, 6, 12, 10, 0, 0, 123)
	user := superjson.Object{{Key: "id", Val: 1}, {Key: "name", Val: "shared"}}
	arr := []any{int64(1), 2}
	emptyObj := make(superjson.Object, 0, 1)
	emptyArr := make([]any, 0, 1)
	return map[string]any{
		"strings-escapes": []any{"plain", "quote\"", "back\\slash", "</script><script>", ">&", "\b\f\n\r\t",
			"\x00\x01\x0b\x1f", "\x7f", "\u2028\u2029", "\u00e9\u6f22\u5b57", "\U0001F600", ""},
		"string-dedup": []any{"a", "b", "a", "a", "b"},
		"numbers": []any{int64(0), 1, int32(-1), 1.5, 0.1, 1e21, 1e-7, 123456789012345680000.0, int64(9007199254740993),
			5e-324, 1.7976931348623157e308, 0.000001, 1e300, -2.5e-8, uint32(4294967295), -123456.789},
		"number-specials":        []any{math.NaN(), math.Inf(1), math.Inf(-1), math.Copysign(0, -1), 0},
		"number-dedup":           []any{1, int64(1), uint64(2), float64(1), 2.5, float32(2.5)},
		"bools-null":             []any{true, false, nil, true, nil, false},
		"undefined-members":      superjson.Object{{Key: "a", Val: u}, {Key: "b", Val: 1}, {Key: "c", Val: []any{u, 2, u}}},
		"root-undefined":         u,
		"root-nan":               math.NaN(),
		"root-negative-zero":     math.Copysign(0, -1),
		"root-infinity":          math.Inf(1),
		"root-negative-infinity": math.Inf(-1),
		"root-string":            "x",
		"root-number":            42,
		"root-null":              nil,
		"root-empty-array":       []any{},
		"root-empty-object":      superjson.Object{},
		"dates": superjson.Object{
			{Key: "a", Val: d}, {Key: "b", Val: d}, {Key: "c", Val: *d},
			{Key: "epoch", Val: time.Unix(0, 0)},
			{Key: "before", Val: utc(1969, 12, 31, 23, 59, 59, 999)},
			{Key: "far", Val: utc(10000, 1, 1, 0, 0, 0, 0)},
			{Key: "bc", Val: utc(-1, 6, 1, 0, 0, 0, 0)},
		},
		"shared-objects": []any{
			superjson.Object{{Key: "u", Val: user}},
			superjson.Object{{Key: "u", Val: user}},
			superjson.Object{{Key: "u", Val: superjson.Object{{Key: "id", Val: 1}, {Key: "name", Val: "shared"}}}},
			user,
		},
		"shared-arrays": superjson.Object{{Key: "a", Val: arr}, {Key: "b", Val: arr}, {Key: "c", Val: []int{1, 2}}},
		"empty-shared": superjson.Object{
			{Key: "a", Val: emptyObj}, {Key: "b", Val: &emptyObj}, {Key: "c", Val: superjson.Object{}},
			{Key: "d", Val: emptyArr}, {Key: "e", Val: emptyArr}, {Key: "f", Val: []any{}},
		},
		"key-order": superjson.Object{
			{Key: "b", Val: 1}, {Key: "2", Val: "x"}, {Key: "1", Val: "y"}, {Key: "a", Val: 2}, {Key: "10", Val: 3},
			{Key: "01", Val: 4}, {Key: "-1", Val: 5}, {Key: "4294967295", Val: 6}, {Key: "4294967294", Val: 7},
		},
		"key-escapes": superjson.Object{
			{Key: "a\"b", Val: 1}, {Key: "<k>", Val: 2}, {Key: "\u2028", Val: 3}, {Key: "", Val: 4}, {Key: "a\\b", Val: 5},
		},
		"map-set-bigint": superjson.Object{
			{Key: "m", Val: Map{{Key: "k", Val: 1}, {Key: 2, Val: "v"}, {Key: user, Val: user}}},
			{Key: "s", Val: Set{1, "a", user}},
			{Key: "big", Val: BigInt("123")},
			{Key: "big2", Val: BigInt("123")},
			{Key: "neg", Val: BigInt("-5")},
		},
		"nested": superjson.Object{{Key: "a", Val: superjson.Object{{Key: "b", Val: superjson.Object{{Key: "c", Val: []any{
			superjson.Object{{Key: "d", Val: "x"}},
			[]any{[]any{}},
			superjson.Object{{Key: "e", Val: []any{nil}}},
		}}}}}}},
		"json-parse": json.RawMessage(`{"b":1,"a":[1,{"c":null,"d":"<\u2028"}],"2":true,"x":1e400,"dup":1,"y":-0,"dup":2,"e":{},"f":[]}`),
	}
}

// TestNodeGoldenSpecial: for every case Node wrote, Stringify is Node's devalue text and the payload in
// tRPC's envelope is Node's body, byte for byte.
func TestNodeGoldenSpecial(t *testing.T) {
	values := specialValues()
	cases := loadSpecial(t)
	if len(cases) < 26 {
		t.Fatalf("%d golden cases, want at least 26", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			v, ok := values[c.Name]
			if !ok {
				t.Fatalf("no Go value for golden case %q", c.Name)
			}
			text, err := Stringify(v)
			if err != nil {
				t.Fatal(err)
			}
			if text != c.Text {
				t.Errorf("Stringify:\n got  %s\n want %s", text, c.Text)
			}
			payload, err := Payload(v)
			if err != nil {
				t.Fatal(err)
			}
			if body := `{"result":{"data":` + string(payload) + `}}`; body != c.Body {
				t.Errorf("body:\n got  %s\n want %s", body, c.Body)
			}
		})
	}
}

// TestNodeGoldenSpecialLedger: the Go table and Node's file name the same cases, so a case added on
// either side without the other fails here rather than going untested.
func TestNodeGoldenSpecialLedger(t *testing.T) {
	cases, values := loadSpecial(t), specialValues()
	file, table := make([]string, 0, len(cases)), make([]string, 0, len(values))
	for _, c := range cases {
		file = append(file, c.Name)
	}
	for k := range values {
		table = append(table, k)
	}
	sort.Strings(file)
	sort.Strings(table)
	if strings.Join(file, ",") != strings.Join(table, ",") {
		t.Fatalf("golden cases %v, Go table %v", file, table)
	}
}

// TestNodeGoldenParseRoundTrip: Parse reads every Node text back into a value Stringify writes as the
// same text (index order, dedup and identity all survive).
func TestNodeGoldenParseRoundTrip(t *testing.T) {
	for _, c := range loadSpecial(t) {
		if c.Name == "dates" {
			// far / bc are expanded-year ISO strings Parse does not read (time.Parse has no ±YYYYYY).
			continue
		}
		v, err := Parse(c.Text)
		if err != nil {
			t.Fatalf("%s: Parse: %v", c.Name, err)
		}
		got, err := Stringify(v)
		if err != nil {
			t.Fatalf("%s: Stringify(Parse): %v", c.Name, err)
		}
		if got != c.Text {
			t.Errorf("%s: round trip\n got  %s\n want %s", c.Name, got, c.Text)
		}
	}
}

func TestInvalidUTF8IsReplacementCharacter(t *testing.T) {
	got, err := Stringify([]any{"a\xffb", "\xc3"})
	if err != nil {
		t.Fatal(err)
	}
	if want := "[[1,2],\"a\ufffdb\",\"\ufffd\"]"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestUnsupportedValuesAreErrors(t *testing.T) {
	for name, v := range map[string]any{
		"map":            map[string]any{"a": 1},
		"struct":         struct{}{},
		"nested":         []any{superjson.Object{{Key: "x", Val: []string{"a"}}}},
		"proto key":      superjson.Object{{Key: "__proto__", Val: 1}},
		"bad bigint":     BigInt("12a"),
		"empty bigint":   BigInt(""),
		"bad raw json":   json.RawMessage(`{"a":`),
		"raw trailing":   json.RawMessage(`1 2`),
		"map value type": Map{{Key: "k", Val: make(chan int)}},
		"set value type": Set{make(chan int)},
	} {
		if _, err := Stringify(v); err == nil {
			t.Errorf("%s: Stringify accepted %T", name, v)
		}
		if b, err := PayloadBuffer(v); err == nil || b != nil {
			t.Errorf("%s: PayloadBuffer = %v, %v; want no buffer and an error", name, b, err)
		}
	}
}

// A Date past a JS Date's range is an invalid Date, whose ISO string devalue writes as "".
func TestDateOutOfJSRange(t *testing.T) {
	for _, at := range []time.Time{utc(275761, 1, 1, 0, 0, 0, 0), utc(-271822, 1, 1, 0, 0, 0, 0)} {
		got, err := Stringify(at)
		if err != nil {
			t.Fatal(err)
		}
		if want := `[["Date",""]]`; got != want {
			t.Errorf("%v: got %s, want %s", at, got, want)
		}
	}
	// The last instants a JS Date holds are still valid.
	for at, want := range map[time.Time]string{
		time.UnixMilli(8.64e15).UTC():  "+275760-09-13T00:00:00.000Z",
		time.UnixMilli(-8.64e15).UTC(): "-271821-04-20T00:00:00.000Z",
	} {
		if got := string(AppendISODate(nil, at)); got != want {
			t.Errorf("AppendISODate(%v) = %q, want %q", at, got, want)
		}
	}
}

// Pooled encoders carry nothing from one payload to the next: the second payload's dedup tables and
// entries start empty.
func TestPooledEncoderStartsEmpty(t *testing.T) {
	shared := superjson.Object{{Key: "k", Val: "v"}}
	for i := 0; i < 3; i++ {
		b, err := PayloadBuffer([]any{shared, shared, "v", true, nil})
		if err != nil {
			t.Fatal(err)
		}
		b.Release()
		b.Release() // idempotent
		if b.Bytes() != nil {
			t.Fatal("Bytes after Release")
		}
	}
	got, err := Stringify([]any{"v", true, nil, shared})
	if err != nil {
		t.Fatal(err)
	}
	if want := `[[1,2,3,4],"v",true,null,{"k":1}]`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
	if (*Buffer)(nil).Bytes() != nil {
		t.Fatal("nil Buffer has bytes")
	}
	(*Buffer)(nil).Release()
}

// The same json.RawMessage buffer is one value; two buffers with the same text are two.
func TestRawMessageIdentity(t *testing.T) {
	raw := json.RawMessage(`{"a":1}`)
	other := json.RawMessage(`{"a":1}`)
	got, err := Stringify([]any{raw, raw, other, json.RawMessage(nil), json.RawMessage(`"s"`), json.RawMessage(`"s"`)})
	if err != nil {
		t.Fatal(err)
	}
	if want := `[[1,1,3,4,5,5],{"a":2},1,{"a":2},null,"s"]`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

// A *time.Time and a *superjson.Object are their pointee, and one pointer is one value; nil is null.
func TestPointers(t *testing.T) {
	at := utc(2024, 1, 2, 3, 4, 5, 6)
	obj := superjson.Object{{Key: "a", Val: 1}}
	var nilTime *time.Time
	var nilObj *superjson.Object
	got, err := Stringify([]any{&at, &at, at, &obj, obj, nilTime, nilObj})
	if err != nil {
		t.Fatal(err)
	}
	want := `[[1,1,2,3,3,5,5],["Date","2024-01-02T03:04:05.006Z"],["Date","2024-01-02T03:04:05.006Z"],{"a":4},1,null]`
	if got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
}
