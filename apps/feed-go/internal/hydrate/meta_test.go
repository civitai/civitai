package hydrate

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"math"
	"strconv"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// imageMetaCache values as Node writes them, from node (msgpackr 1.11, the repo's
// packages/civitai-redis/src/packed-compression.ts settings: quality 6, the window sized to the value):
//
//	const now = new Date('2026-06-15T12:00:00.000Z');
//	compressPacked(pack(<value>)).toString('hex')   // the C… constants
//	pack(<value>).toString('hex')                   // the others
const (
	// {id:41, meta:JSON.parse('{"b": 1.5, "a": [2, null, "z"], "10": "x", "n": {"q": true}}'), cachedAt:now}, compressed
	metaC41 = "0121f00004de0003a2696429a46d657461de0004a23130a178a162cb3ff8000000000000a1619302c0a17aa16ede0001a171c3a86361636865644174d6ff6a2fe94003"
	// {id:42, meta:JSON.parse('{"steps": 9}'), cachedAt:now}, written before compression (plain)
	metaP42 = "de0003a269642aa46d657461de0001a5737465707309a86361636865644174d6ff6a2fe940"
	// {id:43, notFound:true, cachedAt:now} (fetch writes markers uncompressed)
	metaNF43 = "de0003a269642ba86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
	// {id:44, meta:null, cachedAt:now}, compressed: a hidden meta
	metaC44 = "01216c0004de0003a269642ca46d657461c0a86361636865644174d6ff6a2fe94003"
	// {id:45, debounce:true}: a bust's marker
	metaDB45 = "de0002a269642da86465626f756e6365c3"
	// {id:46, meta:undefined, cachedAt:now}
	metaU46 = "de0003a269642ea46d657461d40000a86361636865644174d6ff6a2fe940"
)

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func plainJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := superjson.Plain(superjson.Object{{Key: "v", Val: v}})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// metaEntry over each kind of cached value Node holds. The compressed one is Node's own brotli
// stream, so this is the decoder against the encoder it must read; its members come back in JS
// order (the integer-like "10" first), byte for byte as res.json writes them.
func TestMetaEntry(t *testing.T) {
	cases := []struct {
		name   string
		value  string
		id     int
		ok     bool
		wantJS string // the `meta` as JSON.stringify writes it
	}{
		{"compressed", metaC41, 41, true, `{"v":{"10":"x","b":1.5,"a":[2,null,"z"],"n":{"q":true}}}`},
		{"plain (before compression)", metaP42, 42, true, `{"v":{"steps":9}}`},
		{"notFound marker: null", metaNF43, 43, true, `{"v":null}`},
		{"hidden meta: null", metaC44, 44, true, `{"v":null}`},
		{"undefined meta: null", metaU46, 46, true, `{"v":null}`},
		{"another image's value: a miss", metaC41, 40, false, ``},
		{"debounce marker: a miss", metaDB45, 45, false, ``},
		{"empty: a miss", "", 41, false, ``},
		{"sentinel over a broken stream: a miss", "01ffffffff", 41, false, ``},
		{"not a map: a miss", "a3616263", 41, false, ``},
		{"truncated msgpack: a miss", metaP42[:20], 42, false, ``},
	}
	for _, c := range cases {
		meta, ok, err := metaEntry(unhex(t, c.value), c.id)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if ok != c.ok {
			t.Errorf("%s: ok %v, want %v", c.name, ok, c.ok)
			continue
		}
		if ok {
			if got := plainJSON(t, meta); got != c.wantJS {
				t.Errorf("%s: %s, want %s", c.name, got, c.wantJS)
			}
		}
	}
}

// A stream that inflates past the cap is not read (a miss), one just under it is.
func TestInflatePackedCap(t *testing.T) {
	compress := func(n int) []byte {
		var buf bytes.Buffer
		buf.WriteByte(packedBrotliSentinel)
		w := brotli.NewWriter(&buf)
		if _, err := w.Write(bytes.Repeat([]byte{'x'}, n)); err != nil {
			t.Fatal(err)
		}
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}
	if out, err := inflatePacked(compress(maxInflatedMeta)); err != nil || len(out) != maxInflatedMeta {
		t.Fatalf("at the cap: %d bytes, %v", len(out), err)
	}
	if _, err := inflatePacked(compress(maxInflatedMeta + 1)); err == nil {
		t.Fatal("past the cap: want an error")
	}
	// Plain msgpack passes through untouched.
	plain := unhex(t, metaP42)
	if out, err := inflatePacked(plain); err != nil || !bytes.Equal(out, plain) {
		t.Fatalf("plain value: %x, %v", out, err)
	}
}

