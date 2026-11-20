package hydrate

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// recordKeys makes r record every key a command touches (KeyErr is consulted once per key).
func recordKeys(r *testkit.Redis) func() []string {
	var mu sync.Mutex
	seen := map[string]bool{}
	r.KeyErr = func(key string) error {
		mu.Lock()
		seen[key] = true
		mu.Unlock()
		return nil
	}
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := make([]string, 0, len(seen))
		for k := range seen {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
}

// basePageFixture's misses, read from its doc comment: basic user 1002 (a debounce marker), profile
// picture 1002, thumbnail 14, and cosmetics 502, 505 and 509 (named by present entries, not cached).
// Every other cache answers every id (a notFound marker and a stale entry are answers).
func TestPresenceCountsTheMissesPageWouldSee(t *testing.T) {
	s, r, db := basePageFixture(t).load()
	got, err := s.Presence(context.Background(), pageRequest())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{CacheBasicUsers: 1, CacheProfilePictures: 1, CacheThumbnails: 1, CacheCosmetics: 3}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("misses %v, want %v", got, want)
	}
	// Read-only, and nothing but the cache: two pipelines (stage 1, stage 2), no replica query.
	if r.Calls != 2 {
		t.Errorf("%d round trips, want 2", r.Calls)
	}
	if n := len(db.Calls); n != 0 {
		t.Errorf("%d replica queries, want none: %v", n, db.Calls)
	}
}

// The seam the probe stands on: the keys Presence reads are exactly the keys Page reads for the same
// request — so a cache Page starts to read and the probe does not check (or one it checks that Page
// no longer reads) fails here.
func TestPresenceReadsTheKeysPageReads(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  PageRequest
	}{
		{"every lookup", pageRequest()},
		{"no visible event", func() PageRequest { r := pageRequest(); r.VisibleEvents = nil; return r }()},
		{"no video", func() PageRequest { r := pageRequest(); r.VideoIDs = nil; return r }()},
		{"no profile pictures (image.getInfinite)", func() PageRequest { r := pageRequest(); r.NoProfilePictures = true; return r }()},
		{"include tags (image.getInfinite)", tagsPageRequest()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r, _ := basePageFixture(t).load()
			pageKeys := recordKeys(r)
			if _, err := s.Page(context.Background(), tc.req); err != nil {
				t.Fatal(err)
			}
			want := pageKeys()

			s, r, _ = basePageFixture(t).load()
			presenceKeys := recordKeys(r)
			if _, err := s.Presence(context.Background(), tc.req); err != nil {
				t.Fatal(err)
			}
			got := presenceKeys()
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("Presence read\n  %v\nPage read\n  %v", got, want)
			}
			// Positive control: the ledger saw every stage (a metric hash and a stage-2 cosmetic).
			joined := strings.Join(want, " ")
			for _, k := range []string{"metrics:Image:11", pageNS + KeyCosmetics + ":501"} {
				if !strings.Contains(joined, k) {
					t.Fatalf("the ledger never saw %s: %v", k, want)
				}
			}
			if tagsKey := pageNS + KeyImageTags + ":11"; strings.Contains(joined, tagsKey) != tc.req.Tags {
				t.Fatalf("image tags read %v with Tags %v: %v", strings.Contains(joined, tagsKey), tc.req.Tags, want)
			}
		})
	}
}

// fixtureIDs are the ids each cache is read for in basePageFixture's request.
func fixtureIDs(name string) []int {
	switch name {
	case CacheBasicUsers, CacheUserCosmetics, CacheProfilePictures:
		return []int{1001, 1002, 1003}
	case CacheThumbnails:
		return []int{13, 14}
	case CacheCosmetics:
		// The two cached records a frame does not join: emptying 504 would leave frame 11 with a
		// cosmetic that exists nowhere (image-frame-cosmetic-missing), which is not a cache miss.
		return []int{501, 503}
	default:
		return []int{11, 12, 13, 14}
	}
}

