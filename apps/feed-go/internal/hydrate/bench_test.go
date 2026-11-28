package hydrate

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// goldenPacked returns every msgpackr value the as-posts golden fixtures hold, by Redis key: real
// shapes of each cache this package reads (users, cosmetics, profile pictures, frames, thumbnails,
// tag ids), written by testdata/golden/pack.mjs with msgpackr itself.
func goldenPacked(tb testing.TB) map[string][]byte {
	tb.Helper()
	files, err := filepath.Glob("../../testdata/golden/as-posts/*.json")
	if err != nil || len(files) == 0 {
		tb.Fatalf("no golden fixtures: %v", err)
	}
	out := map[string][]byte{}
	for _, f := range files {
		// The cold-cache and minor-content-rule fixtures add keys of their own: kept out, so the
		// benchmarks' corpus (and the allocs/op gate's base-vs-head comparison) does not move when one
		// is added.
		if name := filepath.Base(f); strings.HasPrefix(name, "cold-") || strings.HasPrefix(name, "minor-mature-") {
			continue
		}
		raw, err := os.ReadFile(f) //nolint:gosec // G304: path is a fixture from the testdata glob
		if err != nil {
			tb.Fatal(err)
		}
		var fx struct {
			Redis map[string]struct {
				Packed string `json:"packed"`
			} `json:"redis"`
		}
		if err := json.Unmarshal(raw, &fx); err != nil {
			tb.Fatalf("%s: %v", f, err)
		}
		for k, e := range fx.Redis {
			if e.Packed == "" {
				continue
			}
			b, err := base64.StdEncoding.DecodeString(e.Packed)
			if err != nil {
				tb.Fatalf("%s %s: %v", f, k, err)
			}
			out[k] = b
		}
	}
	return out
}

// BenchmarkUnpack decodes every golden cache value once per iteration (sorted, so each run does the
// same work).
func BenchmarkUnpack(b *testing.B) {
	packed := goldenPacked(b)
	keys := make([]string, 0, len(packed))
	for k := range packed {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) < 50 {
		b.Fatalf("only %d golden packed values", len(keys))
	}
	values := make([][]byte, len(keys))
	for i, k := range keys {
		values[i] = packed[k]
	}
	b.ReportAllocs()
	for b.Loop() {
		for _, v := range values {
			if _, err := Unpack(v); err != nil {
				b.Fatal(err)
			}
		}
	}
}

// BenchmarkTagIDs reads a 50-image page of tag-id entries through the in-memory Redis fake: the
// pipeline, Unpack per entry and the wire conversion. The entries are the golden fixtures' own
// tag-id values, cycled over 50 image ids.
func BenchmarkTagIDs(b *testing.B) {
	packed := goldenPacked(b)
	keys := make([]string, 0, len(packed))
	for k := range packed {
		if strings.HasPrefix(k, KeyTagIDs+":") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	samples := make([][]byte, 0, len(keys))
	for _, k := range keys {
		samples = append(samples, packed[k])
	}
	if len(samples) == 0 {
		b.Fatal("no golden tag-id entries")
	}
	r := testkit.NewRedis()
	ids := make([]int, 50)
	for i := range ids {
		ids[i] = 900000 + i
		r.SetString(KeyTagIDs+":"+strconv.Itoa(ids[i]), samples[i%len(samples)])
	}
	s := &Sources{Packed: &PackedReader{Redis: r}}
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		got, err := s.TagIDs(ctx, ids)
		if err != nil || len(got) != len(ids) {
			b.Fatalf("TagIDs = %d entries, %v", len(got), err)
		}
	}
}

