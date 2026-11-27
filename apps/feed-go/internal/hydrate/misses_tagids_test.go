package hydrate

import (
	"context"
	"encoding/hex"
	"errors"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The tag-ids miss computation (tagIdsForImagesCache's lookupFn, src/server/redis/caches.ts) over
// basePageFixture's page. Expected cache values are msgpackr 1.11.5's bytes, as misses_test.go's:
//
//	const { pack } = require('msgpackr'); const now = new Date('2026-06-15T12:00:00.000Z');
//	pack(<value>).toString('hex')
const (
	// {imageId:11, tags:[21,23,24,25,27,29], cachedAt:now}
	wantTags11 = "de0003a7696d61676549640ba47461677396151718191b1da86361636865644174d6ff6a2fe940"
	// {imageId:12, tags:[22], cachedAt:now}
	wantTags12 = "de0003a7696d61676549640ca4746167739116a86361636865644174d6ff6a2fe940"
	// {imageId:13, notFound:true, cachedAt:now}
	wantTags13Marker = "de0003a7696d61676549640da86e6f74466f756e64c3a86361636865644174d6ff6a2fe940"
	// {imageId:14, tags:[], cachedAt:now}
	wantTags14 = "de0003a7696d61676549640ea47461677390a86361636865644174d6ff6a2fe940"
)

// tagGateSpy is a MissCompute.TagGate answering gate (or err), counting its calls.
type tagGateSpy struct {
	mu    sync.Mutex
	calls int
	gate  map[int]bool
	err   error
}

func (g *tagGateSpy) fn(context.Context) (map[int]bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls++
	return g.gate, g.err
}

func (g *tagGateSpy) n() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calls
}

// tagIDsMissFixture is basePageFixture with every tag-ids entry gone and the rows the lookup reads:
//
//   - image 11 is WD14-tagged (21), so its Rekognition labels are kept only for a reason: 22 (a
//     Label no rule gates: dropped), 23 ('anime', always included), 24 (Moderation), 25 (gated by a
//     browsing rule), 29 (nameless); 26 is a notFound marker in the tag cache and 27 a cached tag;
//   - image 12 has the same Rekognition label 22 but no WD14 row: kept;
//   - image 13 has no row: a notFound marker;
//   - image 14's only tag (28) is in neither the tag cache nor the Tag table: `tags: []`.
//
// Tags 21 and 27 come from the tag cache, 22..25, 28 and 29 from the replica.
func tagIDsMissFixture(t *testing.T) (*pageFixture, *missDB) {
	t.Helper()
	f := basePageFixture(t)
	for _, id := range []int{11, 12, 13, 14} {
		f.del(KeyTagIDs, id)
	}
	f.put(t, KeyBasicTags, 21, map[string]any{"id": 21, "name": "wd-tag", "type": "Label", "nsfwLevel": 1, "cachedAt": pageNow})
	f.put(t, KeyBasicTags, 26, map[string]any{"notFound": true})
	f.put(t, KeyBasicTags, 27, map[string]any{"id": 27, "name": "cached", "type": "UserGenerated", "nsfwLevel": 1, "cachedAt": pageNow})
	m := &missDB{
		tagRows: map[int][][]any{
			11: {
				{int64(11), "WD14", int64(21)}, {int64(11), "Rekognition", int64(22)}, {int64(11), "Rekognition", int64(23)},
				{int64(11), "Rekognition", int64(24)}, {int64(11), "Rekognition", int64(25)}, {int64(11), "User", int64(26)},
				{int64(11), "User", int64(27)}, {int64(11), "Rekognition", int64(29)},
			},
			12: {{int64(12), "Rekognition", int64(22)}},
			14: {{int64(14), "User", int64(28)}},
		},
		tags: map[int][]any{
			22: {int64(22), "dress", "Label"},
			23: {int64(23), "anime", "Label"},
			24: {int64(24), "nudity", "Moderation"},
			25: {int64(25), "gated", "Label"},
			29: {int64(29), "", "Label"},
		},
	}
	return f, m
}

// A tag-ids miss is the lookup's answer, filtered as Node filters it, served as a hit is; written
// back only with WriteBack, as Node writes it (EX 9h for values and markers).
func TestPageComputesTagIDsMiss(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			f, m := tagIDsMissFixture(t)
			gate := &tagGateSpy{gate: map[int]bool{25: true, 99: true}}
			obs := &observed{}
			s, r := m.load(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, TagGate: gate.fn, Observe: obs.observe})
			got, err := s.Page(context.Background(), pageRequest())
			if err != nil {
				t.Fatalf("Page: %v (fallback %q)", err, fallback.Reason(err))
			}
			for id, want := range map[int]string{11: `[21,23,24,25,27,29]`, 12: `[22]`, 14: `[]`} {
				if s := pagePlain(t, got.TagIDs[id]); s != want {
					t.Errorf("image %d tag ids %s, want %s", id, s, want)
				}
			}
			if keys := sortedKeys(got.TagIDs); !reflect.DeepEqual(keys, []int{11, 12, 14}) {
				t.Fatalf("tag ids for %v, want [11 12 14] (13 has no row: no tags)", keys)
			}
			if q := m.queries("tagrows"); !reflect.DeepEqual(q, [][]int{{11, 12, 13, 14}}) {
				t.Fatalf("tag row queries %v, want one for the four misses", q)
			}
			// 21 and 27 are cached, 26 a cached notFound marker: the replica is asked for the rest.
			if q := m.queries("tags"); !reflect.DeepEqual(q, [][]int{{22, 23, 24, 25, 29, 28}}) {
				t.Fatalf("tag queries %v, want the tags the cache misses", q)
			}
			if n := gate.n(); n != 1 {
				t.Fatalf("the gate was read %d times, want once for the page", n)
			}
			if o := obs.get(); o["tag-ids/computed"] != 4 || o["tag-ids/error"] != 0 {
				t.Fatalf("observed %v, want 4 computed tag-ids ids", o)
			}
			keys := []string{pageNS + missKey(KeyTagIDs, 11), pageNS + missKey(KeyTagIDs, 12), pageNS + missKey(KeyTagIDs, 13), pageNS + missKey(KeyTagIDs, 14)}
			if !writeBack {
				wantAbsent(t, r, keys...)
				return
			}
			wantPacked(t, r, missKey(KeyTagIDs, 11), wantTags11, 9*time.Hour)
			wantPacked(t, r, missKey(KeyTagIDs, 12), wantTags12, 9*time.Hour)
			wantPacked(t, r, missKey(KeyTagIDs, 13), wantTags13Marker, 9*time.Hour)
			wantPacked(t, r, missKey(KeyTagIDs, 14), wantTags14, 9*time.Hour)
		})
	}
}