// JSWire is JSON.stringify's view of a JS value: member order kept, undefined members left out,
// undefined elements and non-finite numbers null.
func TestJSWire(t *testing.T) {
	v, err := JSWire(jspack.Obj{
		{K: "z", V: 1.25},
		{K: "u", V: jspack.Undefined{}},
		{K: "a", V: []any{jspack.Undefined{}, math.Inf(1), math.NaN(), "s", false, nil}},
		{K: "o", V: jspack.Obj{{K: "k", V: math.Copysign(0, -1)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := plainJSON(t, v); got != `{"v":{"z":1.25,"a":[null,null,null,"s",false,null],"o":{"k":0}}}` {
		t.Fatalf("JSWire = %s", got)
	}
	if _, err := JSWire(jspack.Obj{{K: "buf", V: []byte{1}}}); err == nil {
		t.Fatal("a Buffer is not modelled: want an error")
	}
}

// metaFixture is a Sources over a fake cache holding the constants above and a replica answering the
// meta lookup for 47 (a meta), 48 (hidden) and nothing else.
func metaFixture(t *testing.T) (*Sources, *testkit.Redis, *testkit.DB, *[]string) {
	t.Helper()
	cache := testkit.NewRedis()
	for id, v := range map[int]string{41: metaC41, 42: metaP42, 43: metaNF43, 44: metaC44, 45: metaDB45} {
		cache.SetString(KeyImageMeta+":"+strconv.Itoa(id), unhex(t, v))
	}
	rows := map[int][]any{47: {47, `{"cfg": 7, "prompt": "p47"}`}, 48: {48, nil}, 45: {45, `{"fresh": true}`}}
	db := &testkit.DB{Routes: []testkit.Route{{Match: sqlImageMeta, Rows: func(args []any) (*testkit.Rows, error) {
		out := testkit.NewRows([]string{"id", "meta"})
		for _, id := range args[0].([]int) {
			if r, ok := rows[id]; ok {
				out.Data = append(out.Data, r)
			}
		}
		return out, nil
	}}}}
	var observed []string
	s := &Sources{Packed: &PackedReader{Redis: cache}, Cache: cache, Replica: db, Compute: &MissCompute{
		Observe: func(c, r string, n int) { observed = append(observed, c+"/"+r+"/"+strconv.Itoa(n)) },
	}}
	return s, cache, db, &observed
}

// V1Page with MetaIDs: hits decoded (compressed or not), markers null, misses (no key, a debounce
// marker) looked up on the replica, an id with no row null; all reads in the page's one pipeline.
func TestV1PageMeta(t *testing.T) {
	s, cache, db, observed := metaFixture(t)
	ids := []int{41, 42, 43, 44, 45, 47, 48, 49, 41}
	cache.Calls = 0
	page, err := s.metaOnly(context.Background(), ids)
	if err != nil {
		t.Fatal(err)
	}
	if cache.Calls != 1 {
		t.Fatalf("cache round trips = %d, want the page's one pipeline", cache.Calls)
	}
	want := map[int]string{
		41: `{"v":{"10":"x","b":1.5,"a":[2,null,"z"],"n":{"q":true}}}`,
		42: `{"v":{"steps":9}}`,
		43: `{"v":null}`,
		44: `{"v":null}`,
		45: `{"v":{"fresh":true}}`, // a debounce marker is a miss: the replica's row
		47: `{"v":{"cfg":7,"prompt":"p47"}}`,
		48: `{"v":null}`, // the lookup's hidden meta
		49: `{"v":null}`, // no row
	}
	if len(page) != len(want) {
		t.Fatalf("got %d ids, want %d: %v", len(page), len(want), page)
	}
	for id, w := range want {
		if got := plainJSON(t, page[id]); got != w {
			t.Errorf("%d: %s, want %s", id, got, w)
		}
	}
	// One lookup for exactly the misses, counted as computed.
	if len(db.Calls) != 1 {
		t.Fatalf("replica queries = %d, want 1", len(db.Calls))
	}
	if strings.Join(*observed, ",") != "image-meta/computed/4" {
		t.Fatalf("observed = %v", *observed)
	}
	// Nothing is written back.
	for _, k := range cache.AllKeys() {
		if strings.HasSuffix(k, ":47") || strings.HasSuffix(k, ":49") {
			t.Fatalf("wrote %s", k)
		}
	}
}

// metaOnly is V1Page reduced to its meta lookup (the other lookups have nothing to read).
func (s *Sources) metaOnly(ctx context.Context, ids []int) (map[int]any, error) {
	p, err := s.V1Page(ctx, V1PageRequest{MetaIDs: ids})
	if err != nil {
		return nil, err
	}
	return p.Meta, nil
}

// An image-meta miss is never answered from lookupShared's in-process memo (Node keeps no per-pod
// copy: a meta its owner hides must not be served again): a second miss within the memo's window
// queries again and sees the hidden meta. The cosmetic caches keep their memo (the control).
func TestImageMetaMissNotMemoized(t *testing.T) {
	s, _, db, _ := metaFixture(t)
	hidden := false
	db.Routes[0].Rows = func([]any) (*testkit.Rows, error) {
		var meta any = `{"prompt": "p47"}`
		if hidden {
			meta = nil
		}
		return testkit.NewRows([]string{"id", "meta"}, []any{47, meta}), nil
	}
	if got, err := s.metaOnly(context.Background(), []int{47}); err != nil || plainJSON(t, got[47]) != `{"v":{"prompt":"p47"}}` {
		t.Fatalf("first miss: %v %v", got, err)
	}
	hidden = true // the owner flips hideMeta
	if got, err := s.metaOnly(context.Background(), []int{47}); err != nil || plainJSON(t, got[47]) != `{"v":null}` {
		t.Fatalf("second miss within the memo window: %v %v, want the hidden (null) meta", got, err)
	}
	if len(db.Calls) != 2 {
		t.Fatalf("replica queries = %d, want 2 (no memo)", len(db.Calls))
	}
	// Control: the same MissCompute still memoizes a cosmetic cache's answers.
	calls := 0
	lookup := func(context.Context, []int) (map[int]jspack.Obj, error) {
		calls++
		return map[int]jspack.Obj{7: jspack.O("userId", 7)}, nil
	}
	for range 2 {
		if _, err := s.Compute.lookupShared(context.Background(), MissUserCosmetics, []int{7}, lookup); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("user-cosmetics lookups = %d, want 1 (memoized)", calls)
	}
}

func TestV1PageMetaFallbacks(t *testing.T) {
	// No miss computation: a miss falls back; hits alone are served.
	s, _, _, _ := metaFixture(t)
	s.Compute = nil
	if _, err := s.metaOnly(context.Background(), []int{41, 47}); fallback.Reason(err) != "image-meta-miss" {
		t.Fatalf("miss without a computation: %v", err)
	}
	if got, err := s.metaOnly(context.Background(), []int{41, 43}); err != nil || len(got) != 2 {
		t.Fatalf("hits only: %v %v", got, err)
	}
	// A failed lookup.
	s, _, db, observed := metaFixture(t)
	db.Routes[0].Rows = func([]any) (*testkit.Rows, error) { return nil, errors.New("replica down") }
	if _, err := s.metaOnly(context.Background(), []int{47}); fallback.Reason(err) != "image-meta-miss-failed" {
		t.Fatalf("failed lookup: %v", err)
	}
	if strings.Join(*observed, ",") != "image-meta/error/1" {
		t.Fatalf("observed = %v", *observed)
	}
	// A failed read is a miss, answered from the replica (Node's degraded fetch looks every id up).
	s, cache, _, _ := metaFixture(t)
	cache.KeyErr = func(key string) error {
		if strings.HasSuffix(key, ":47") {
			return errors.New("shard down")
		}
		return nil
	}
	if got, err := s.metaOnly(context.Background(), []int{47}); err != nil || plainJSON(t, got[47]) != `{"v":{"cfg":7,"prompt":"p47"}}` {
		t.Fatalf("failed read: %v %v", got, err)
	}
	// Without MetaIDs nothing is read.
	s, cache, _, _ = metaFixture(t)
	if p, err := s.V1Page(context.Background(), V1PageRequest{}); err != nil || p.Meta != nil {
		t.Fatalf("no meta asked: %+v %v", p, err)
	}
	if cache.Calls != 0 {
		t.Fatalf("no meta asked: %d cache round trips", cache.Calls)
	}
}
