package hydrate

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// Differential tests of the single-pass msgpack reader (msgpack.go) against the decoder it replaced
// (the oracle, msgpack_oracle_test.go): same value (types, key order where ordered, float bits,
// nil vs empty, time instants and locations) or the same refusal, for every golden cache value, a
// generated corpus of every msgpack code in record-like shapes, byte-level mutations of the goldens,
// and the fuzzer's inputs (FuzzUnpackMatchesOracle).

// oraclePacked is one golden cache value: its Redis key, its cache (the key without its id) and its
// bytes.
type oraclePacked struct {
	key, cache string
	b          []byte
}

// allGoldenPacked is every packed value of every golden fixture (all endpoints), sorted by fixture
// and key.
func allGoldenPacked(tb testing.TB) []oraclePacked {
	tb.Helper()
	files, err := filepath.Glob("../../testdata/golden/*/*.json")
	if err != nil || len(files) == 0 {
		tb.Fatalf("no golden fixtures: %v", err)
	}
	sort.Strings(files)
	var out []oraclePacked
	for _, f := range files {
		raw, err := os.ReadFile(f) //nolint:gosec // G304: path is a fixture from the testdata glob
		if err != nil {
			tb.Fatal(err)
		}
		var doc any
		if err := json.Unmarshal(raw, &doc); err != nil {
			continue // not a fixture document
		}
		var walk func(v any, key string)
		walk = func(v any, key string) {
			switch t := v.(type) {
			case map[string]any:
				if p, ok := t["packed"].(string); ok {
					b, err := base64.StdEncoding.DecodeString(p)
					if err != nil {
						tb.Fatalf("%s %s: %v", f, key, err)
					}
					out = append(out, oraclePacked{key: key, cache: cacheOfKey(key), b: b})
				}
				keys := make([]string, 0, len(t))
				for k := range t {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				for _, k := range keys {
					walk(t[k], k)
				}
			case []any:
				for _, e := range t {
					walk(e, key)
				}
			}
		}
		walk(doc, "")
	}
	if len(out) < 2000 {
		tb.Fatalf("only %d golden packed values", len(out))
	}
	return out
}

// cacheOfKey is a per-id Redis key without its `:<id>` suffix.
func cacheOfKey(key string) string {
	if i := strings.LastIndexByte(key, ':'); i >= 0 {
		if _, err := strconv.Atoi(key[i+1:]); err == nil {
			return key[:i]
		}
	}
	return key
}

// diffDecoded is "" when a (the oracle's) and b (the reader's) are the same decoded value, else where
// and how they differ.
func diffDecoded(path string, a, b any) string {
	if reflect.TypeOf(a) != reflect.TypeOf(b) {
		return fmt.Sprintf("%s: type %T, reader %T", path, a, b)
	}
	switch x := a.(type) {
	case nil:
		return ""
	case float64:
		if math.Float64bits(x) != math.Float64bits(b.(float64)) {
			return fmt.Sprintf("%s: float %v (%x), reader %v", path, x, math.Float64bits(x), b)
		}
	case float32:
		if math.Float32bits(x) != math.Float32bits(b.(float32)) {
			return fmt.Sprintf("%s: float32 %v, reader %v", path, x, b)
		}
	case map[string]any:
		y := b.(map[string]any)
		if (x == nil) != (y == nil) || len(x) != len(y) {
			return fmt.Sprintf("%s: map of %d (nil %v), reader %d (nil %v)", path, len(x), x == nil, len(y), y == nil)
		}
		for k, v := range x {
			w, ok := y[k]
			if !ok {
				return fmt.Sprintf("%s: key %q missing", path, k)
			}
			if d := diffDecoded(path+"."+k, v, w); d != "" {
				return d
			}
		}
	case []any:
		y := b.([]any)
		if (x == nil) != (y == nil) || len(x) != len(y) {
			return fmt.Sprintf("%s: array of %d (nil %v), reader %d (nil %v)", path, len(x), x == nil, len(y), y == nil)
		}
		for i := range x {
			if d := diffDecoded(path+"["+strconv.Itoa(i)+"]", x[i], y[i]); d != "" {
				return d
			}
		}
	case superjson.Object:
		y := b.(superjson.Object)
		if (x == nil) != (y == nil) || len(x) != len(y) {
			return fmt.Sprintf("%s: object of %d, reader %d", path, len(x), len(y))
		}
		for i := range x {
			if x[i].Key != y[i].Key {
				return fmt.Sprintf("%s: key %d %q, reader %q", path, i, x[i].Key, y[i].Key)
			}
			if d := diffDecoded(path+"."+x[i].Key, x[i].Val, y[i].Val); d != "" {
				return d
			}
		}
	case []byte:
		y := b.([]byte)
		if (x == nil) != (y == nil) || string(x) != string(y) {
			return fmt.Sprintf("%s: bytes %x, reader %x", path, x, y)
		}
	case []int:
		y := b.([]int)
		if (x == nil) != (y == nil) || !reflect.DeepEqual(x, y) {
			return fmt.Sprintf("%s: ints %v, reader %v", path, x, y)
		}
	case time.Time:
		y := b.(time.Time)
		if !x.Equal(y) || x.Location() != y.Location() || x != y {
			return fmt.Sprintf("%s: time %v (%v), reader %v (%v)", path, x, x.Location(), y, y.Location())
		}
	case *jsUndefined:
	default:
		if a != b {
			return fmt.Sprintf("%s: %#v, reader %#v", path, a, b)
		}
	}
	return ""
}

// oracleIntList is the oracle's value with decodeOpts.intList applied: key's list as a []int when it
// is non-empty and every element is an integer that fits an int (the only decoded values that are).
func oracleIntList(v any, key string) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	l, ok := m[key].([]any)
	if !ok || len(l) == 0 {
		return v
	}
	ints := make([]int, len(l))
	for i, e := range l {
		switch n := e.(type) {
		case int64:
			ints[i] = int(n)
		case uint64:
			if n > math.MaxInt {
				return v
			}
			ints[i] = int(n)
		default:
			return v
		}
	}
	m[key] = ints
	return v
}