// Warm tag ids (basePageFixture: two hits, a notFound marker, an entry without tags) are served with
// no lookup, and a miss without a computation still falls back.
func TestTagIDsHitsSendNoLookup(t *testing.T) {
	m := &missDB{}
	s, _ := m.load(basePageFixture(t), &MissCompute{FrameNegative: true})
	got, err := s.Page(context.Background(), pageRequest())
	if err != nil {
		t.Fatal(err)
	}
	if keys := sortedKeys(got.TagIDs); !reflect.DeepEqual(keys, []int{11, 13}) {
		t.Fatalf("tag ids for %v, want the two cached lists", keys)
	}
	if q := m.queries("tagrows"); len(q) != 0 {
		t.Fatalf("tag row queries %v for a warm page, want none", q)
	}
	f, _ := tagIDsMissFixture(t)
	plain, _, _ := f.load()
	if _, err := plain.Page(context.Background(), pageRequest()); fallback.Reason(err) != "tag-ids-miss" {
		t.Fatalf("no computation: %v, want tag-ids-miss", err)
	}
}

// The gate is read only when a row needs it; without one, or when it fails, a row that needs it
// fails the lookup (tag-ids-miss-failed), and so does a failed tag query.
func TestTagIDsGate(t *testing.T) {
	ctx := context.Background()
	t.Run("not needed", func(t *testing.T) {
		f, m := tagIDsMissFixture(t)
		gate := &tagGateSpy{}
		s, _ := m.load(f, &MissCompute{FrameNegative: true, TagGate: gate.fn})
		got, err := s.TagIDs(ctx, []int{12, 13, 14}) // no WD14 row among them
		if err != nil {
			t.Fatal(err)
		}
		if s := pagePlain(t, got[12]); s != `[22]` || gate.n() != 0 {
			t.Fatalf("12 = %s with %d gate reads, want [22] and none", s, gate.n())
		}
		// No gate configured and none needed: still computed.
		f, m = tagIDsMissFixture(t)
		s, _ = m.load(f, &MissCompute{FrameNegative: true})
		if _, err := s.TagIDs(ctx, []int{12}); err != nil {
			t.Fatalf("no gate, none needed: %v", err)
		}
	})
	for _, tc := range []struct {
		name string
		c    func(*tagGateSpy) *MissCompute
	}{
		{"no gate", func(*tagGateSpy) *MissCompute { return &MissCompute{FrameNegative: true} }},
		{"gate error", func(g *tagGateSpy) *MissCompute {
			g.err = errors.New("blocked list unreadable")
			return &MissCompute{FrameNegative: true, TagGate: g.fn}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, m := tagIDsMissFixture(t)
			obs := &observed{}
			c := tc.c(&tagGateSpy{})
			c.Observe = obs.observe
			s, _ := m.load(f, c)
			_, err := s.Page(ctx, pageRequest())
			if got := fallback.Reason(err); got != "tag-ids-miss-failed" {
				t.Fatalf("err %v (reason %q), want tag-ids-miss-failed", err, got)
			}
			if o := obs.get(); o["tag-ids/error"] != 4 {
				t.Fatalf("observed %v, want 4 tag-ids errors", o)
			}
		})
	}
	t.Run("tag query fails", func(t *testing.T) {
		f, m := tagIDsMissFixture(t)
		m.fail = "tags"
		s, _ := m.load(f, &MissCompute{FrameNegative: true, TagGate: (&tagGateSpy{}).fn})
		if _, err := s.Page(ctx, pageRequest()); fallback.Reason(err) != "tag-ids-miss-failed" {
			t.Fatalf("err %v, want tag-ids-miss-failed", err)
		}
	})
}