// Each PageCaches row against Page itself: with that cache emptied, Page falls back with the row's
// Reason, or (no Reason) answers the page — and Presence reports the cache, with every id missing.
// The request carries the 'tags' include, so every cache (the image tags included) is read.
func TestPageCachesReasonsMatchPage(t *testing.T) {
	if len(PageCaches) != 10 {
		t.Fatalf("%d caches in PageCaches; this test enumerates 10 (add the new one's ids to fixtureIDs)", len(PageCaches))
	}
	for _, c := range PageCaches {
		t.Run(c.Name, func(t *testing.T) {
			f := basePageFixture(t)
			for _, id := range fixtureIDs(c.Name) {
				if c.Name == CacheMetrics {
					delete(f.hashes, metricHashKey(id))
					continue
				}
				f.del(c.Key, id)
			}
			s, _, _ := f.load()
			_, err := s.Page(context.Background(), tagsPageRequest())
			if c.Reason == "" {
				if err != nil {
					t.Fatalf("Page: %v, want the page answered (the replica fills %s)", err, c.Name)
				}
			} else if got := fallback.Reason(err); got != c.Reason {
				t.Fatalf("Page fell back with %q (%v), want %q", got, err, c.Reason)
			}

			s, _, _ = f.load()
			misses, err := s.Presence(context.Background(), tagsPageRequest())
			if err != nil {
				t.Fatal(err)
			}
			want := len(fixtureIDs(c.Name))
			if c.Name == CacheCosmetics {
				// 502, 505 and 509 are absent in the fixture already.
				want += 3
			}
			if misses[c.Name] != want {
				t.Fatalf("Presence: %s missed %d ids, want %d (%v)", c.Name, misses[c.Name], want, misses)
			}
		})
	}
}

func TestPresenceMarkers(t *testing.T) {
	ctx := context.Background()
	t.Run("a debounce marker is a miss, a notFound marker and a stale entry are not", func(t *testing.T) {
		f := basePageFixture(t)
		f.put(t, KeyTagIDs, 11, map[string]any{"debounce": true})
		s, _, _ := f.load()
		got, err := s.Presence(ctx, PageRequest{ImageIDs: []int{11, 12}})
		if err != nil {
			t.Fatal(err)
		}
		// 12's tag ids are a notFound marker; 11 is now debounced. No users: none of their caches.
		if got[CacheTagIDs] != 1 {
			t.Fatalf("tag-ids missed %d, want 1 (%v)", got[CacheTagIDs], got)
		}
		if _, ok := got[CacheBasicUsers]; ok {
			t.Fatalf("no user ids, but basic-users reported: %v", got)
		}
	})
	t.Run("an undecodable value is a miss", func(t *testing.T) {
		f := basePageFixture(t)
		f.strings[pageNS+KeyImageFrames+":11"] = []byte{0xc1}
		s, _, _ := f.load()
		got, err := s.Presence(ctx, PageRequest{ImageIDs: []int{11}})
		if err != nil {
			t.Fatal(err)
		}
		if got[CacheImageFrames] != 1 {
			t.Fatalf("image-frames missed %d, want 1 (%v)", got[CacheImageFrames], got)
		}
	})
	t.Run("a metric hash is present by EXISTS, a notFound hash included", func(t *testing.T) {
		f := basePageFixture(t)
		delete(f.hashes, "metrics:Image:13")
		s, _, _ := f.load()
		got, err := s.Presence(ctx, PageRequest{ImageIDs: []int{11, 12, 13}})
		if err != nil {
			t.Fatal(err)
		}
		if got[CacheMetrics] != 1 {
			t.Fatalf("metrics missed %d, want 1 (13 only; 12 is a notFound hash): %v", got[CacheMetrics], got)
		}
	})
	t.Run("nothing to read", func(t *testing.T) {
		s, r, _ := basePageFixture(t).load()
		got, err := s.Presence(ctx, PageRequest{})
		if err != nil || len(got) != 0 {
			t.Fatalf("misses %v, err %v; want none", got, err)
		}
		if r.Calls != 0 {
			t.Fatalf("%d round trips for an empty page, want 0", r.Calls)
		}
	})
}

func TestPresenceReadFailures(t *testing.T) {
	for _, tc := range []struct{ name, key string }{
		{"a packed key", pageNS + KeyTagIDs + ":12"},
		{"a metric hash", "metrics:Image:12"},
		{"a stage-2 cosmetic", pageNS + KeyCosmetics + ":504"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r, _ := basePageFixture(t).load()
			r.KeyErr = func(key string) error {
				if key == tc.key {
					return testkit.ErrDown
				}
				return nil
			}
			_, err := s.Presence(context.Background(), pageRequest())
			if !errors.Is(err, testkit.ErrDown) {
				t.Fatalf("err = %v, want the read failure (a miss it cannot tell)", err)
			}
		})
	}
}