// sameAsOracle decodes raw with both decoders, plain, ordered and with an int list, and fails on any
// difference: the value, or one refusing what the other accepts.
func sameAsOracle(tb testing.TB, label string, raw []byte) {
	tb.Helper()
	own := append([]byte(nil), raw...)
	ov, oerr := oracleUnpack(own)
	v, err := Unpack(raw)
	if (oerr == nil) != (err == nil) {
		tb.Fatalf("%s: Unpack(% x): oracle err %v, reader err %v", label, raw, oerr, err)
	}
	if err == nil {
		if d := diffDecoded("", ov, v); d != "" {
			tb.Fatalf("%s: Unpack(% x): %s", label, raw, d)
		}
	}
	oo, ooerr := oracleUnpackOrdered(own)
	o, oerr2 := UnpackOrdered(raw)
	if (ooerr == nil) != (oerr2 == nil) {
		tb.Fatalf("%s: UnpackOrdered(% x): oracle err %v, reader err %v", label, raw, ooerr, oerr2)
	}
	if oerr2 == nil {
		if d := diffDecoded("", oo, o); d != "" {
			tb.Fatalf("%s: UnpackOrdered(% x): %s", label, raw, d)
		}
	}
	ol, olerr := oracleUnpack(own)
	l, lerr := unpackString(string(raw), "follows")
	if (olerr == nil) != (lerr == nil) {
		tb.Fatalf("%s: int-list Unpack(% x): oracle err %v, reader err %v", label, raw, olerr, lerr)
	}
	if lerr == nil {
		if d := diffDecoded("", oracleIntList(ol, "follows"), l); d != "" {
			tb.Fatalf("%s: int-list Unpack(% x): %s", label, raw, d)
		}
	}
}

