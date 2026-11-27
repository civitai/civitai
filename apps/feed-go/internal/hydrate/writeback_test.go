package hydrate

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// writeSet is the write-back set of a test that turns write-back on or off as a whole: every cache,
// or none.
func writeSet(on bool) WriteSet {
	if on {
		return AllWrites()
	}
	return nil
}

// writeLines is a WriteLog over a JSON buffer, and its parsed lines.
type writeLines struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *writeLines) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *writeLines) log(perMinute int, now func() time.Time) *WriteLog {
	return &WriteLog{Log: slog.New(slog.NewJSONHandler(w, nil)), PerMinute: perMinute, Now: now}
}

func (w *writeLines) raw() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// lines are the logged lines, each without its time and level.
func (w *writeLines) lines(t *testing.T) []map[string]any {
	t.Helper()
	raw := strings.Split(strings.TrimSpace(w.raw()), "\n")
	out := make([]map[string]any, 0, len(raw))
	for _, l := range raw {
		if l == "" {
			continue
		}
		m := map[string]any{}
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("line %q: %v", l, err)
		}
		delete(m, "time")
		delete(m, "level")
		out = append(out, m)
	}
	return out
}

// Every WriteCaches name is a computed cache's label (MissCaches), so the write counter and the miss
// counter name a cache alike; the image meta (never written) is not one, and every PrimaryCaches
// name is a WriteCaches name. Invariant guard: fails if a name is added to WriteCaches that is not a
// cache label, or the image meta is made writable.
func TestWriteCachesAreMissLabels(t *testing.T) {
	for _, c := range WriteCaches {
		found := false
		for _, m := range MissCaches {
			found = found || m == c
		}
		if !found || c == MissImageMeta {
			t.Errorf("write cache %q is not a written miss label", c)
		}
	}
	all := AllWrites()
	for _, c := range PrimaryCaches {
		if !all[c] {
			t.Errorf("primary cache %q is not a write cache", c)
		}
	}
	if len(all) != 13 || !all.NeedsPrimary() || (WriteSet{MissMetrics: true, MissTagIDs: true}).NeedsPrimary() || (WriteSet{}).Any() {
		t.Fatalf("AllWrites %v, or NeedsPrimary/Any wrong", all.Names())
	}
}

// Per cache: a page with a user-cosmetics miss and a frame miss writes back only the caches listed.
// Listing user-cosmetics writes the user's entry and never the frame's; listing image-frames the
// reverse. Fails on: gating fill on "any cache listed" (both written in each case) or on nothing (the
// listed one not written).
func TestWriteBackOnlyListedCaches(t *testing.T) {
	ucKey, frameKey := pageNS+missKey(KeyUserCosmetics, 1002), pageNS+missKey(KeyImageFrames, 13)
	for _, c := range []struct {
		name           string
		set            WriteSet
		written, never string
	}{
		{"user-cosmetics", WriteSet{MissUserCosmetics: true}, ucKey, frameKey},
		{"image-frames", WriteSet{MissImageFrames: true}, frameKey, ucKey},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := basePageFixture(t)
			f.del(KeyUserCosmetics, 1002)
			f.del(KeyImageFrames, 13)
			m := userCosmeticsMissDB()
			m.frames = map[int][][]any{13: {{int64(504), int64(13), `{"lights": 5}`, nil}}}
			obs := &observed{}
			s, r := m.load(f, &MissCompute{WriteBack: c.set, FrameNegative: true, ObserveWrite: obs.observe})
			got, err := s.Page(context.Background(), pageRequest())
			if err != nil {
				t.Fatalf("Page: %v (fallback %q)", err, fallback.Reason(err))
			}
			if len(got.UserCosmetics[1002]) != 1 || got.Frames[13] == nil {
				t.Fatalf("user 1002 %v, frame 13 %v: want both computed whatever is written", got.UserCosmetics[1002], got.Frames[13])
			}
			if !r.Has(c.written) {
				t.Fatalf("%s not written with %s listed", c.written, c.name)
			}
			wantAbsent(t, r, c.never)
			if o := obs.get(); o[c.name+"/written"] != 1 || len(o) != 1 {
				t.Fatalf("writes observed %v, want exactly one %s write", o, c.name)
			}
		})
	}
}