// MissReason is the table's Reason without a miss computation, and "" for the caches it answers
// (MissCaches, the computation's own list) with one; the caches it does not answer keep theirs. The
// model frames and decorations are not page caches: their reasons are the computation's own.
func TestMissReason(t *testing.T) {
	plain, computed := &Sources{}, &Sources{Compute: &MissCompute{}}
	r := testkit.NewRedis()
	withCH := &Sources{Cache: r, Compute: &MissCompute{ClickHouse: &fakeCH{}}}
	for _, c := range PageCaches {
		if got := plain.MissReason(c.Name); got != c.Reason {
			t.Errorf("no computation: %s = %q, want %q", c.Name, got, c.Reason)
		}
	}
	// Not page caches: the model frames', decorations' and version showcases' reasons are their lookup
	// specs'; the image meta (not probed) has no spec, so none.
	for name, w := range map[string]string{MissModelFrames: "model-frame-miss", MissModelDecorations: "model-decoration-miss",
		MissVersionImages: "model-images-miss", MissImageMeta: "", "model-data": "model-data-miss", "model-tags": "model-tags-miss",
		"official-models": "official-models-miss"} {
		if got := plain.MissReason(name); got != w {
			t.Errorf("no computation: %s = %q, want %q", name, got, w)
		}
	}
	want := map[string]string{
		CacheUserCosmetics: "", CacheImageFrames: "", CacheEventDecorations: "",
		CacheTagIDs: "", MissModelFrames: "", MissModelDecorations: "", MissVersionImages: "", CacheMetrics: "metrics-miss", CacheBasicUsers: "",
		"model-data": "", "model-tags": "", "official-models": "", CacheImageTags: "",
	}
	for name, w := range want {
		if got := computed.MissReason(name); got != w {
			t.Errorf("computed: %s = %q, want %q", name, got, w)
		}
	}
	// The metric hashes are computed only with a ClickHouse reader (and the cache it reads them from).
	if got := withCH.MissReason(CacheMetrics); got != "" {
		t.Errorf("with a ClickHouse reader: metrics = %q, want \"\"", got)
	}
	if got := (&Sources{Compute: &MissCompute{ClickHouse: &fakeCH{}}}).MissReason(CacheMetrics); got != "metrics-miss" {
		t.Errorf("a reader but no cache client: metrics = %q, want metrics-miss", got)
	}
	if got := (&Sources{Cache: r, Compute: &MissCompute{}}).MissReason(CacheMetrics); got != "metrics-miss" {
		t.Errorf("no reader: metrics = %q, want metrics-miss", got)
	}
	if got := withCH.MissReason(CacheTagIDs); got != "" {
		t.Errorf("with a ClickHouse reader: tag-ids = %q, want \"\"", got)
	}
	for _, s := range []*Sources{plain, computed, withCH} {
		if s.MissReason("nope") != "" {
			t.Error("an unknown cache has a reason")
		}
	}
}

// With misses computed and frame-cache-negative off, a frame notFound marker is a miss (fillFrames
// looks it up); with the flag on, or without a computation, it is an answer.
func TestPresenceFrameMarkersFollowFrameNegative(t *testing.T) {
	for _, tc := range []struct {
		compute *MissCompute
		want    int
	}{{nil, 0}, {&MissCompute{FrameNegative: true}, 0}, {&MissCompute{}, 2}} {
		s, _, _ := basePageFixture(t).load()
		s.Compute = tc.compute
		got, err := s.Presence(context.Background(), pageRequest())
		if err != nil {
			t.Fatal(err)
		}
		// basePageFixture: frames 13 and 14 are notFound markers.
		if got[CacheImageFrames] != tc.want {
			t.Errorf("compute %+v: image-frames missed %d, want %d", tc.compute, got[CacheImageFrames], tc.want)
		}
	}
}

