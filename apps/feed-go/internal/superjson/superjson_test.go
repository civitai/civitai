package superjson

import (
	"encoding/json"
	"testing"
	"time"
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