// Per cache, the database: a written-back frame lookup reads the primary while the decoration
// lookup, not written back, reads the replica (and the reverse). Fails on: entityDB deciding on "any
// cache listed" (both on the primary) or ignoring the list (both on the replica).
func TestWriteBackReadsPrimaryPerCache(t *testing.T) {
	build := func(set WriteSet) (*Sources, *missDB, *missDB) {
		f := basePageFixture(t)
		f.del(KeyImageFrames, 13)
		f.del(KeyImageEvents, 12)
		f.strings[pageNS+missKey(KeyCosmetics, 602)] = jspack.Pack(jspack.O("id", 602, "name", "deco2", "type", "ContentDecoration",
			"data", jspack.O("event", "ev", "url", "x.png"), "source", "Event", "cachedAt", pageNow))
		rows := func() *missDB {
			m := eventsMissDB()
			m.frames = map[int][][]any{13: {{int64(504), int64(13), nil, nil}}}
			return m
		}
		primary, replica := rows(), rows()
		pdb := &testkit.DB{}
		ps, _ := primary.load(basePageFixture(t), &MissCompute{})
		pdb.Routes = ps.Replica.(*pageReplica).Routes
		s, _ := replica.load(f, &MissCompute{WriteBack: set, FrameNegative: true, Primary: pdb})
		return s, primary, replica
	}
	for _, c := range []struct {
		cache     string
		onPrimary string
		onReplica string
		set       WriteSet
	}{
		{MissImageFrames, "frames", "events", WriteSet{MissImageFrames: true}},
		{MissEventDecorations, "events", "frames", WriteSet{MissEventDecorations: true}},
	} {
		t.Run(c.cache, func(t *testing.T) {
			s, primary, replica := build(c.set)
			if _, err := s.Page(context.Background(), pageRequest()); err != nil {
				t.Fatalf("Page: %v (fallback %q)", err, fallback.Reason(err))
			}
			if len(primary.queries(c.onPrimary)) != 1 || len(replica.queries(c.onPrimary)) != 0 {
				t.Errorf("%s: %d on the primary, %d on the replica; want 1 and 0", c.onPrimary,
					len(primary.queries(c.onPrimary)), len(replica.queries(c.onPrimary)))
			}
			if len(replica.queries(c.onReplica)) != 1 || len(primary.queries(c.onReplica)) != 0 {
				t.Errorf("%s: %d on the replica, %d on the primary; want 1 and 0", c.onReplica,
					len(replica.queries(c.onReplica)), len(primary.queries(c.onReplica)))
			}
		})
	}
}

// Per cache, the metric hashes: with another cache listed, a metrics miss neither takes the populate
// lock nor writes the hash; with metrics listed it writes both, counted written. Fails on:
// lookupImageMetrics gating on "any cache listed", or not counting the hash write.
func TestMetricsWriteBackOnlyWhenListed(t *testing.T) {
	s, r, _ := coldSources(false)
	s.Compute.WriteBack = WriteSet{MissTagIDs: true, MissUserCosmetics: true}
	before := r.AllKeys()
	if _, err := s.ImageMetrics(context.Background(), []int{31, 32, 33}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.AllKeys(), before) {
		t.Fatalf("metrics not listed: keys %v, want unchanged %v", r.AllKeys(), before)
	}

	s, r, _ = coldSources(false)
	obs := &observed{}
	s.Compute.WriteBack = WriteSet{MissMetrics: true}
	s.Compute.ObserveWrite = obs.observe
	if _, err := s.ImageMetrics(context.Background(), []int{31, 32, 33}); err != nil {
		t.Fatal(err)
	}
	if h := r.Hash(metricHashKey(32)); h["Like"] != "4" {
		t.Fatalf("metrics listed: hash 32 = %v, want Like 4 written", h)
	}
	if o := obs.get(); !reflect.DeepEqual(o, map[string]int{"metrics/written": 2}) {
		t.Fatalf("writes observed %v, want 2 metrics written (32 and 33's notFound hash)", o)
	}
}

