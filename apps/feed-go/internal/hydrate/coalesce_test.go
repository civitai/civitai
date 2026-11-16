package hydrate

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
)

// countingLookup is a lookup that counts its calls, answers id 1 with a record and every other id with
// no row, and (when gate is set) holds every call until gate returns.
type countingLookup struct {
	calls atomic.Int32
	gate  func()
}

func (l *countingLookup) lookup(_ context.Context, ids []int) (map[int]jspack.Obj, error) {
	l.calls.Add(1)
	if l.gate != nil {
		l.gate()
	}
	out := map[int]jspack.Obj{}
	for _, id := range ids {
		if id == 1 {
			out[id] = jspack.O("id", 1)
		}
	}
	return out, nil
}

// Concurrent misses of one cache and id set (in any order) share one lookup, with write-back on too,
// where nothing is kept between requests: the coalescing alone answers them.
func TestConcurrentLookupsShareOne(t *testing.T) {
	const n = 8
	c := &MissCompute{WriteBack: true}
	var entered atomic.Int32
	c.beforeFlight = func() { entered.Add(1) }
	l := &countingLookup{gate: func() {
		// Every caller has reached the flight before the first lookup returns.
		for entered.Load() < n {
			time.Sleep(time.Millisecond)
		}
		time.Sleep(200 * time.Millisecond)
	}}
	var wg sync.WaitGroup
	results := make([]map[int]jspack.Obj, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		ids := []int{1, 2}
		if i%2 == 1 {
			ids = []int{2, 1}
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = c.lookupShared(context.Background(), MissImageFrames, ids, l.lookup)
		}()
	}
	wg.Wait()
	if got := l.calls.Load(); got != 1 {
		t.Fatalf("%d lookups for %d concurrent callers, want 1", got, n)
	}
	for i := 0; i < n; i++ {
		if errs[i] != nil || !reflect.DeepEqual(results[i], map[int]jspack.Obj{1: jspack.O("id", 1)}) {
			t.Fatalf("caller %d: %v, %v", i, results[i], errs[i])
		}
	}
	// Another cache with the same ids is another flight.
	if _, err := c.lookupShared(context.Background(), MissEventDecorations, []int{1, 2}, (&countingLookup{}).lookup); err != nil {
		t.Fatal(err)
	}
}

// With write-back off an answer (a record or "no row") is kept for 10 s: a repeat miss inside that
// window sends no query, one at its end does. With write-back on nothing is kept.
func TestRecentLookupsExpire(t *testing.T) {
	now := pageNow
	for _, writeBack := range []bool{false, true} {
		c := &MissCompute{WriteBack: writeBack, Now: func() time.Time { return now }}
		l := &countingLookup{}
		ctx := context.Background()
		now = pageNow
		first, err := c.lookupShared(ctx, MissUserCosmetics, []int{1, 2}, l.lookup)
		if err != nil {
			t.Fatal(err)
		}
		now = pageNow.Add(9 * time.Second)
		again, err := c.lookupShared(ctx, MissUserCosmetics, []int{2, 1}, l.lookup)
		if err != nil {
			t.Fatal(err)
		}
		want := map[int]jspack.Obj{1: jspack.O("id", 1)}
		if !reflect.DeepEqual(first, want) || !reflect.DeepEqual(again, want) {
			t.Fatalf("write-back %v: answers %v then %v, want %v", writeBack, first, again, want)
		}
		wantCalls := map[bool]int32{false: 1, true: 2}[writeBack]
		if got := l.calls.Load(); got != wantCalls {
			t.Fatalf("write-back %v: %d lookups within the window, want %d", writeBack, got, wantCalls)
		}
		now = pageNow.Add(10 * time.Second)
		if _, err := c.lookupShared(ctx, MissUserCosmetics, []int{1, 2}, l.lookup); err != nil {
			t.Fatal(err)
		}
		if got := l.calls.Load(); got != wantCalls+1 {
			t.Fatalf("write-back %v: %d lookups after the window, want %d", writeBack, got, wantCalls+1)
		}
		// A kept answer is per cache: another cache's miss of the same id is looked up.
		before := l.calls.Load()
		if _, err := c.lookupShared(ctx, MissImageFrames, []int{1}, l.lookup); err != nil || l.calls.Load() != before+1 {
			t.Fatalf("write-back %v: another cache's miss was answered from this one (%v)", writeBack, err)
		}
	}
}

// A failed lookup is not kept: the next miss queries again.
func TestRecentLookupsKeepNoFailure(t *testing.T) {
	c := &MissCompute{Now: func() time.Time { return pageNow }}
	calls := 0
	failing := func(context.Context, []int) (map[int]jspack.Obj, error) {
		calls++
		return nil, errMissDB
	}
	for i := 0; i < 2; i++ {
		if _, err := c.lookupShared(context.Background(), MissImageFrames, []int{1}, failing); !errors.Is(err, errMissDB) {
			t.Fatalf("err %v", err)
		}
	}
	if calls != 2 {
		t.Fatalf("%d lookups, want 2 (a failure is not kept)", calls)
	}
}

