package hydrate

import (
	"strings"
	"testing"
	"time"
)

// oracleBenchCaches are the caches BenchmarkUnpackVsOracle decodes, by sub-benchmark name: the
// golden values of each (user-follows: a synthetic record of 2000 ids, the goldens' own being a few
// ids long).
var oracleBenchCaches = []struct{ name, key string }{
	{"model-data", KeyDataForModel},
	{"version-images", KeyVersionImages},
	{"tag-ids", KeyTagIDs},
	{"basic-users", KeyBasicUsers},
	{"profile-pictures", KeyProfilePictures},
	{"user-cosmetics", KeyUserCosmetics},
	{"image-frames", KeyImageFrames},
	{"user-follows", KeyUserFollows},
}

// followsRecord is a user-follows record as msgpackr writes it: {userId, follows: [n ids], cachedAt}.
func followsRecord(n int) []byte {
	b := []byte{0x83, 0xa6}
	b = append(b, "userId"...)
	b = append(b, 0xcd, 0x07, 0xd1, 0xa7)
	b = append(b, "follows"...)
	b = append(b, 0xdc, byte(n>>8), byte(n)) //nolint:gosec // G115: n < 65536, the array16 length
	for i := range n {
		id := 100000 + i*37
		b = append(b, 0xce, 0, byte(id>>16), byte(id>>8), byte(id)) //nolint:gosec // G115: the id's low three bytes (it is below 2^24)
	}
	b = append(b, 0xa8)
	b = append(b, "cachedAt"...)
	return append(b, 0xd6, 0xff, 0x68, 0x4e, 0x9a, 0x00)
}

// BenchmarkUnpackVsOracle decodes each cache's values into entries (decodeValue, the read path's own
// options) with the single-pass reader ("reader") and with the generic decoder it replaced
// ("oracle"), so one run carries the before and the after of the same work.
func BenchmarkUnpackVsOracle(b *testing.B) {
	byCache := map[string][][]byte{}
	for _, p := range allGoldenPacked(b) {
		byCache[p.cache] = append(byCache[p.cache], p.b)
	}
	byCache[KeyUserFollows] = [][]byte{followsRecord(2000)}
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	for _, c := range oracleBenchCaches {
		values := byCache[c.key]
		if len(values) == 0 {
			b.Fatalf("%s: no values", c.name)
		}
		strs := make([]string, len(values))
		for i, v := range values {
			strs[i] = string(v)
		}
		opts := optsFor(c.key)
		entries := 0
		for _, s := range strs {
			if _, st := decodeValue(s, time.Hour, now, opts); st == stateEntry {
				entries++
			}
		}
		if entries == 0 {
			b.Fatalf("%s: no value decodes to an entry", c.name)
		}
		b.Run(strings.ReplaceAll(c.name, ":", "-")+"/reader", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				for _, s := range strs {
					decodeValue(s, time.Hour, now, opts)
				}
			}
		})
		b.Run(strings.ReplaceAll(c.name, ":", "-")+"/oracle", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				for _, v := range values {
					oracleDecodeBytes(v, time.Hour, now, opts.ordered)
				}
			}
		})
	}
}