// writePacked's results, each counted and logged per key: a SET NX on a free key is written, on a
// filled key nx_lost (nothing written), a failed command error, an overwrite (SET) written. The log
// names the cache, the key, the id and the result, and never the value. Fails on: counting every
// write as written (nx_lost and error lost), treating SET NX's false as an error, dropping the
// counter or the log call, or logging the value.
func TestWritePackedResults(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString("k:2", []byte("other"))
	r.KeyErr = func(k string) error {
		if k == "k:3" {
			return testkit.ErrDown
		}
		return nil
	}
	obs := &observed{}
	lines := &writeLines{}
	s := &Sources{Packed: &PackedReader{Redis: r}, Compute: &MissCompute{ObserveWrite: obs.observe, WriteLog: lines.log(100, nil)}}
	s.writePacked(context.Background(), []packedWrite{
		{cache: MissTagIDs, id: 1, key: "k:1", val: []byte("SECRET-VALUE-1"), ttl: time.Hour},
		{cache: MissTagIDs, id: 2, key: "k:2", val: []byte("SECRET-VALUE-2"), ttl: time.Hour},
		{cache: MissTagIDs, id: 3, key: "k:3", val: []byte("SECRET-VALUE-3"), ttl: time.Hour},
		{cache: MissVersionImages, id: 4, key: "k:4", val: []byte("SECRET-VALUE-4"), ttl: time.Hour, overwrite: true},
	})
	if o := obs.get(); !reflect.DeepEqual(o, map[string]int{"tag-ids/written": 1, "tag-ids/nx_lost": 1, "tag-ids/error": 1,
		"version-images/written": 1}) {
		t.Fatalf("observed %v", o)
	}
	if b, _ := r.String("k:2"); string(b) != "other" {
		t.Fatalf("nx_lost key holds %q, want the other writer's value", b)
	}
	want := []map[string]any{
		{"msg": "cache write", "cache": "tag-ids", "key": "k:1", "id": 1.0, "result": "written"},
		{"msg": "cache write", "cache": "tag-ids", "key": "k:2", "id": 2.0, "result": "nx_lost"},
		{"msg": "cache write", "cache": "tag-ids", "key": "k:3", "id": 3.0, "result": "error", "err": "testkit: redis is down"},
		{"msg": "cache write", "cache": "version-images", "key": "k:4", "id": 4.0, "result": "written"},
	}
	if got := lines.lines(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("lines\n got %v\nwant %v", got, want)
	}
	if strings.Contains(lines.raw(), "SECRET-VALUE") {
		t.Fatal("a value was logged")
	}

	// The official models' one key (no id): logged without an id.
	lines2 := &writeLines{}
	e := newOfficialEnv(&MissCompute{WriteBack: WriteSet{MissOfficialModels: true}, ObserveWrite: obs.observe, WriteLog: lines2.log(100, nil)})
	if _, err := e.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if o := obs.get(); o["official-models/written"] != 1 {
		t.Fatalf("official models observed %v, want 1 written", o)
	}
	if got := lines2.lines(t); !reflect.DeepEqual(got, []map[string]any{{"msg": "cache write", "cache": "official-models",
		"key": officialKey, "result": "written"}}) {
		t.Fatalf("official models lines %v", got)
	}
}

