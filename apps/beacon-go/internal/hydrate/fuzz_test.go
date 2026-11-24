package hydrate

import (
	"testing"
)

// checkNormalized fails when v still holds what normalize must remove: a msgpackr `undefined` or a
// map with non-string keys (the readers type-assert map[string]any).
func checkNormalized(t *testing.T, v any, raw []byte) {
	t.Helper()
	switch x := v.(type) {
	case *jsUndefined, jsUndefined:
		t.Fatalf("Unpack(%x) left an undefined value", raw)
	case map[any]any:
		t.Fatalf("Unpack(%x) left a map[any]any", raw)
	case map[string]any:
		for _, e := range x {
			checkNormalized(t, e, raw)
		}
	case []any:
		for _, e := range x {
			checkNormalized(t, e, raw)
		}
	}
}

// FuzzUnpack: a cache value is bytes another service wrote, so Unpack must never panic on arbitrary
// input, and whatever it accepts comes back normalized. Seed corpus: testdata/fuzz/FuzzUnpack (the
// session-user msgpackr value and hand-built edge shapes).
func FuzzUnpack(f *testing.F) {
	f.Add([]byte{0x83, 0xa1, 'a', 0x01, 0xa1, 'u', 0xd4, 0x00, 0x00, 0xa1, 'f', 0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0})
	f.Add([]byte{0x81, 0x01, 0x92, 0xd4, 0x00, 0x00, 0xc0}) // {1: [undefined, nil]}
	f.Fuzz(func(t *testing.T, raw []byte) {
		v, err := Unpack(raw)
		if err != nil {
			return
		}
		checkNormalized(t, v, raw)
	})
}