// Every golden cache value (msgpackr's own bytes, every endpoint's fixtures) decodes to the oracle's
// value, plain and ordered.
func TestUnpackMatchesOracleOnGoldens(t *testing.T) {
	for _, p := range allGoldenPacked(t) {
		sameAsOracle(t, p.key, p.b)
	}
}

// oracleDecodeBytes is decodeBytes as it was, on the oracle.
func oracleDecodeBytes(b []byte, ttl time.Duration, now time.Time, ordered bool) (Entry, readState) {
	if len(b) == 0 {
		return Entry{}, stateAbsent
	}
	if ordered {
		v, err := oracleUnpackOrdered(b)
		if err != nil {
			return Entry{}, stateAbsent
		}
		obj, ok := v.(superjson.Object)
		if !ok {
			return Entry{}, stateAbsent
		}
		if d, _ := obj.Get("debounce"); truthy(d) {
			return Entry{}, stateHeld
		}
		e := Entry{isOrdered: true}
		at, _ := obj.Get("cachedAt")
		cachedAt, hasAt := at.(time.Time)
		if hasAt {
			e.CachedAt = cachedAt
		}
		if nf, _ := obj.Get("notFound"); truthy(nf) {
			e.NotFound = true
		} else if ttl > 0 && hasAt && cachedAt.Before(now.Add(-ttl)) {
			e.Stale = true
		}
		e.ordered = dropKey(obj, "cachedAt")
		return e, stateEntry
	}
	v, err := oracleUnpack(b)
	if err != nil {
		return Entry{}, stateAbsent
	}
	m, ok := v.(map[string]any)
	if !ok {
		return Entry{}, stateAbsent
	}
	if truthy(m["debounce"]) {
		return Entry{}, stateHeld
	}
	e := Entry{Value: m}
	if at, ok := m["cachedAt"].(time.Time); ok {
		e.CachedAt = at
	}
	if truthy(m["notFound"]) {
		e.NotFound = true
	} else if ttl > 0 {
		if at, ok := m["cachedAt"].(time.Time); ok && at.Before(now.Add(-ttl)) {
			e.Stale = true
		}
	}
	delete(m, "cachedAt")
	return e, stateEntry
}

// diffEntry is "" when the oracle's entry a and the reader's b are the same.
func diffEntry(a, b Entry) string {
	if a.NotFound != b.NotFound || a.Stale != b.Stale || !a.CachedAt.Equal(b.CachedAt) || a.CachedAt != b.CachedAt || a.isOrdered != b.isOrdered {
		return fmt.Sprintf("entry %+v, reader %+v", a, b)
	}
	if d := diffDecoded("Value", a.Value, b.Value); d != "" {
		return d
	}
	return diffDecoded("Ordered", a.ordered, b.ordered)
}

// Every golden value, read through a PackedReader (the Redis reply's string, the cache's own
// decodeOpts), is the entry the oracle made of it: the same state, markers, staleness, cachedAt and
// record, with the int-list caches' list unboxed. Each cache reads its own golden values and every
// seventh other one, so each cache's options also meet other caches' records.
func TestPackedReadMatchesOracle(t *testing.T) {
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	golden := allGoldenPacked(t)
	caches := map[string]bool{KeyUserFollows: true}
	for _, p := range golden {
		caches[p.cache] = true
	}
	r := testkit.NewRedis()
	pr := &PackedReader{Redis: r, Now: func() time.Time { return now }}
	for c := range caches {
		var ids []int
		var vals []oraclePacked
		for i, p := range golden {
			if p.cache == c || i%7 == 0 {
				ids = append(ids, i+1)
				vals = append(vals, p)
				r.SetString(c+":"+strconv.Itoa(i+1), p.b)
			}
		}
		opts := optsFor(c)
		for _, ttl := range []time.Duration{0, time.Hour} {
			b := NewBatch()
			read := pr.Queue(b, c, ids, ttl)
			b.Exec(context.Background())
			got, _ := read.read()
			for i, p := range vals {
				want, st := oracleDecodeBytes(append([]byte(nil), p.b...), ttl, now, opts.ordered)
				if opts.intList != "" && st == stateEntry {
					want.Value, _ = oracleIntList(want.Value, opts.intList).(map[string]any)
				}
				e, ok := got[ids[i]]
				if ok != (st == stateEntry) {
					t.Fatalf("%s as %s: entry %v, oracle state %d", p.key, c, ok, st)
				}
				if _, s2 := decodeValue(string(p.b), ttl, now, opts); s2 != st {
					t.Fatalf("%s as %s: state %d, oracle %d", p.key, c, s2, st)
				}
				if ok {
					if d := diffEntry(want, e); d != "" {
						t.Fatalf("%s as %s (ttl %v): %s", p.key, c, ttl, d)
					}
				}
			}
		}
	}
}