// The write-back pipeline runs detached from the request: a request context cancelled before the
// pipeline executes (a sibling lookup failed and the page falls back, the client left, the budget ran
// out) still writes the entries already computed, SET NX and overwrite alike, each counted and logged
// written. Regression: on the request's context every write failed with context.Canceled and was
// counted error. Fails on: writePacked pipelining on ctx instead of a detached context.
func TestWritePackedLandsAfterRequestCancelled(t *testing.T) {
	r := testkit.NewRedis()
	obs := &observed{}
	lines := &writeLines{}
	s := &Sources{Packed: &PackedReader{Redis: r}, Compute: &MissCompute{ObserveWrite: obs.observe, WriteLog: lines.log(100, nil)}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.writePacked(ctx, []packedWrite{
		{cache: MissTagIDs, id: 11, key: "k:11", val: []byte("v11"), ttl: time.Hour},
		{cache: MissVersionImages, id: 12, key: "k:12", val: []byte("v12"), ttl: time.Hour, overwrite: true},
	})
	if o := obs.get(); !reflect.DeepEqual(o, map[string]int{"tag-ids/written": 1, "version-images/written": 1}) {
		t.Fatalf("observed %v, want both written", o)
	}
	for k, want := range map[string]string{"k:11": "v11", "k:12": "v12"} {
		if b, ok := r.String(k); !ok || string(b) != want {
			t.Fatalf("%s holds %q (present %v), want %q", k, b, ok, want)
		}
	}
	want := []map[string]any{
		{"msg": "cache write", "cache": "tag-ids", "key": "k:11", "id": 11.0, "result": "written"},
		{"msg": "cache write", "cache": "version-images", "key": "k:12", "id": 12.0, "result": "written"},
	}
	if got := lines.lines(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("lines\n got %v\nwant %v", got, want)
	}
}

// The detached write is still bounded: a store slower than WriteTimeout fails the write, counted
// error, its line carrying the error's text; nothing is written, and writePacked returns at the
// bound rather than at the store's (here, an hour's) delay. Fails on: an unbounded detached context
// (the test hangs), the bound not applied to the pipeline, or the error text missing from the line.
func TestWritePackedDetachedTimeout(t *testing.T) {
	r := testkit.NewRedis()
	r.Delay = time.Hour
	obs := &observed{}
	lines := &writeLines{}
	s := &Sources{Packed: &PackedReader{Redis: r}, Compute: &MissCompute{ObserveWrite: obs.observe, WriteLog: lines.log(100, nil),
		WriteTimeout: 30 * time.Millisecond}}
	start := time.Now()
	s.writePacked(context.Background(), []packedWrite{{cache: MissTagIDs, id: 21, key: "k:21", val: []byte("v21"), ttl: time.Hour}})
	if el := time.Since(start); el > 10*time.Second {
		t.Fatalf("writePacked took %v, want about the 30ms bound", el)
	}
	if o := obs.get(); !reflect.DeepEqual(o, map[string]int{"tag-ids/error": 1}) {
		t.Fatalf("observed %v, want 1 error", o)
	}
	if _, ok := r.String("k:21"); ok {
		t.Fatal("k:21 written past the bound")
	}
	want := []map[string]any{
		{"msg": "cache write", "cache": "tag-ids", "key": "k:21", "id": 21.0, "result": "error", "err": "context deadline exceeded"},
	}
	if got := lines.lines(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("lines\n got %v\nwant %v", got, want)
	}
}

// The revalidation locks taken are released after the writes even when the request has ended:
// releaseLocks runs detached, as writePacked does. Fails on: the DEL pipelined on the cancelled
// request context (the lock then lingers to its expiry, and other revalidations serve stale).
func TestReleaseLocksAfterRequestCancelled(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString("lock:31", []byte("1"))
	s := &Sources{Packed: &PackedReader{Redis: r}, Compute: &MissCompute{}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.releaseLocks(ctx, []string{"lock:31"})
	if _, ok := r.String("lock:31"); ok {
		t.Fatal("lock:31 still held after release on a cancelled request")
	}
}

// The detached write's default bound is 1 s (cacheWriteTimeout), with or without a computation;
// WriteTimeout replaces it. Invariant guard on the constant: fails if the default bound is dropped
// (no deadline) or changed.
func TestWriteContextBound(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	cancel()
	cases := []struct {
		name string
		c    *MissCompute
		want time.Duration
	}{
		{"nil", nil, time.Second},
		{"zero", &MissCompute{}, time.Second},
		{"custom", &MissCompute{WriteTimeout: 5 * time.Second}, 5 * time.Second},
	}
	for _, tc := range cases {
		before := time.Now()
		ctx, done := tc.c.writeContext(parent)
		dl, ok := ctx.Deadline()
		err := ctx.Err()
		done()
		if !ok {
			t.Fatalf("%s: no deadline", tc.name)
		}
		if err != nil {
			t.Fatalf("%s: write context already ended (%v): the parent's cancellation leaked in", tc.name, err)
		}
		if d := dl.Sub(before); d < tc.want || d > tc.want+time.Second {
			t.Fatalf("%s: deadline %v after start, want %v", tc.name, d, tc.want)
		}
	}
}

// A request's write-back draws on ONE budget (WithWriteBudget): three sequential writes against a
// store slower than a 500ms bound wait about one bound in total (asserted under 1100ms, where
// stacking would take at least 1500ms), not 500ms each; once spent, the later writes fail at once,
// counted error. A ctx without the budget bounds each round trip on its own (the control: the same
// three then take at least 1500ms, so the timing can see stacking). Fails on: each round trip taking
// a fresh bound under the budget.
func TestWriteBackSharesOneBudgetPerRequest(t *testing.T) {
	newSources := func() (*Sources, *observed) {
		r := testkit.NewRedis()
		r.Delay = time.Hour
		obs := &observed{}
		return &Sources{Packed: &PackedReader{Redis: r}, Compute: &MissCompute{ObserveWrite: obs.observe, WriteTimeout: 500 * time.Millisecond}}, obs
	}
	run := func(ctx context.Context, s *Sources) time.Duration {
		start := time.Now()
		s.writePacked(ctx, []packedWrite{{cache: MissTagIDs, id: 41, key: "k:41", val: []byte("v41"), ttl: time.Hour}})
		s.writePacked(ctx, []packedWrite{{cache: MissUserCosmetics, id: 42, key: "k:42", val: []byte("v42"), ttl: time.Hour}})
		s.writePacked(ctx, []packedWrite{{cache: MissImageFrames, id: 43, key: "k:43", val: []byte("v43"), ttl: time.Hour}})
		return time.Since(start)
	}

	s, obs := newSources()
	if el := run(WithWriteBudget(context.Background()), s); el >= 1100*time.Millisecond {
		t.Fatalf("shared budget: three writes took %v, want under 1100ms (one 500ms bound)", el)
	}
	if o := obs.get(); !reflect.DeepEqual(o, map[string]int{"tag-ids/error": 1, "user-cosmetics/error": 1, "image-frames/error": 1}) {
		t.Fatalf("observed %v, want all three writes error", o)
	}

	// Control: no budget, so each round trip has its own 500ms bound (three of them).
	s, _ = newSources()
	if el := run(context.Background(), s); el < 1500*time.Millisecond {
		t.Fatalf("no budget: took %v, want at least 1500ms (three separate 500ms bounds)", el)
	}
}

// The budget is charged by WALL time: eight writes in flight together against a store that answers
// each in 200ms use about 200ms of a 1s budget, not 1600ms, so a ninth write after them still lands:
// all nine written. Fails on: charging each round trip its own duration (the eight would spend the
// budget and the ninth fail at once, counted error). Run under -race it also exercises the budget's
// mutex across goroutines.
func TestWriteBudgetChargesParallelWritesByWallTime(t *testing.T) {
	r := testkit.NewRedis()
	r.Delay = 200 * time.Millisecond
	obs := &observed{}
	s := &Sources{Packed: &PackedReader{Redis: r}, Compute: &MissCompute{ObserveWrite: obs.observe, WriteTimeout: time.Second}}
	ctx := WithWriteBudget(context.Background())
	var wg sync.WaitGroup
	for i := 1; i <= 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.writePacked(ctx, []packedWrite{{cache: MissTagIDs, id: 70 + i, key: "p:" + strconv.Itoa(i), val: []byte("v"), ttl: time.Hour}})
		}()
	}
	wg.Wait()
	s.writePacked(ctx, []packedWrite{{cache: MissUserCosmetics, id: 79, key: "p:9", val: []byte("v9"), ttl: time.Hour}})
	if o := obs.get(); !reflect.DeepEqual(o, map[string]int{"tag-ids/written": 8, "user-cosmetics/written": 1}) {
		t.Fatalf("observed %v, want 8 tag-ids and 1 user-cosmetics written", o)
	}
}