// goldenPackedIn is every distinct packed value under a key with prefix in the golden fixtures of dir,
// sorted (so each run does the same work).
func goldenPackedIn(tb testing.TB, dir, prefix string) [][]byte {
	tb.Helper()
	files, err := filepath.Glob(filepath.Join("../../testdata/golden", dir, "*.json"))
	if err != nil || len(files) == 0 {
		tb.Fatalf("no %s golden fixtures: %v", dir, err)
	}
	seen := map[string]bool{}
	for _, f := range files {
		raw, err := os.ReadFile(f) //nolint:gosec // G304: path is a fixture from the testdata glob
		if err != nil {
			tb.Fatal(err)
		}
		var fx struct {
			Redis map[string]struct {
				Packed string `json:"packed"`
			} `json:"redis"`
		}
		if err := json.Unmarshal(raw, &fx); err != nil {
			tb.Fatalf("%s: %v", f, err)
		}
		for k, e := range fx.Redis {
			if !strings.HasPrefix(k, prefix) || e.Packed == "" {
				continue
			}
			b, err := base64.StdEncoding.DecodeString(e.Packed)
			if err != nil {
				tb.Fatalf("%s %s: %v", f, k, err)
			}
			seen[string(b)] = true
		}
	}
	out := make([]string, 0, len(seen))
	for v := range seen {
		out = append(out, v)
	}
	sort.Strings(out)
	values := make([][]byte, len(out))
	for i, v := range out {
		values[i] = []byte(v)
	}
	return values
}

// unpackCacheEntries is the number of entries one served request reads from a per-item cache: a page
// of 100 models (model.getAll's `limit: 100`) or 100 images (image.getInfinite's).
const unpackCacheEntries = 100

// BenchmarkUnpackCache decodes, per op, the entries of one cache one served request reads, with the
// decoder its read path uses (UnpackOrdered for an ordered cache, orderedCaches; Unpack otherwise):
//   - model-data: 100 data-for-model entries, cycling every distinct one the model.getAll golden
//     fixtures hold (msgpackr's own bytes);
//   - tag-ids: 100 tag-id entries of 25 tag ids each (a production image's tag count), written as
//     msgpackr writes them (jspack.Pack);
//   - follows: the viewer's follow list, one entry of 1000 user ids.
func BenchmarkUnpackCache(b *testing.B) {
	at := time.Date(2026, 6, 15, 11, 55, 0, 0, time.UTC)
	modelData := goldenPackedIn(b, "model-getall", KeyDataForModel+":")
	if len(modelData) < 5 {
		b.Fatalf("only %d golden data-for-model values", len(modelData))
	}
	tags := make([]any, 25)
	for i := range tags {
		tags[i] = 500 + 7*i
	}
	follows := make([]any, 1000)
	for i := range follows {
		follows[i] = 100000 + 37*i
	}
	cases := []struct {
		name    string
		ordered bool
		values  [][]byte
	}{
		{"model-data", orderedCaches[KeyDataForModel], func() [][]byte {
			out := make([][]byte, unpackCacheEntries)
			for i := range out {
				out[i] = modelData[i%len(modelData)]
			}
			return out
		}()},
		{"tag-ids", orderedCaches[KeyTagIDs], func() [][]byte {
			out := make([][]byte, unpackCacheEntries)
			for i := range out {
				out[i] = jspack.Pack(jspack.O("imageId", 900000+i, "tags", tags, "cachedAt", at))
			}
			return out
		}()},
		{"follows", orderedCaches[KeyUserFollows], [][]byte{jspack.Pack(jspack.O("userId", 1003, "follows", follows, "cachedAt", at))}},
	}
	for _, c := range cases {
		b.Run(c.name, func(b *testing.B) {
			decode := Unpack
			if c.ordered {
				decode = UnpackOrdered
			}
			for _, v := range c.values {
				if _, err := decode(v); err != nil {
					b.Fatalf("a %s value does not decode: %v", c.name, err)
				}
			}
			b.ReportAllocs()
			for b.Loop() {
				for _, v := range c.values {
					if _, err := decode(v); err != nil {
						b.Fatal(err)
					}
				}
			}
		})
	}
}
