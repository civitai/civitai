package jsvalue

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// vectors is testdata/golden/vectors.json: inputs and what Node 24 answered for them (gen.ts runs
// the real String(Number(s)), JSON.parse/JSON.stringify, Buffer#toString and String#trim).
type vectors struct {
	NumberStrings []struct{ In, Out string } `json:"numberStrings"`
	Numbers       []struct {
		In   float64 `json:"in"`
		Out  string  `json:"out"`
		JSON string  `json:"json"`
	} `json:"numbers"`
	UTF8 []struct {
		In    string `json:"in"`
		Units string `json:"units"`
	} `json:"utf8"`
	JSONRoundTrip []struct{ In, Out string } `json:"jsonRoundTrip"`
	JSONInvalid   []struct {
		In     string `json:"in"`
		Throws bool   `json:"throws"`
	} `json:"jsonInvalid"`
	Trims []struct {
		In    string `json:"in"`
		Units string `json:"units"`
	} `json:"trims"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "golden", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// hexUnits renders UTF-16 code units the way gen.ts does: 4 hex digits each, space-separated.
func hexUnits(s string) string {
	units := Units(s)
	parts := make([]string, 0, len(units))
	for _, u := range units {
		parts = append(parts, fmt.Sprintf("%04x", u))
	}
	return strings.Join(parts, " ")
}

func TestStringToNumberMatchesNode(t *testing.T) {
	v := loadVectors(t)
	if len(v.NumberStrings) < 30 {
		t.Fatalf("only %d number-string vectors: the fixture did not load", len(v.NumberStrings))
	}
	for _, c := range v.NumberStrings {
		if got := FormatNumber(StringToNumber(c.In)); got != c.Out {
			t.Errorf("Number(%q) = %s, Node says %s", c.In, got, c.Out)
		}
	}
}

func TestFormatNumberMatchesNode(t *testing.T) {
	v := loadVectors(t)
	if len(v.Numbers) < 20 {
		t.Fatalf("only %d number vectors", len(v.Numbers))
	}
	for _, c := range v.Numbers {
		if got := FormatNumber(c.In); got != c.Out {
			t.Errorf("String(%v) = %s, Node says %s", c.In, got, c.Out)
		}
		if got := string(AppendNumber(nil, c.In)); got != c.JSON {
			t.Errorf("JSON.stringify(%v) = %s, Node says %s", c.In, got, c.JSON)
		}
	}
}

func TestDecodeUTF8MatchesNode(t *testing.T) {
	v := loadVectors(t)
	if len(v.UTF8) < 10 {
		t.Fatalf("only %d utf8 vectors", len(v.UTF8))
	}
	for _, c := range v.UTF8 {
		b, err := hex.DecodeString(c.In)
		if err != nil {
			t.Fatal(err)
		}
		if got := hexUnits(DecodeUTF8(b)); got != c.Units {
			t.Errorf("decode(%s) = [%s], Node says [%s]", c.In, got, c.Units)
		}
	}
}

func TestJSONRoundTripMatchesNode(t *testing.T) {
	v := loadVectors(t)
	if len(v.JSONRoundTrip) < 5 {
		t.Fatalf("only %d round-trip vectors", len(v.JSONRoundTrip))
	}
	for _, c := range v.JSONRoundTrip {
		val, err := Parse(c.In)
		if err != nil {
			t.Errorf("Parse(%q): %v", c.In, err)
			continue
		}
		if got := string(Stringify(val)); got != c.Out {
			t.Errorf("JSON.stringify(JSON.parse(%q))\n got  %s\n node %s", c.In, got, c.Out)
		}
	}
	thrown := 0
	for _, c := range v.JSONInvalid {
		_, err := Parse(c.In)
		if (err != nil) != c.Throws {
			t.Errorf("Parse(%q) err = %v, Node throws = %v", c.In, err, c.Throws)
		}
		if c.Throws {
			thrown++
		}
	}
	if thrown < 10 {
		t.Fatalf("only %d throwing vectors", thrown)
	}
}

func TestTrimMatchesNode(t *testing.T) {
	v := loadVectors(t)
	if len(v.Trims) < 5 {
		t.Fatalf("only %d trim vectors", len(v.Trims))
	}
	for _, c := range v.Trims {
		if got := hexUnits(Trim(c.In)); got != c.Units {
			t.Errorf("trim(%q) = [%s], Node says [%s]", c.In, got, c.Units)
		}
	}
}

// Literal cases, written from the ECMAScript rules (not from the vectors).
func TestStringifyLiterals(t *testing.T) {
	cases := []struct {
		in   string // JSON input
		want string
	}{
		{`"\u2028\u2029<>&"`, "\"\u2028\u2029<>&\""},
		{`"\ud800"`, `"\ud800"`},
		{`"\uDBFF\uDFFF"`, "\"\U0010FFFF\""},
		{`"\udc00\ud800"`, `"\udc00\ud800"`},
		{`"\u0000\u001F\u007f"`, "\"\\u0000\\u001f\u007f\""},
		{`"\b\f\n\r\t\/"`, `"\b\f\n\r\t/"`},
		{`{"10":1,"9":2,"a":3,"1e1":4}`, `{"9":2,"10":1,"a":3,"1e1":4}`},
		{`[1e21,1e-6,1e-7,-0,0.1]`, `[1e+21,0.000001,1e-7,0,0.1]`},
		{`1e999`, `null`},
	}
	for _, c := range cases {
		v, err := Parse(c.in)
		if err != nil {
			t.Fatalf("Parse(%s): %v", c.in, err)
		}
		if got := string(Stringify(v)); got != c.want {
			t.Errorf("%s: got %s want %s", c.in, got, c.want)
		}
	}
}

func TestObjectKeyOrder(t *testing.T) {
	o := NewObject()
	for _, k := range []string{"b", "2", "a", "0", "4294967295", "1", "01"} {
		o.Set(k, NumberValue(1))
	}
	o.Set("b", NumberValue(2)) // overwrite keeps position
	want := []string{"0", "1", "2", "b", "a", "4294967295", "01"}
	if got := o.Keys(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("keys %v, want %v", got, want)
	}
	if v, _ := o.Get("b"); v.N != 2 || o.Len() != 7 || !o.Has("01") || o.Has("c") {
		t.Fatalf("get/has/len wrong: %v %d", v, o.Len())
	}
}

func TestParseDepthLimit(t *testing.T) {
	deep := strings.Repeat("[", MaxDepth+1) + strings.Repeat("]", MaxDepth+1)
	if _, err := Parse(deep); err != ErrTooDeep { //nolint:errorlint // sentinel, unwrapped by construction
		t.Fatalf("depth %d: err = %v, want ErrTooDeep", MaxDepth+1, err)
	}
	ok := strings.Repeat("[", MaxDepth) + strings.Repeat("]", MaxDepth)
	if _, err := Parse(ok); err != nil {
		t.Fatalf("depth %d: %v", MaxDepth, err)
	}
}

func TestStringToNumberLiterals(t *testing.T) {
	cases := []struct {
		in   string
		want float64
	}{
		{"", 0},
		{" \n ", 0},
		{"0x10", 16},
		{"0o17", 15},
		{"0b11", 3},
		{"1e3", 1000},
		{"-1.5", -1.5},
		{"\u00a012\t", 12},
	}
	for _, c := range cases {
		if got := StringToNumber(c.in); got != c.want {
			t.Errorf("Number(%q) = %v, want %v", c.in, got, c.want)
		}
	}
	for _, in := range []string{"abc", "0x", "-0x1", "1_0", "0b2", "1e", "Infinityx"} {
		if got := StringToNumber(in); !math.IsNaN(got) {
			t.Errorf("Number(%q) = %v, want NaN", in, got)
		}
	}
	if !math.IsInf(StringToNumber("-Infinity"), -1) || !math.IsInf(StringToNumber("1e999"), 1) {
		t.Fatal("infinities")
	}
}

func TestUTF16LenAndLatin1(t *testing.T) {
	if n := UTF16Len("aé\U0001F600" + EncodeUnits([]uint16{0xD800})); n != 5 {
		t.Fatalf("UTF16Len = %d, want 5", n)
	}
	if got := Latin1("caf\xe9\xff"); got != "caféÿ" {
		t.Fatalf("Latin1 = %q", got)
	}
	if got := Latin1("plain"); got != "plain" {
		t.Fatalf("Latin1 ascii = %q", got)
	}
}

func TestValueConstructors(t *testing.T) {
	if BoolValue(true).Kind != Bool || NullValue().Kind != Null || ArrayValue(nil).Kind != Array {
		t.Fatal("kinds")
	}
	if !ObjectValue(NewObject()).IsPlainObject() || StringValue("x").IsPlainObject() {
		t.Fatal("IsPlainObject")
	}
	if CountNodes(ArrayValue([]Value{NumberValue(1), ObjectValue(NewObject())})) != 3 {
		t.Fatal("CountNodes")
	}
}