// A lock release gets lockReleaseFloor even once the request's write budget is spent: a slow write
// spends the 100ms budget, the store recovers, and the release still deletes the lock. Fails on: the
// release drawing on the spent budget with no floor (its context ends before it is sent, and the lock
// is held to its expiry).
func TestReleaseLocksFloorAfterBudgetSpent(t *testing.T) {
	r := testkit.NewRedis()
	r.Delay = time.Hour
	r.SetString("lock:61", []byte("1"))
	obs := &observed{}
	s := &Sources{Packed: &PackedReader{Redis: r}, Compute: &MissCompute{ObserveWrite: obs.observe, WriteTimeout: 100 * time.Millisecond}}
	ctx := WithWriteBudget(context.Background())
	s.writePacked(ctx, []packedWrite{{cache: MissTagIDs, id: 60, key: "k:60", val: []byte("v60"), ttl: time.Hour}})
	if o := obs.get(); !reflect.DeepEqual(o, map[string]int{"tag-ids/error": 1}) {
		t.Fatalf("observed %v, want the slow write error (budget spent)", o)
	}
	r.Delay = 0
	s.releaseLocks(ctx, []string{"lock:61"})
	if _, ok := r.String("lock:61"); ok {
		t.Fatal("lock:61 still held: the release got no floor past the spent budget")
	}
}

