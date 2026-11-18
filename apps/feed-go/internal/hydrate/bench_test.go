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
		// The cold-cache fixtures add keys of their own: kept out, so the benchmarks' corpus (and the
		// allocs/op gate's base-vs-head comparison) does not move when one is added.
		if strings.HasPrefix(filepath.Base(f), "cold-") {
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
