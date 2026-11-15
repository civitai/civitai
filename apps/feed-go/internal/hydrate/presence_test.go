package hydrate

import (
	"context"
	"errors"
	"reflect"
	"sort"
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
func TestPageCachesReasonsMatchPage(t *testing.T) {
	if len(PageCaches) != 9 {
		t.Fatalf("%d caches in PageCaches; this test enumerates 9 (add the new one's ids to fixtureIDs)", len(PageCaches))
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
			_, err := s.Page(context.Background(), pageRequest())
			if c.Reason == "" {
				if err != nil {
					t.Fatalf("Page: %v, want the page answered (the replica fills %s)", err, c.Name)
				}
			} else if got := fallback.Reason(err); got != c.Reason {
				t.Fatalf("Page fell back with %q (%v), want %q", got, err, c.Reason)
			}

			s, _, _ = f.load()
			misses, err := s.Presence(context.Background(), pageRequest())
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

// fakeChecker answers each Presence call with the next of its answers.
type fakeChecker struct {
	mu      sync.Mutex
	answers []map[string]int
	err     error
	reqs    []PageRequest
}

func (f *fakeChecker) Presence(_ context.Context, req PageRequest) (map[string]int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, req)
	if f.err != nil {
		return nil, f.err
	}
	a := f.answers[0]
	f.answers = f.answers[1:]
	return a, nil
}

func TestPresenceProbe(t *testing.T) {
	ctx := context.Background()
	t0 := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	clock := t0
	fc := &fakeChecker{answers: []map[string]int{{CacheTagIDs: 2}, {}, {CacheTagIDs: 1, CacheMetrics: 3}}}
	p := &PresenceProbe{Checker: fc, Now: func() time.Time { c := clock; clock = clock.Add(time.Second); return c }}

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
	if got, want := p.Misses(), map[string]int{CacheTagIDs: 3, CacheMetrics: 3}; !reflect.DeepEqual(got, want) {
		t.Fatalf("misses %v, want %v", got, want)
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