// The budget is time spent WRITING, not a deadline from the first write: a request that computes
// for longer than the bound between two healthy writes still lands the second one. Fails on: a
// wall-clock deadline anchored at the first write (the second write would fail on a healthy store).
// Also pins WithWriteBudget as idempotent: a nested call must not reset the request's budget.
func TestWriteBudgetIsWriteTimeNotWallClock(t *testing.T) {
	r := testkit.NewRedis()
	obs := &observed{}
	s := &Sources{Packed: &PackedReader{Redis: r}, Compute: &MissCompute{ObserveWrite: obs.observe, WriteTimeout: 100 * time.Millisecond}}
	ctx := WithWriteBudget(context.Background())
	if WithWriteBudget(ctx) != ctx {
		t.Fatal("WithWriteBudget replaced an existing budget")
	}
	s.writePacked(ctx, []packedWrite{{cache: MissTagIDs, id: 51, key: "k:51", val: []byte("v51"), ttl: time.Hour}})
	time.Sleep(250 * time.Millisecond) // the request computes on, past the 100ms bound
	s.writePacked(ctx, []packedWrite{{cache: MissUserCosmetics, id: 52, key: "k:52", val: []byte("v52"), ttl: time.Hour}})
	if o := obs.get(); !reflect.DeepEqual(o, map[string]int{"tag-ids/written": 1, "user-cosmetics/written": 1}) {
		t.Fatalf("observed %v, want both written", o)
	}
	if b, ok := r.String("k:52"); !ok || string(b) != "v52" {
		t.Fatalf("k:52 holds %q (present %v), want v52", b, ok)
	}
}

// A computed miss's write is counted under its cache through fill: SET NX on a key filled since the
// read is nx_lost, a failed write error. Fails on: fill not carrying the cache label into the write
// (counted under ""), or the outcome mapping above.
func TestFillCountsWriteOutcomes(t *testing.T) {
	f := basePageFixture(t)
	f.del(KeyUserCosmetics, 1002)
	f.del(KeyUserCosmetics, 1003)
	m := userCosmeticsMissDB()
	obs := &observed{}
	s, r := m.load(f, &MissCompute{WriteBack: WriteSet{MissUserCosmetics: true}, FrameNegative: true, ObserveWrite: obs.observe})
	// Once the page's reads are done (the lookup runs): 1002 is filled by another writer, and 1003's
	// key fails (a failed READ would make it unwritable instead).
	var failWrites atomic.Bool
	r.KeyErr = func(k string) error {
		if failWrites.Load() && k == pageNS+missKey(KeyUserCosmetics, 1003) {
			return testkit.ErrDown
		}
		return nil
	}
	m.before = func(name string) {
		if name == "users" {
			r.SetString(pageNS+missKey(KeyUserCosmetics, 1002), []byte("other"))
			failWrites.Store(true)
		}
	}
	if _, err := s.Page(context.Background(), pageRequest()); err != nil {
		t.Fatalf("Page: %v (fallback %q)", err, fallback.Reason(err))
	}
	if o := obs.get(); o["user-cosmetics/nx_lost"] != 1 || o["user-cosmetics/error"] != 1 || o["user-cosmetics/written"] != 0 {
		t.Fatalf("observed %v, want 1 nx_lost and 1 error", o)
	}
}