// Raced: a present entry filled at or after the threshold (a packed entry's cachedAt, a metric
// hash's _populatedAt) is counted as raced as well as present; older, unstamped or with no threshold,
// it is not. basePageFixture stamps basic user 1001 and cosmetic 501 at pageNow, user 1003, cosmetic
// 503 and thumbnail 13 thirty days earlier, and metric hashes 12 and 14 in 2023.
func TestCheckRaced(t *testing.T) {
	ctx := context.Background()
	f := basePageFixture(t)
	f.hashes["metrics:Image:11"] = map[string]string{"Like": "3", "_populatedAt": strconv.FormatInt(pageNow.UnixMilli(), 10)}
	s, _, _ := f.load()
	got, err := s.Check(ctx, pageRequest(), pageNow.Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{CacheBasicUsers: 1, CacheCosmetics: 1, CacheMetrics: 1}
	if !reflect.DeepEqual(got.Raced, want) {
		t.Fatalf("raced %v, want %v", got.Raced, want)
	}
	// Raced entries are still present: the misses are Presence's.
	if want := map[string]int{CacheBasicUsers: 1, CacheProfilePictures: 1, CacheThumbnails: 1, CacheCosmetics: 3}; !reflect.DeepEqual(got.Misses, want) {
		t.Fatalf("misses %v, want %v", got.Misses, want)
	}
	// A threshold after every stamp, and no threshold: nothing raced.
	for _, since := range []time.Time{pageNow.Add(time.Second), {}} {
		got, err := s.Check(ctx, pageRequest(), since)
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Raced) != 0 {
			t.Fatalf("threshold %v: raced %v, want none", since, got.Raced)
		}
	}
	// The boundary: a stamp exactly at the threshold is raced (cachedAt >= since).
	got, err = s.Check(ctx, PageRequest{UserIDs: []int{1001}}, pageNow)
	if err != nil {
		t.Fatal(err)
	}
	if got.Raced[CacheBasicUsers] != 1 {
		t.Fatalf("stamp == threshold: raced %v, want basic-users 1", got.Raced)
	}
}

func TestMetricHashPrefix(t *testing.T) {
	if got, want := metricHashKey(8001), metricHashPrefix+":8001"; got != want {
		t.Fatalf("metricHashKey = %q, PageCaches says %q", got, want)
	}
	c, ok := PageCacheNamed(CacheMetrics)
	if !ok || c.Key != metricHashPrefix {
		t.Fatalf("PageCacheNamed(metrics) = %+v, %v", c, ok)
	}
	if _, ok := PageCacheNamed("nope"); ok {
		t.Fatal("PageCacheNamed(nope) found a cache")
	}
}

// fakeChecker answers each Check with the next of its answers (misses; raced, when given). Every
// cache but tag ids is one Go answers itself.
type fakeChecker struct {
	mu      sync.Mutex
	answers []map[string]int
	raced   []map[string]int
	err     error
	reqs    []PageRequest
	since   []time.Time
}

func (f *fakeChecker) MissReason(name string) string {
	if name == CacheTagIDs {
		return "tag-ids-miss"
	}
	return ""
}

func (f *fakeChecker) Check(_ context.Context, req PageRequest, racedSince time.Time) (PresenceResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, req)
	f.since = append(f.since, racedSince)
	if f.err != nil {
		return PresenceResult{}, f.err
	}
	r := PresenceResult{Misses: f.answers[0]}
	f.answers = f.answers[1:]
	if len(f.raced) > 0 {
		r.Raced = f.raced[0]
		f.raced = f.raced[1:]
	}
	return r, nil
}