// mpGen writes random msgpack values in record-like shapes, covering every code msgpack has.
type mpGen struct {
	r *rand.Rand
	b []byte
}

var genKeys = []string{"id", "userId", "follows", "tags", "cachedAt", "notFound", "debounce", "name", "url", "nsfwLevel",
	"metadata", "data", "versions", "images", "10", "2", "0", "01", "4294967294", "4294967295", "", "a", "\xff\xfe"}

var genStrings = []string{"", "Public", "image", "Success", "SafeTensor", "Training Data", "x", "café", "\xc3\x28", "\xff",
	"a\x00b", strings.Repeat("long", 20), "No Pickle imports", "00000000-0000-4000-8000-000000000901"}

func (g *mpGen) u8(v byte) { g.b = append(g.b, v) }

func (g *mpGen) be(v uint64, n int) {
	for i := n - 1; i >= 0; i-- {
		g.b = append(g.b, byte(v>>(8*i)))
	}
}

func (g *mpGen) str(s string, bin bool) {
	n := len(s)
	switch {
	case bin && n < 256:
		g.u8(0xc4)
		g.be(uint64(n), 1)
	case bin:
		g.u8(0xc5)
		g.be(uint64(n), 2)
	case n < 32 && g.r.IntN(4) > 0:
		g.u8(0xa0 | byte(n))
	case n < 256 && g.r.IntN(2) == 0:
		g.u8(0xd9)
		g.be(uint64(n), 1)
	case g.r.IntN(2) == 0:
		g.u8(0xda)
		g.be(uint64(n), 2)
	default:
		g.u8(0xdb)
		g.be(uint64(n), 4)
	}
	g.b = append(g.b, s...)
}

func (g *mpGen) randString() string {
	if g.r.IntN(3) > 0 {
		return genStrings[g.r.IntN(len(genStrings))]
	}
	b := make([]byte, g.r.IntN(40))
	for i := range b {
		b[i] = byte(g.r.UintN(256))
	}
	return string(b)
}

// integer writes an integer in one of its encodings, edge values included.
func (g *mpGen) integer() {
	edges := []uint64{0, 1, 127, 128, 255, 256, 65535, 65536, 1<<31 - 1, 1 << 31, 1<<32 - 1, 1 << 32, 1<<53 + 1, 1<<63 - 1, 1 << 63, math.MaxUint64}
	switch g.r.IntN(12) {
	case 0:
		g.u8(byte(g.r.IntN(128)))
	case 1:
		g.u8(0xe0 | byte(g.r.IntN(32)))
	case 2:
		g.u8(0xcc)
		g.be(g.r.Uint64(), 1)
	case 3:
		g.u8(0xcd)
		g.be(g.r.Uint64(), 2)
	case 4:
		g.u8(0xce)
		g.be(g.r.Uint64(), 4)
	case 5:
		g.u8(0xcf)
		g.be(edges[g.r.IntN(len(edges))], 8)
	case 6:
		g.u8(0xd0)
		g.be(g.r.Uint64(), 1)
	case 7:
		g.u8(0xd1)
		g.be(g.r.Uint64(), 2)
	case 8:
		g.u8(0xd2)
		g.be(g.r.Uint64(), 4)
	case 9:
		g.u8(0xd3)
		g.be(edges[g.r.IntN(len(edges))], 8)
	case 10:
		g.u8(0xd3)
		g.be(-edges[g.r.IntN(len(edges))], 8)
	default:
		g.u8(0xce)
		g.be(uint64(1000+g.r.IntN(100000)), 4)
	}
}