// The metric hash writer counts each id: the one whose script failed is error (and fails the
// populate, as Node's does), the rest written. Fails on: counting the failed id written, or counting
// none once one failed.
func TestMetricHashWriteOutcomes(t *testing.T) {
	s, r, f := coldSources(true)
	obs := &observed{}
	s.Compute.ObserveWrite = obs.observe
	// Only once ClickHouse is queried: a failed hash READ would fall back before any write.
	var failWrites atomic.Bool
	r.KeyErr = func(k string) error {
		if failWrites.Load() && k == metricHashKey(33) {
			return testkit.ErrDown
		}
		return nil
	}
	f.onQuery = func() { failWrites.Store(true) }
	if _, err := s.ImageMetrics(context.Background(), []int{31, 32, 33}); fallback.Reason(err) != "metrics-miss-failed" {
		t.Fatalf("err %v, want metrics-miss-failed (a failed hash write fails the populate)", err)
	}
	if o := obs.get(); !reflect.DeepEqual(o, map[string]int{"metrics/written": 1, "metrics/error": 1}) {
		t.Fatalf("observed %v, want 32 written and 33 error", o)
	}
}

// The write log is rate-limited per (cache, result): PerMinute lines at once, then one per
// 60/PerMinute seconds, the next line carrying how many were dropped; another cache or result has
// its own bucket; 0 (the default) or no log writes nothing. Fails on: no limiter (every line written),
// a shared bucket across caches or results, `suppressed` not reported or not reset, or PerMinute 0
// logging.
func TestWriteLogLimiter(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	clock := func() time.Time { return now }
	w := &writeLines{}
	l := w.log(2, clock)
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		l.write(ctx, MissTagIDs, "k", i, WriteWritten, nil)
	}
	l.write(ctx, MissTagIDs, "k", 6, WriteNXLost, nil)
	l.write(ctx, MissMetrics, "k", 7, WriteWritten, nil)
	now = now.Add(30 * time.Second) // one token back at 2/min
	l.write(ctx, MissTagIDs, "k", 8, WriteWritten, nil)
	l.write(ctx, MissTagIDs, "k", 9, WriteWritten, nil)
	logged := w.lines(t)
	got := make([]string, 0, len(logged))
	for _, line := range logged {
		s := line["cache"].(string) + "/" + line["result"].(string)
		if n, ok := line["suppressed"]; ok {
			s += "/suppressed=" + jsonNum(n)
		}
		got = append(got, s)
	}
	want := []string{"tag-ids/written", "tag-ids/written", "tag-ids/nx_lost", "metrics/written", "tag-ids/written/suppressed=3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("lines %v, want %v", got, want)
	}

	off := &writeLines{}
	off.log(0, clock).write(ctx, MissTagIDs, "k", 1, WriteWritten, nil)
	(*WriteLog)(nil).write(ctx, MissTagIDs, "k", 1, WriteWritten, nil)
	(&WriteLog{PerMinute: 5}).write(ctx, MissTagIDs, "k", 1, WriteWritten, nil)
	if off.raw() != "" {
		t.Fatalf("PerMinute 0 logged %q", off.raw())
	}
}