// The kept answers are bounded: at recentMax an answer that does not fit is not kept until entries
// expire.
func TestRecentLookupsBounded(t *testing.T) {
	now := pageNow
	c := &MissCompute{Now: func() time.Time { return now }}
	ids := make([]int, recentMax)
	for i := range ids {
		ids[i] = i + 10
	}
	c.remember(MissImageFrames, ids, nil)
	c.remember(MissImageFrames, []int{1}, nil)
	if todo := c.fromRecent(MissImageFrames, []int{1, 10}, map[int]jspack.Obj{}); !reflect.DeepEqual(todo, []int{1}) {
		t.Fatalf("todo %v, want [1] (kept: 10; over the bound: 1)", todo)
	}
	now = pageNow.Add(recentTTL)
	c.remember(MissImageFrames, []int{1}, nil)
	if todo := c.fromRecent(MissImageFrames, []int{1}, map[int]jspack.Obj{}); len(todo) != 0 {
		t.Fatalf("todo %v: after the others expired, 1 should be kept", todo)
	}
	if n := len(c.recent); n != 1 {
		t.Fatalf("%d entries kept, want 1 (the expired ones dropped)", n)
	}
}

// Through Page: N concurrent requests for the same cold user send ONE UserCosmetic query (and one
// withheld check), and the same answer.
func TestPageConcurrentMissesOneQuery(t *testing.T) {
	const n = 8
	f := basePageFixture(t)
	f.del(KeyUserCosmetics, 1002)
	m := userCosmeticsMissDB()
	s, _ := m.load(f, &MissCompute{FrameNegative: true})
	var wg sync.WaitGroup
	pages := make([]*Page, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pages[i], errs[i] = s.Page(context.Background(), pageRequest())
		}()
	}
	wg.Wait()
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("request %d: %v (fallback %q)", i, errs[i], fallback.Reason(errs[i]))
		}
		if s, want := pagePlain(t, pages[i].UserCosmetics[1002]), pagePlain(t, pages[0].UserCosmetics[1002]); s != want || len(pages[i].UserCosmetics[1002]) != 1 {
			t.Fatalf("request %d: user 1002 cosmetics %s, want %s", i, s, want)
		}
	}
	if q, l := m.queries("users"), m.queries("listings"); len(q) != 1 || len(l) != 1 {
		t.Fatalf("UserCosmetic queries %v, listing queries %v: want one each for %d requests", q, l, n)
	}
}

// A full map of live entries is swept at most once per second, however many answers arrive: each
// sweep scans every entry under the lock and frees nothing. New ids are not kept meanwhile; once the
// entries expire, the next sweep frees them and inserts resume.
func TestRecentSweepRateLimited(t *testing.T) {
	now := pageNow
	c := &MissCompute{Now: func() time.Time { return now }}
	ids := make([]int, recentMax)
	for i := range ids {
		ids[i] = i + 10
	}
	c.remember(MissImageFrames, ids, nil) // fits exactly: no sweep
	if c.sweeps != 0 {
		t.Fatalf("%d sweeps filling the map, want 0", c.sweeps)
	}
	for i := 0; i < 100; i++ {
		now = pageNow.Add(time.Duration(i) * 9 * time.Millisecond) // 100 calls within 0.9 s
		c.remember(MissImageFrames, []int{1_000_000 + i}, nil)
	}
	if c.sweeps != 1 {
		t.Fatalf("%d sweeps for 100 answers within a second of a full live map, want 1", c.sweeps)
	}
	if n := len(c.recent); n != recentMax {
		t.Fatalf("%d entries, want %d (no new id kept while full)", n, recentMax)
	}
	if todo := c.fromRecent(MissImageFrames, []int{1_000_000}, map[int]jspack.Obj{}); len(todo) != 1 {
		t.Fatal("an id was kept over the bound")
	}

	// Past the TTL every entry has expired: the next answer sweeps (a second later than the last) and
	// is kept.
	now = pageNow.Add(recentTTL)
	c.remember(MissImageFrames, []int{1}, nil)
	if c.sweeps != 2 {
		t.Fatalf("%d sweeps, want 2", c.sweeps)
	}
	if todo := c.fromRecent(MissImageFrames, []int{1}, map[int]jspack.Obj{}); len(todo) != 0 || len(c.recent) != 1 {
		t.Fatalf("after expiry: todo %v, %d entries; want 1 kept alone", todo, len(c.recent))
	}
}
