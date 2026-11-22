package jspack

import (
	"encoding/hex"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The goldens are msgpackr 1.11.5's own bytes: `require('msgpackr').pack(v).toString('hex')` for the
// value in each comment, run with node. Nothing here is derived from this package's output.

// {id:7, username:'integ-user', when:new Date(Date.UTC(2024,0,2,3,4,5,678)),
//
//	whole:new Date(Date.UTC(2024,0,2,3,4,5)), u:undefined, f:1.5, neg:-3, big:70000, n:null,
//	b:true, arr:[1,'x']}
const golden1 = "de000ba2696407a8757365726e616d65aa696e7465672d75736572a47768656ed7ffa1a5d60065937d25a577686f6c65d6ff65937d25a175d40000a166cb3ff8000000000000a36e6567fda3626967ce00011170a16ec0a162c3a36172729201a178"

// {long:'integ-'+'x'.repeat(34), arr17:[0,10,…,160], n200:-200, n100:-100, huge:2**33, b200:200,
//
//	e:{}, old:new Date(Date.UTC(1969,11,31,23,59,59,500))}
const golden2 = "de0008a46c6f6e67d928696e7465672d78787878787878787878787878787878787878787878787878787878787878787878a56172723137dc0011000a141e28323c46505a646e78cc82cc8ccc96cca0a46e323030d1ff38a46e313030d09ca468756765cb4200000000000000a462323030ccc8a165de0000a36f6c64c70cff1dcd6500ffffffffffffffff"

// v = JSON.parse('{"b":1,"2":2,"a":{"10":1,"9":2,"x":null},"f":-1.25,"big":1e20,"s":"héllo"}');
// v.d = new Date(Date.UTC(2026,5,15,12,0,0,123)); — JS lists the integer-like keys first:
// Object.keys(v) is ["2","b","a","f","big","s","d"], Object.keys(v.a) ["9","10","x"].
const golden3 = "de0007a13202a16201a161de0003a13902a2313001a178c0a166cbbff4000000000000a3626967cb4415af1d78b58c40a173a668c3a96c6c6fa164d7ff1d5353006a2fe940"

func TestPackMatchesMsgpackr(t *testing.T) {
	when := time.Date(2024, 1, 2, 3, 4, 5, 678e6, time.UTC)
	whole := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	v1 := O("id", 7, "username", "integ-user", "when", when, "whole", whole, "u", Undefined{},
		"f", 1.5, "neg", -3, "big", 70000, "n", nil, "b", true, "arr", []any{1, "x"})
	if got := hex.EncodeToString(Pack(v1)); got != golden1 {
		t.Fatalf("Pack(v1)\n got %s\nwant %s", got, golden1)
	}
	arr17 := make([]any, 17)
	for i := range arr17 {
		arr17[i] = i * 10
	}
	v2 := O("long", "integ-"+strings.Repeat("x", 34), "arr17", arr17, "n200", -200, "n100", -100,
		"huge", 8589934592, "b200", 200, "e", O(), "old", time.Date(1969, 12, 31, 23, 59, 59, 500e6, time.UTC))
	if got := hex.EncodeToString(Pack(v2)); got != golden2 {
		t.Fatalf("Pack(v2)\n got %s\nwant %s", got, golden2)
	}
}

// FromJSON gives JSON.parse's property order, and Pack of it is msgpackr's bytes for that value.
func TestFromJSONOrderAndPack(t *testing.T) {
	v, err := FromJSON(`{"b":1,"2":2,"a":{"10":1,"9":2,"x":null},"f":-1.25,"big":1e20,"s":"héllo"}`)
	if err != nil {
		t.Fatal(err)
	}
	o := v.(Obj)
	keys := make([]string, 0, len(o))
	for _, kv := range o {
		keys = append(keys, kv.K)
	}
	a, _ := o.Get("a")
	inner := make([]string, 0, len(a.(Obj)))
	for _, kv := range a.(Obj) {
		inner = append(inner, kv.K)
	}
	if !reflect.DeepEqual(keys, []string{"2", "b", "a", "f", "big", "s"}) || !reflect.DeepEqual(inner, []string{"9", "10", "x"}) {
		t.Fatalf("keys %v / %v, want JS property order", keys, inner)
	}
	o = append(o, KV{K: "d", V: time.Date(2026, 6, 15, 12, 0, 0, 123e6, time.UTC)})
	if got := hex.EncodeToString(Pack(o)); got != golden3 {
		t.Fatalf("Pack(FromJSON(...))\n got %s\nwant %s", got, golden3)
	}
}

func TestFromJSONRepeatedKeyAndErrors(t *testing.T) {
	v, err := FromJSON(`{"a":1,"b":2,"a":3}`)
	if err != nil {
		t.Fatal(err)
	}
	if want := (Obj{{K: "a", V: 3.0}, {K: "b", V: 2.0}}); !reflect.DeepEqual(v, want) {
		t.Fatalf("FromJSON = %#v, want %#v (first position, last value)", v, want)
	}
	for _, bad := range []string{`{"a":`, `[1,]`, `1 2`, ``} {
		if _, err := FromJSON(bad); err == nil {
			t.Errorf("FromJSON(%q): no error", bad)
		}
	}
	if v, err := FromJSON(`null`); err != nil || v != nil {
		t.Fatalf("FromJSON(null) = %#v, %v", v, err)
	}
}

// Decode then Pack reproduces msgpackr's bytes, so a cached value carried into a new entry is
// written as Node would write the same JS value.
func TestDecodeRoundTrip(t *testing.T) {
	for i, g := range []string{golden1, golden2, golden3} {
		raw, _ := hex.DecodeString(g)
		v, err := Decode(raw)
		if err != nil {
			t.Fatalf("golden%d: %v", i+1, err)
		}
		if got := hex.EncodeToString(Pack(v)); got != g {
			t.Fatalf("golden%d round trip\n got %s\nwant %s", i+1, got, g)
		}
	}
	raw, _ := hex.DecodeString(golden1)
	v, _ := Decode(raw)
	when, _ := v.(Obj).Get("when")
	if want := time.Date(2024, 1, 2, 3, 4, 5, 678e6, time.UTC); !when.(time.Time).Equal(want) {
		t.Fatalf("when = %v, want %v", when, want)
	}
	if u, _ := v.(Obj).Get("u"); u != (Undefined{}) {
		t.Fatalf("u = %#v, want Undefined", u)
	}
}

// Every msgpack form msgpackr's unpack reads, from the msgpack spec's byte layouts (hand-written),
// as the JS value it becomes.
func TestDecodeForms(t *testing.T) {
	cases := []struct {
		hex  string
		want any
	}{
		{"cc ff", 255.0}, {"cd 0100", 256.0}, {"ce 00010000", 65536.0}, {"cf 0000000100000000", 4294967296.0},
		{"d0 ff", -1.0}, {"d1 ff00", -256.0}, {"d2 ffff0000", -65536.0}, {"d3 ffffffffffffffff", -1.0},
		{"e0", -32.0}, {"ca 3fc00000", 1.5}, {"c2", false},
		{"d9 03 616263", "abc"}, {"da 0001 61", "a"}, {"db 00000001 62", "b"},
		{"c4 02 0102", []byte{1, 2}}, {"dc 0001 01", []any{1.0}}, {"dd 00000001 c0", []any{nil}},
		{"81 01 02", Obj{{K: "1", V: 2.0}}}, {"df 00000001 a161 c3", Obj{{K: "a", V: true}}},
		{"d4 00 00", Undefined{}},
		{"d6 ff 00000001", time.Unix(1, 0).UTC()},
		{"d7 ff 00000004 00000002", time.Unix(2, 1).UTC()}, // nanoseconds 1 in the upper 30 bits
		{"c7 0c ff 00000003 0000000000000004", time.Unix(4, 3).UTC()},
	}
	for _, c := range cases {
		b, err := hex.DecodeString(strings.ReplaceAll(c.hex, " ", ""))
		if err != nil {
			t.Fatal(err)
		}
		got, err := Decode(b)
		if err != nil {
			t.Errorf("%s: %v", c.hex, err)
			continue
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s = %#v, want %#v", c.hex, got, c.want)
		}
	}
	for _, bad := range []string{"c1", "d5 07 0000", "d4 01 00", "c7 01 ff 00"} {
		b, _ := hex.DecodeString(strings.ReplaceAll(bad, " ", ""))
		if _, err := Decode(b); err == nil {
			t.Errorf("%s decoded", bad)
		}
	}
}

func TestDecodeRefusesTruncatedAndOversized(t *testing.T) {
	raw, _ := hex.DecodeString(golden1)
	for n := 0; n < len(raw); n++ {
		if _, err := Decode(raw[:n]); err == nil {
			t.Fatalf("Decode of %d of %d bytes: no error", n, len(raw))
		}
	}
	// A map32 declaring 2^31 members in 6 bytes must fail before allocating them.
	if _, err := Decode([]byte{0xdf, 0x80, 0, 0, 0, 0xc0}); err == nil {
		t.Fatal("an oversized map length decoded")
	}
	if _, err := Decode(append(raw, 0xc0)); err == nil {
		t.Fatal("trailing bytes decoded")
	}
}

// O refuses an odd argument list, Get reports an absent member, and Order is the JS own-key order
// (jskeys.Order) over an Obj.
func TestOGetAndOrder(t *testing.T) {
	func() {
		defer func() {
			if recover() == nil {
				t.Error("O with an odd argument count did not panic")
			}
		}()
		_ = O("a", 1, "b") //nolint:staticcheck // SA5012: the odd argument count is the case under test
	}()
	o := O("b", 1, "2", 2, "1", 3)
	if v, ok := o.Get("missing"); ok || v != nil {
		t.Errorf("Get(missing) = %v, %v; want nil, false", v, ok)
	}
	got := Order(o)
	keys := make([]string, len(got))
	for i, kv := range got {
		keys[i] = kv.K
	}
	if strings.Join(keys, ",") != "1,2,b" {
		t.Errorf("Order keys = %v, want [1 2 b]", keys)
	}
}