func jsonNum(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// Per cache, the stale tag-ids revalidation: with only metrics listed, a stale tag-ids entry whose
// revalidation lock another process holds is still looked up (no lock is consulted or taken, as
// with write-back off), nothing is written over it, and the holder's lock is left alone. Fails on
// revalidateStale gating on "any cache listed": the held lock would then make it serve the stale
// [77] with no lookup.
func TestStaleTagIDsNotRevalidatedUnderLockWhenOtherCacheListed(t *testing.T) {
	f, m := staleTagIDsFixture(t)
	s, r := m.load(f, &MissCompute{WriteBack: WriteSet{MissMetrics: true}, FrameNegative: true, TagGate: (&tagGateSpy{}).fn})
	r.SetString(tagLockKey(12), []byte("1"))
	before, _ := r.String(pageNS + missKey(KeyTagIDs, 12))
	got, err := s.TagIDs(context.Background(), []int{11, 12})
	if err != nil {
		t.Fatal(err)
	}
	if s := pagePlain(t, got[12]); s != `[22]` {
		t.Fatalf("stale 12 = %s, want [22] (looked up, no lock consulted)", s)
	}
	if q := m.queries("tagrows"); !reflect.DeepEqual(q, [][]int{{12}}) {
		t.Fatalf("tag row queries %v, want only the stale 12", q)
	}
	if after, _ := r.String(pageNS + missKey(KeyTagIDs, 12)); string(after) != string(before) {
		t.Fatal("the stale entry was overwritten with tag-ids not listed")
	}
	if b, _ := r.String(tagLockKey(12)); string(b) != "1" {
		t.Fatal("the other holder's lock was touched")
	}
	if r.Has(tagLockKey(11)) {
		t.Fatal("a lock was taken for the fresh 11")
	}
}

// Per cache, the official models: with only metrics listed, an absent entry is fetched from the
// replica with no lock taken and nothing written. Fails on OfficialModels gating on "any cache
// listed": it would take the lock and write the entry.
func TestOfficialModelsNotWrittenWhenOtherCacheListed(t *testing.T) {
	obs := &observed{}
	e := newOfficialEnv(&MissCompute{WriteBack: WriteSet{MissMetrics: true}, ObserveWrite: obs.observe})
	got, err := e.run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, fromReplica) || e.queries != 1 {
		t.Fatalf("got %v (%d queries), want the replica's rows", got, e.queries)
	}
	if e.r.Has(officialKey) || e.r.Has(officialLock) {
		t.Fatalf("entry written %v, lock taken %v; want neither with official-models not listed", e.r.Has(officialKey), e.r.Has(officialLock))
	}
	if o := obs.get(); len(o) != 0 {
		t.Fatalf("writes observed %v, want none", o)
	}
}

// Per cache, the lag-aware reads: with only metrics listed (a primary configured), a version and a
// model whose lag flags are set are still read from the replica, as with write-back off. Fails on
// lagAwareDB gating on "any cache listed": both would read the primary.
func TestLagAwareReadsReplicaWhenOtherCacheListed(t *testing.T) {
	t.Run("version-images", func(t *testing.T) {
		f := showcaseFixture(t)
		s, r := computedModelSources(f, &MissCompute{WriteBack: WriteSet{MissMetrics: true}, FrameNegative: true})
		s.Compute.Primary = &testkit.DB{Routes: []testkit.Route{f.showcaseRoute("primary")}}
		r.SetString(pageNS+"lag-helper:modelVersion:6003", []byte("true"))
		if _, err := s.VersionImages(context.Background(), []int{6001, 6003}); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(f.queries, []string{"showcases"}) {
			t.Fatalf("queries %v, want [showcases] (the replica)", f.queries)
		}
	})
	t.Run("model-data", func(t *testing.T) {
		f := fullModelFixture(t)
		f.del(KeyDataForModel, 5001)
		s, r := modelDataSources(f, &MissCompute{WriteBack: WriteSet{MissMetrics: true}, FrameNegative: true})
		if s.Compute.Primary == nil {
			t.Fatal("no primary configured: the test would not tell the two apart")
		}
		r.SetString(pageNS+"lag-helper:model:5001", []byte("1"))
		if _, err := s.ModelPage(context.Background(), modelPageRequest()); err != nil {
			t.Fatal(err)
		}
		got := make([]string, 0, len(f.queries))
		for _, q := range f.queries {
			if q != "tags" {
				got = append(got, q)
			}
		}
		if !reflect.DeepEqual(got, []string{"replica-data", "replica-hashes"}) {
			t.Fatalf("queries %v, want the replica's", got)
		}
	})
}