// Write-back off, the tag-ids answers are kept for recentTTL (memoized): the same miss twice is one
// lookup. Write-back on, the second read is a hit of what the first wrote.
func TestTagIDsMissRepeatsShareOneLookup(t *testing.T) {
	f, m := tagIDsMissFixture(t)
	s, _ := m.load(f, &MissCompute{FrameNegative: true, TagGate: (&tagGateSpy{gate: map[int]bool{}}).fn})
	for i := 0; i < 2; i++ {
		got, err := s.TagIDs(context.Background(), []int{12, 14})
		if err != nil {
			t.Fatal(err)
		}
		if s := pagePlain(t, got[12]); s != `[22]` {
			t.Fatalf("call %d: 12 = %s", i, s)
		}
	}
	if q := m.queries("tagrows"); !reflect.DeepEqual(q, [][]int{{12, 14}}) {
		t.Fatalf("tag row queries %v, want one (the second call answered from the kept answers)", q)
	}
}

// Which caches keep their answers in process: with write-back off every computed cache but the image
// meta and the user follows (tag ids, model frames, model decorations, version showcases, model data,
// model tags, the official models, image metrics and image tags included), with it on none but the
// image tags, which are never written (not a WriteCaches name), so nothing else answers their
// repeats. The user follows are never kept: the viewer's own follow set, read back after they change it.
// Nor is the version-showcase decision, which is computed outside lookupShared and keeps nothing, nor
// the gallery hold (a safety rule a kept answer could hold past its bust).
func TestMemoizedCaches(t *testing.T) {
	off, on := &MissCompute{}, &MissCompute{WriteBack: AllWrites()}
	want := map[string]bool{MissUserCosmetics: true, MissImageFrames: true, MissEventDecorations: true, MissImageMeta: false,
		MissTagIDs: true, MissModelFrames: true, MissModelDecorations: true, MissVersionImages: true, MissMetrics: true,
		"model-data": true, "model-tags": true, "official-models": true, "image-tags": true,
		"user-follows": false, "version-showcase": false, "image-resources": false, "creator-memberships": false, "gallery-hold": false,
		"version-files": false}
	if len(want) != len(MissCaches) {
		t.Fatalf("MissCaches %v; this test enumerates %d", MissCaches, len(want))
	}
	for _, c := range MissCaches {
		if got := off.memoized(c); got != want[c] {
			t.Errorf("write-back off: memoized(%s) = %v, want %v", c, got, want[c])
		}
		if got := on.memoized(c); got != (c == MissImageTags) {
			t.Errorf("write-back on: memoized(%s) = %v, want %v", c, got, c == MissImageTags)
		}
	}
}

// tagLockKey is the revalidation lock Node's fetch takes for a stale tag-ids entry.
func tagLockKey(id int) string { return pageNS + "cache-lock:" + pageNS + missKey(KeyTagIDs, id) }

// staleTagIDsFixture is tagIDsMissFixture with image 12's entry back, stale: cachedAt past the 8h ttl
// (as a bust backdates it), holding tags Node has since replaced; image 11's entry is back and
// fresh (an hour old).
func staleTagIDsFixture(t *testing.T) (*pageFixture, *missDB) {
	t.Helper()
	f, m := tagIDsMissFixture(t)
	f.put(t, KeyTagIDs, 12, map[string]any{"imageId": 12, "tags": []any{77}, "cachedAt": pageNow.Add(-8*time.Hour - time.Minute)})
	f.put(t, KeyTagIDs, 11, map[string]any{"imageId": 11, "tags": []any{66}, "cachedAt": pageNow.Add(-time.Hour)})
	return f, m
}