func (g *mpGen) float() {
	f64 := []uint64{0, 1 << 63, math.Float64bits(math.NaN()), 0x7ff8000000000001, 0xfff0000000000000, 0x7ff0000000000000, math.Float64bits(1.5), math.Float64bits(-3.25e300), 1}
	f32 := []uint32{0, 1 << 31, 0x7fc00000, 0x7fc00001, 0xff800000, math.Float32bits(1.5), math.Float32bits(3.4e38), 1}
	if g.r.IntN(2) == 0 {
		g.u8(0xcb)
		if g.r.IntN(3) == 0 {
			g.be(g.r.Uint64(), 8)
		} else {
			g.be(f64[g.r.IntN(len(f64))], 8)
		}
		return
	}
	g.u8(0xca)
	g.be(uint64(f32[g.r.IntN(len(f32))]), 4)
}

// ext writes an extension: mostly timestamps (all three widths, edge instants) and `undefined`,
// sometimes another type or a timestamp of a wrong length.
func (g *mpGen) ext() {
	switch g.r.IntN(9) {
	case 0, 1:
		g.b = append(g.b, 0xd4, 0x00, byte(g.r.UintN(256))) // undefined
	case 2:
		g.b = append(g.b, 0xd6, 0xff)
		g.be(g.r.Uint64(), 4)
	case 3:
		g.b = append(g.b, 0xd7, 0xff)
		g.be(g.r.Uint64(), 8)
	case 4:
		g.b = append(g.b, 0xc7, 12, 0xff)
		g.be(uint64(g.r.IntN(2_000_000_000)), 4)
		secs := []int64{0, -62135596800, 1750000000, -1, math.MaxInt32}
		g.be(uint64(secs[g.r.IntN(len(secs))]), 8)
	case 5:
		g.b = append(g.b, 0xd5, 0x00, 0x01, 0x02) // undefined with 2 data bytes
	case 6:
		g.b = append(g.b, 0xd4, byte(1+g.r.IntN(126)), 0x00) // another type
	case 7:
		g.b = append(g.b, 0xd5, 0xff, 0x00, 0x00) // a timestamp of 2 bytes
	default:
		g.b = append(g.b, 0xc8, 0x00, 0x04, 0xff)
		g.be(uint64(1750000000), 4)
	}
}

func (g *mpGen) key() {
	switch g.r.IntN(40) {
	case 0:
		g.integer()
	case 1:
		g.u8(0xc0)
	case 2:
		g.str(genKeys[g.r.IntN(len(genKeys))], true)
	case 3:
		g.u8(0xc3)
	case 4:
		g.float()
	case 5:
		g.u8(0x91)
		g.u8(0x01)
	case 6:
		g.ext()
	default:
		g.str(genKeys[g.r.IntN(len(genKeys))], false)
	}
}

