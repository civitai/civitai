package hydrate

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/andybalholm/brotli"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
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
// golden fixtures' msgpackr values and hand-built edge shapes).
func FuzzUnpack(f *testing.F) {
	f.Add([]byte{0x83, 0xa1, 'a', 0x01, 0xa1, 'u', 0xd4, 0x00, 0x00, 0xa1, 'f', 0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0})
	f.Add([]byte{0x81, 0x01, 0x92, 0xd4, 0x00, 0x00, 0xc0}) // {1: [undefined, nil]}
	f.Fuzz(func(t *testing.T, raw []byte) {
		// The ordered decode reads the same bytes: it never panics, and where both decode a map they
		// hold the same keys (the ordered one in the JS order).
		ov, oerr := UnpackOrdered(raw)
		v, err := Unpack(raw)
		if err != nil {
			return
		}
		checkNormalized(t, v, raw)
		m, isMap := v.(map[string]any)
		o, isObj := ov.(superjson.Object)
		if oerr == nil && isMap != isObj {
			t.Fatalf("% x: Unpack map %v, UnpackOrdered object %v", raw, isMap, isObj)
		}
		if oerr == nil && isMap && len(m) != len(o) {
			t.Fatalf("% x: %d keys, %d ordered", raw, len(m), len(o))
		}
	})
}

// FuzzMetaEntry: an image-meta value is bytes another service wrote, compressed or not. metaEntry
// never panics; what it serves always writes as JSON; and a value reads the same plain and behind the
// brotli sentinel (Node's compress-aware read accepts both). Seeds: the Node-made values of
// meta_test.go.
func FuzzMetaEntry(f *testing.F) {
	for id, h := range map[int]string{41: metaC41, 42: metaP42, 43: metaNF43, 44: metaC44, 45: metaDB45, 46: metaU46} {
		b, err := hex.DecodeString(h)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(b, id)
	}
	f.Fuzz(func(t *testing.T, raw []byte, id int) {
		meta, ok, err := metaEntry(raw, id)
		var plain []byte
		if ok && err == nil {
			if plain, err = superjson.Plain(superjson.Object{{Key: "meta", Val: meta}}); err != nil {
				t.Fatalf("metaEntry(%x) served a value that does not write: %v", raw, err)
			}
		}
		if len(raw) == 0 || raw[0] == packedBrotliSentinel || len(raw) > 1<<16 {
			return
		}
		var buf bytes.Buffer
		buf.WriteByte(packedBrotliSentinel)
		w := brotli.NewWriterLevel(&buf, 1)
		if _, werr := w.Write(raw); werr != nil {
			t.Fatal(werr)
		}
		if werr := w.Close(); werr != nil {
			t.Fatal(werr)
		}
		meta2, ok2, err2 := metaEntry(buf.Bytes(), id)
		if ok2 != ok || (err2 == nil) != (err == nil) {
			t.Fatalf("metaEntry(%x): plain ok %v err %v, compressed ok %v err %v", raw, ok, err, ok2, err2)
		}
		if ok && err == nil {
			plain2, _ := superjson.Plain(superjson.Object{{Key: "meta", Val: meta2}})
			if !bytes.Equal(plain, plain2) {
				t.Fatalf("metaEntry(%x): plain %s, compressed %s", raw, plain, plain2)
			}
		}
	})
}