func TestPresenceProbe(t *testing.T) {
	ctx := context.Background()
	t0 := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	clock := t0
	fc := &fakeChecker{
		answers: []map[string]int{{CacheTagIDs: 2, CacheBasicUsers: 1}, {}, {CacheTagIDs: 1, CacheMetrics: 3, CacheBasicUsers: 4}},
		raced:   []map[string]int{{CacheCosmetics: 1}, nil, {CacheCosmetics: 2, CacheBasicUsers: 1}},
	}
	since := t0.Add(-time.Minute)
	p := &PresenceProbe{Checker: fc, RacedSince: since, Now: func() time.Time { c := clock; clock = clock.Add(time.Second); return c }}

	if first, n := p.FirstCheck(); !first.IsZero() || n != 0 {
		t.Fatalf("before any page: %v, %d", first, n)
	}
	for i := 0; i < 3; i++ {
		page, err := p.Page(ctx, PageRequest{ImageIDs: []int{i + 1}})
		if err != nil {
			t.Fatal(err)
		}
		// An empty hydration: nothing was hydrated.
		if !reflect.DeepEqual(page, &Page{}) {
			t.Fatalf("page %d = %+v, want an empty hydration", i, page)
		}
	}
	if got, want := p.Misses(), map[string]int{CacheTagIDs: 3, CacheMetrics: 3, CacheBasicUsers: 5}; !reflect.DeepEqual(got, want) {
		t.Fatalf("misses %v, want %v", got, want)
	}
	if got, want := p.Raced(), map[string]int{CacheCosmetics: 3, CacheBasicUsers: 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("raced %v, want %v", got, want)
	}
	// One database read per page and cache Go answers itself with a missed or raced entry (tag ids
	// fall back, so no read): basic users on pages 1 and 3 (page 3 both missed and raced: once),
	// metrics on page 3, cosmetics (raced) on pages 1 and 3.
	if got, want := p.DBReads(), map[string]int{CacheBasicUsers: 2, CacheMetrics: 1, CacheCosmetics: 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("db reads %v, want %v", got, want)
	}
	for i, got := range fc.since {
		if !got.Equal(since) {
			t.Fatalf("check %d got race threshold %v, want %v", i, got, since)
		}
	}
	if first, n := p.FirstCheck(); !first.Equal(t0) || n != 3 {
		t.Fatalf("first check %v after %d pages, want %v after 3", first, n, t0)
	}
	if len(fc.reqs) != 3 || fc.reqs[2].ImageIDs[0] != 3 {
		t.Fatalf("the checker saw %v", fc.reqs)
	}
	vis, err := p.VisibleModel3DIDs(ctx, []int{1}, 0, false)
	if err != nil || len(vis) != 0 {
		t.Fatalf("VisibleModel3DIDs = %v, %v; want none visible", vis, err)
	}

	fc.err = testkit.ErrDown
	if _, err := p.Page(ctx, PageRequest{}); !errors.Is(err, testkit.ErrDown) {
		t.Fatalf("err = %v, want the checker's", err)
	}
	// Misses is a copy.
	m := p.Misses()
	m[CacheTagIDs] = 99
	if p.Misses()[CacheTagIDs] != 3 {
		t.Fatal("Misses returned the probe's own map")
	}
	r := p.Raced()
	r[CacheCosmetics] = 99
	if p.Raced()[CacheCosmetics] != 3 {
		t.Fatal("Raced returned the probe's own map")
	}
}

// A raced entry on a cache Go answers itself costs the lookup a Go-first serve would have made for it
// had it been missing: one database read per page and such cache, as a cold miss there does, and a
// page whose cache both missed and raced counts that read once. A race on a cache Go falls back on
// (tag ids, for fakeChecker) costs no read.
func TestPresenceProbeCountsRacedReads(t *testing.T) {
	fc := &fakeChecker{
		answers: []map[string]int{
			{},                    // page 1: raced only
			{CacheImageFrames: 1}, // page 2: missed and raced
			{},                    // page 3: raced on a fallback cache
			{CacheTagIDs: 1},      // page 4: a fallback miss, a race on a cache Go answers
		},
		raced: []map[string]int{
			{CacheImageFrames: 3},
			{CacheImageFrames: 2},
			{CacheTagIDs: 1},
			{CacheBasicUsers: 1},
		},
	}
	p := &PresenceProbe{Checker: fc, RacedSince: time.Now().Add(-time.Minute)}
	for i := 0; i < 4; i++ {
		if _, err := p.Page(context.Background(), PageRequest{ImageIDs: []int{i + 1}}); err != nil {
			t.Fatal(err)
		}
	}
	if got, want := p.DBReads(), map[string]int{CacheImageFrames: 2, CacheBasicUsers: 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("db reads %v, want %v", got, want)
	}
	// The race counts themselves are unchanged: every raced entry, whatever its cache.
	if got, want := p.Raced(), map[string]int{CacheImageFrames: 5, CacheTagIDs: 1, CacheBasicUsers: 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("raced %v, want %v", got, want)
	}
	if got, want := p.Misses(), map[string]int{CacheImageFrames: 1, CacheTagIDs: 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("misses %v, want %v", got, want)
	}
}

func TestPresenceProbeDefaultClock(t *testing.T) {
	p := &PresenceProbe{Checker: &fakeChecker{answers: []map[string]int{nil}}}
	before := time.Now()
	if _, err := p.Page(context.Background(), PageRequest{}); err != nil {
		t.Fatal(err)
	}
	if first, _ := p.FirstCheck(); first.Before(before) {
		t.Fatalf("first check %v before %v", first, before)
	}
	if len(p.Misses()) != 0 {
		t.Fatalf("misses %v from a nil answer", p.Misses())
	}
}