func (g *mpGen) value(depth int) {
	k := g.r.IntN(20)
	if depth > 4 && k >= 15 {
		k = g.r.IntN(15)
	}
	switch k {
	case 0, 1, 2:
		g.integer()
	case 3:
		g.float()
	case 4:
		g.u8(0xc0)
	case 5:
		g.u8(0xc2 + byte(g.r.IntN(2)))
	case 6, 7, 8:
		g.str(g.randString(), false)
	case 9:
		g.str(g.randString(), true)
	case 10, 11:
		g.ext()
	case 12:
		// An id list: every element an integer (the int-list fast path), sometimes one that is not.
		n := g.r.IntN(20)
		g.arrayHeader(n)
		bad := -1
		if g.r.IntN(3) == 0 && n > 0 {
			bad = g.r.IntN(n)
		}
		for i := range n {
			if i == bad {
				g.value(depth + 1)
			} else {
				g.integer()
			}
		}
	case 13, 14:
		g.u8(byte(g.r.IntN(256))) // any single byte: a fixint, a header, an invalid code
	case 15, 16:
		n := g.r.IntN(6)
		g.arrayHeader(n)
		for range n {
			g.value(depth + 1)
		}
	default:
		n := g.r.IntN(8)
		g.mapHeader(n)
		for range n {
			g.key()
			g.value(depth + 1)
		}
	}
}

func (g *mpGen) arrayHeader(n int) {
	switch {
	case n < 16 && g.r.IntN(3) > 0:
		g.u8(0x90 | byte(n))
	case g.r.IntN(2) == 0:
		g.u8(0xdc)
		g.be(uint64(n), 2)
	default:
		g.u8(0xdd)
		g.be(uint64(n), 4)
	}
}

func (g *mpGen) mapHeader(n int) {
	switch {
	case n < 16 && g.r.IntN(3) > 0:
		g.u8(0x80 | byte(n))
	case g.r.IntN(2) == 0:
		g.u8(0xde)
		g.be(uint64(n), 2)
	default:
		g.u8(0xdf)
		g.be(uint64(n), 4)
	}
}

// record writes a top-level map shaped like a cache record (the reader's main input).
func (g *mpGen) record() []byte {
	g.b = g.b[:0]
	n := 1 + g.r.IntN(10)
	g.mapHeader(n)
	for range n {
		g.key()
		g.value(1)
	}
	return append([]byte(nil), g.b...)
}

// Generated values, every msgpack code in record shapes, top-level scalars and nesting at the ordered
// depth bound, decode as the oracle decodes them.
func TestUnpackMatchesOracleOnGeneratedValues(t *testing.T) {
	g := &mpGen{r: rand.New(rand.NewPCG(1, 2))}
	for i := range 20000 {
		sameAsOracle(t, "record "+strconv.Itoa(i), g.record())
	}
	for i := range 5000 {
		g.b = g.b[:0]
		g.value(0)
		sameAsOracle(t, "value "+strconv.Itoa(i), append([]byte(nil), g.b...))
	}
	// Top-level scalars of every width (Unpack keeps their encoded type there).
	for _, b := range [][]byte{{0x05}, {0xff}, {0xcc, 0xc8}, {0xcd, 1, 2}, {0xce, 1, 2, 3, 4}, {0xcf, 1, 2, 3, 4, 5, 6, 7, 8},
		{0xd0, 0x80}, {0xd1, 0x80, 0}, {0xd2, 0x80, 0, 0, 0}, {0xd3, 0x80, 0, 0, 0, 0, 0, 0, 0}, {0xca, 0x7f, 0xc0, 0, 1},
		{0xcb, 0x80, 0, 0, 0, 0, 0, 0, 0}, {0xc4, 0}, {0xc4, 2, 'h', 'i'}, {0xa0}, {0xc0}, {0xc2}, {0xd4, 0, 0},
		{0xd6, 0xff, 0, 0, 0, 0}, {0x81, 0xc0, 0x01}, {0x81, 0xc4, 1, 'k', 0x01}, {0x81, 0x01, 0x01}, {0x82, 0xa1, 'a', 0x01, 0xa1, 'a', 0xd4, 0, 0},
		{0x82, 0xa1, 'a', 0xd4, 0, 0, 0xa1, 'a', 0x02}, {0x90}, {0x80}, {0xdc, 0, 0}, {0xde, 0, 0}} {
		sameAsOracle(t, fmt.Sprintf("% x", b), b)
	}
	// Nesting around maxOrderedDepth, arrays and maps.
	for depth := maxOrderedDepth - 2; depth <= maxOrderedDepth+2; depth++ {
		var arr, obj []byte
		for range depth {
			arr = append(arr, 0x91)
			obj = append(obj, 0x81, 0xa1, 'k')
		}
		sameAsOracle(t, "array depth "+strconv.Itoa(depth), append(arr, 0x01))
		sameAsOracle(t, "map depth "+strconv.Itoa(depth), append(obj, 0x01))
	}
}