// A stale tag-ids entry is looked up again, as Node's fetch revalidates it, and a fresh one is served:
// with write-back off nothing is written; with it on the stale entry is replaced (a plain SET, where
// every other write is SET NX) under Node's revalidation lock, which is released after.
func TestStaleTagIDsAreRevalidated(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		t.Run(strconv.FormatBool(writeBack), func(t *testing.T) {
			f, m := staleTagIDsFixture(t)
			s, r := m.load(f, &MissCompute{WriteBack: writeSet(writeBack), FrameNegative: true, TagGate: (&tagGateSpy{}).fn})
			got, err := s.TagIDs(context.Background(), []int{11, 12})
			if err != nil {
				t.Fatal(err)
			}
			if s := pagePlain(t, got[12]); s != `[22]` {
				t.Fatalf("stale 12 = %s, want [22] (looked up again)", s)
			}
			if s := pagePlain(t, got[11]); s != `[66]` {
				t.Fatalf("fresh 11 = %s, want the cached [66]", s)
			}
			if q := m.queries("tagrows"); !reflect.DeepEqual(q, [][]int{{12}}) {
				t.Fatalf("tag row queries %v, want only the stale 12", q)
			}
			if r.Has(tagLockKey(12)) || r.Has(tagLockKey(11)) {
				t.Fatal("a revalidation lock was left behind")
			}
			b, _ := r.String(pageNS + missKey(KeyTagIDs, 12))
			if !writeBack {
				if hex.EncodeToString(b) == wantTags12 {
					t.Fatal("write-back off wrote the revalidated entry")
				}
				return
			}
			wantPacked(t, r, missKey(KeyTagIDs, 12), wantTags12, 9*time.Hour)
		})
	}
}

// With write-back on, a stale entry whose revalidation lock another process holds is served, as
// Node's fetch serves it, and neither looked up nor written; the lock is left to its holder.
func TestStaleTagIDsLockHeldServesStale(t *testing.T) {
	f, m := staleTagIDsFixture(t)
	s, r := m.load(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true})
	r.SetString(tagLockKey(12), []byte("1"))
	before, _ := r.String(pageNS + missKey(KeyTagIDs, 12))
	got, err := s.TagIDs(context.Background(), []int{12})
	if err != nil {
		t.Fatal(err)
	}
	if s := pagePlain(t, got[12]); s != `[77]` {
		t.Fatalf("12 = %s, want the stale [77] (the lock is held)", s)
	}
	if q := m.queries("tagrows"); len(q) != 0 {
		t.Fatalf("tag row queries %v, want none", q)
	}
	if after, _ := r.String(pageNS + missKey(KeyTagIDs, 12)); string(after) != string(before) || !r.Has(tagLockKey(12)) {
		t.Fatal("the stale entry or another holder's lock was touched")
	}
}

// A stale entry the lookup no longer finds: the marker write is SET NX, as Node's, so the stale value
// stays (and is revalidated again on the next read).
func TestStaleTagIDsMarkerKeepsNX(t *testing.T) {
	f, m := staleTagIDsFixture(t)
	f.put(t, KeyTagIDs, 13, map[string]any{"imageId": 13, "tags": []any{88}, "cachedAt": pageNow.Add(-9 * time.Hour)})
	s, r := m.load(f, &MissCompute{WriteBack: AllWrites(), FrameNegative: true})
	before, _ := r.String(pageNS + missKey(KeyTagIDs, 13))
	got, err := s.TagIDs(context.Background(), []int{13})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got[13]; ok {
		t.Fatalf("13 = %v, want no tags (no row now)", got[13])
	}
	if after, _ := r.String(pageNS + missKey(KeyTagIDs, 13)); string(after) != string(before) {
		t.Fatal("a notFound marker replaced a stale value")
	}
}

// The probe's presence check counts a stale tag-ids entry as a miss with the computation on (a serve
// looks it up again), and as an answer without it (a serve then serves it).
func TestPresenceStaleTagIDs(t *testing.T) {
	for _, tc := range []struct {
		compute *MissCompute
		want    int
	}{{nil, 0}, {&MissCompute{}, 1}} {
		f, _ := staleTagIDsFixture(t)
		s, _, _ := f.load()
		s.Compute = tc.compute
		got, err := s.Presence(context.Background(), PageRequest{ImageIDs: []int{11, 12}})
		if err != nil {
			t.Fatal(err)
		}
		if got[CacheTagIDs] != tc.want {
			t.Errorf("compute %v: tag-ids missed %d, want %d", tc.compute != nil, got[CacheTagIDs], tc.want)
		}
	}
}