// Byte-level mutations of the golden values (a flipped, dropped, inserted or truncated byte, which
// can make any length, code or extension wrong): the reader refuses exactly what the oracle refuses
// and decodes the rest the same.
func TestUnpackMatchesOracleOnMutatedGoldens(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	for _, p := range allGoldenPacked(t) {
		for range 8 {
			b := append([]byte(nil), p.b...)
			if len(b) == 0 {
				continue
			}
			i := r.IntN(len(b))
			switch r.IntN(4) {
			case 0:
				b[i] ^= byte(1 + r.IntN(255))
			case 1:
				b = append(b[:i], b[i+1:]...)
			case 2:
				b = append(b[:i], append([]byte{byte(r.UintN(256))}, b[i:]...)...)
			default:
				b = b[:i]
			}
			sameAsOracle(t, p.key+" mutated", b)
		}
	}
}

// FuzzUnpackMatchesOracle: on any input, the reader and the oracle agree (sameAsOracle), never
// panicking. Seeds: every golden cache value and a generated corpus.
func FuzzUnpackMatchesOracle(f *testing.F) {
	for _, p := range allGoldenPacked(f) {
		f.Add(p.b)
	}
	g := &mpGen{r: rand.New(rand.NewPCG(5, 6))}
	for range 200 {
		f.Add(g.record())
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		sameAsOracle(t, "fuzz", raw)
	})
}

// A user-follows record's list decodes unboxed, as a []int (one allocation for the list, not one per
// id), and reads as the same follows; a list that is not all integers, or an empty one, stays the
// []any it was, with the same answer or the same fallback. Fails before the int-list reader: the
// list was a []any.
func TestUserFollowsListDecodesUnboxed(t *testing.T) {
	enc := func(follows []byte, n int) []byte {
		b := []byte{0x82, 0xa6}
		b = append(b, "userId"...)
		b = append(b, 0xcd, 0x07, 0xd1, 0xa7) // 2001
		b = append(b, "follows"...)
		if n >= 0 {
			b = append(b, 0xdc, byte(n>>8), byte(n))
		}
		return append(b, follows...)
	}
	ids := make([]byte, 0, 900)
	want := make([]int, 0, 300)
	for i := range 300 {
		id := 3000 + i*7
		ids = append(ids, 0xcd, byte(id>>8), byte(id))
		want = append(want, id)
	}
	e, st := decodeValue(string(enc(ids, 300)), 0, time.Now(), optsFor(KeyUserFollows))
	if st != stateEntry {
		t.Fatalf("state %d", st)
	}
	got, ok := e.Value["follows"].([]int)
	if !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("follows decoded as %T %v, want []int of %d ids", e.Value["follows"], e.Value["follows"], len(want))
	}
	if ids, err := userFollowsFrom(2001, map[int]Entry{2001: e}); err != nil || !reflect.DeepEqual(ids, want) {
		t.Fatalf("userFollowsFrom = %v, %v", ids, err)
	}
	// Another cache's list of integers is untouched.
	if e, _ := decodeValue(string(enc(ids, 300)), 0, time.Now(), optsFor(KeyTagIDs)); reflect.TypeOf(e.Value["follows"]) != reflect.TypeOf([]any{}) {
		t.Fatalf("tag-ids cache decoded follows as %T", e.Value["follows"])
	}
	cases := map[string]struct {
		follows []byte
		n       int
		wantIDs []int
		reason  string
	}{
		"negative and int64":  {[]byte{0xff, 0xd3, 0, 0, 0, 0, 0, 0, 0, 9, 0xd0, 0x80}, 3, []int{-1, 9, -128}, ""},
		"uint64 over MaxInt":  {[]byte{0x01, 0xcf, 0x80, 0, 0, 0, 0, 0, 0, 0}, 2, nil, "user-follows-shape"},
		"a string id":         {[]byte{0x01, 0xa1, '2'}, 2, nil, "user-follows-shape"},
		"an integral float":   {[]byte{0x01, 0xcb, 0x40, 0, 0, 0, 0, 0, 0, 0}, 2, []int{1, 2}, ""},
		"a fractional float":  {[]byte{0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0}, 1, nil, "user-follows-shape"},
		"a nil element":       {[]byte{0x01, 0xc0}, 2, nil, "user-follows-shape"},
		"empty":               {nil, 0, []int{}, ""},
		"nil":                 {[]byte{0xc0}, -1, []int{}, ""},
		"undefined":           {[]byte{0xd4, 0, 0}, -1, []int{}, ""},
		"not a list":          {[]byte{0x05}, -1, nil, "user-follows-shape"},
		"a nested list":       {[]byte{0x91, 0x01}, 1, nil, "user-follows-shape"},
		"an undefined inside": {[]byte{0x01, 0xd4, 0, 0}, 2, nil, "user-follows-shape"},
	}
	for name, c := range cases {
		b := enc(c.follows, c.n)
		e, st := decodeValue(string(b), 0, time.Now(), optsFor(KeyUserFollows))
		o, ost := oracleDecodeBytes(b, 0, time.Now(), false)
		if st != stateEntry || ost != stateEntry {
			t.Fatalf("%s: states %d, oracle %d", name, st, ost)
		}
		ids, err := userFollowsFrom(2001, map[int]Entry{2001: e})
		oids, oerr := userFollowsFrom(2001, map[int]Entry{2001: o})
		if !reflect.DeepEqual(ids, oids) || fmt.Sprint(err) != fmt.Sprint(oerr) {
			t.Fatalf("%s: %v %v, oracle %v %v", name, ids, err, oids, oerr)
		}
		if c.reason != "" {
			if err == nil || !strings.Contains(err.Error(), c.reason) {
				t.Fatalf("%s: err %v, want %s", name, err, c.reason)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(ids, c.wantIDs) {
			t.Fatalf("%s: %v %v, want %v", name, ids, err, c.wantIDs)
		}
	}
}

// The reader allocates at most half what the oracle did over the golden corpus (the strings are not
// copied, no decoder or normalize pass, common enum values pre-boxed). Fails if the reader regresses
// to the generic decoder's cost.
func TestUnpackAllocatesLessThanOracle(t *testing.T) {
	golden := allGoldenPacked(t)
	strs := make([]string, len(golden))
	for i, p := range golden {
		strs[i] = string(p.b)
	}
	reader := testing.AllocsPerRun(5, func() {
		for i, p := range golden {
			if orderedCaches[p.cache] {
				_, _ = unpackOrderedString(strs[i])
			} else {
				_, _ = unpackString(strs[i], "")
			}
		}
	})
	oracle := testing.AllocsPerRun(5, func() {
		for _, p := range golden {
			if orderedCaches[p.cache] {
				_, _ = oracleUnpackOrdered(p.b)
			} else {
				_, _ = oracleUnpack(p.b)
			}
		}
	})
	t.Logf("allocations over %d golden values: reader %v, oracle %v", len(golden), reader, oracle)
	if reader*2 > oracle {
		t.Fatalf("reader allocated %v times, oracle %v: want at most half", reader, oracle)
	}
}
