package hydrate

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// msgpackr 1.11.5's bytes for what getOfficialModelIds' fetchThroughCache writes for the replica rows
// below: {data:[{id:5004, type:'Checkpoint'}, {id:5009, type:'LORA'}], cachedAt: pageNow.getTime()}
// (cachedAt is Date.now(), a number: msgpackr packs it as a float64).
const wantOfficialEntry = "de0002a46461746192de0002a26964cd138ca474797065aa436865636b706f696e74de0002a26964cd1391a474797065a44c4f5241a86361636865644174cb4279ecb272200000"

var (
	officialKey  = pageNS + KeyOfficialModels
	officialLock = pageNS + "cache-lock:" + pageNS + KeyOfficialModels
	// officialRows are the replica's official, published models (the fetchFn's rows).
	officialRows = [][]any{{int32(5004), "Checkpoint"}, {int32(5009), "LORA"}}
	fromReplica  = []OfficialModel{{ID: 5004, Type: "Checkpoint"}, {ID: 5009, Type: "LORA"}}
	// cachedList is what the cached entries below hold (different from the replica's rows).
	cachedList = []OfficialModel{{ID: 7001, Type: "Checkpoint"}}
)

// officialEnv is a cache and a replica for OfficialModels; queries counts the fetchFn's queries.
type officialEnv struct {
	r       *testkit.Redis
	s       *Sources
	mu      sync.Mutex
	queries int
	fail    bool
}

func newOfficialEnv(c *MissCompute) *officialEnv {
	e := &officialEnv{r: testkit.NewRedis()}
	db := &testkit.DB{Routes: []testkit.Route{{Match: `"isOfficial" = true`, Rows: func(_ []any) (*testkit.Rows, error) {
		e.mu.Lock()
		e.queries++
		e.mu.Unlock()
		if e.fail {
			return nil, errMissDB
		}
		return testkit.NewRows([]string{"id", "type"}, officialRows...), nil
	}}}}
	if c != nil && c.Now == nil {
		c.Now = func() time.Time { return pageNow }
	}
	e.s = &Sources{Packed: &PackedReader{Redis: e.r, Prefix: pageNS, Now: func() time.Time { return pageNow }}, Cache: e.r, Replica: db, Compute: c}
	return e
}

// putEntry writes a fetchThroughCache entry holding cachedList, cachedAt age before pageNow.
func (e *officialEnv) putEntry(age time.Duration) {
	e.r.SetString(officialKey, jspack.Pack(jspack.O("data", []any{jspack.O("id", 7001, "type", "Checkpoint")},
		"cachedAt", float64(pageNow.Add(-age).UnixMilli()))))
}

func (e *officialEnv) run(ctx context.Context) ([]OfficialModel, error) {
	return e.s.OfficialModels(ctx)
}

// A fresh entry (cachedAt within the 5 min ttl, the boundary included: `now - ttl > cachedAt` is
// expired) is served as cached, nothing queried, locked or written; a millisecond past it is fetched.
func TestOfficialModelsFreshEntry(t *testing.T) {
	for _, c := range []struct {
		name string
		age  time.Duration
		want []OfficialModel
		q    int
	}{
		{"a minute old", time.Minute, cachedList, 0},
		{"exactly the ttl", 5 * time.Minute, cachedList, 0},
		{"a millisecond past it", 5*time.Minute + time.Millisecond, fromReplica, 1},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := newOfficialEnv(&MissCompute{})
			e.putEntry(c.age)
			got, err := e.run(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, c.want) || e.queries != c.q {
				t.Fatalf("got %v with %d queries, want %v with %d", got, e.queries, c.want, c.q)
			}
		})
	}
}

// Write-back on, the lock free: the lock is taken, the replica read, the entry written as Node writes
// it (its bytes, EX 600), and the lock released.
func TestOfficialModelsRefreshWritesUnderTheLock(t *testing.T) {
	for _, c := range []struct {
		name  string
		entry bool
	}{{"absent", false}, {"expired", true}} {
		t.Run(c.name, func(t *testing.T) {
			e := newOfficialEnv(&MissCompute{WriteBack: AllWrites()})
			if c.entry {
				e.putEntry(time.Hour)
			}
			got, err := e.run(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, fromReplica) || e.queries != 1 {
				t.Fatalf("got %v (%d queries), want the replica's rows", got, e.queries)
			}
			wantPacked(t, e.r, KeyOfficialModels, wantOfficialEntry, 10*time.Minute)
			if e.r.Has(officialLock) {
				t.Fatal("the lock was left behind")
			}
		})
	}
}

// The lock held elsewhere: an expired entry is served; with none the answer is [] (fetchThroughCache's
// retryCount 0 throws, and getOfficialModelIds' catch answers []). Nothing is queried or written, with
// write-back on (SET NX fails) or off (EXISTS answers it).
func TestOfficialModelsLockHeld(t *testing.T) {
	for _, writeBack := range []bool{false, true} {
		for _, c := range []struct {
			name  string
			entry bool
			want  []OfficialModel
		}{{"expired entry", true, cachedList}, {"no entry", false, []OfficialModel{}}} {
			t.Run(c.name, func(t *testing.T) {
				e := newOfficialEnv(&MissCompute{WriteBack: writeSet(writeBack)})
				if c.entry {
					e.putEntry(time.Hour)
				}
				e.r.SetString(officialLock, []byte("1"))
				before, _ := e.r.String(officialKey)
				got, err := e.run(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(got, c.want) || e.queries != 0 {
					t.Fatalf("write-back %v: got %#v (%d queries), want %#v and none", writeBack, got, e.queries, c.want)
				}
				if after, _ := e.r.String(officialKey); !reflect.DeepEqual(after, before) {
					t.Fatalf("write-back %v: the entry changed", writeBack)
				}
				if !e.r.Has(officialLock) {
					t.Fatal("another holder's lock was released")
				}
			})
		}
	}
}

// Write-back off, the lock free: the replica is read (as Node, which takes the lock, reads it), no
// lock is taken and nothing is written; a repeat within seconds is answered in process.
func TestOfficialModelsWriteBackOffReadsTheReplica(t *testing.T) {
	e := newOfficialEnv(&MissCompute{})
	for i := 0; i < 2; i++ {
		got, err := e.run(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, fromReplica) {
			t.Fatalf("call %d: %v", i, got)
		}
	}
	if e.queries != 1 {
		t.Fatalf("%d queries, want 1 (the second call answered from the kept answer)", e.queries)
	}
	wantAbsent(t, e.r, officialKey, officialLock)
}

// Without the miss computation an entry that would be fetched falls back (official-models-miss); a
// fresh one is served, and a held lock with no entry is [] as in Node.
func TestOfficialModelsWithoutComputation(t *testing.T) {
	e := newOfficialEnv(nil)
	if _, err := e.run(context.Background()); fallback.Reason(err) != "official-models-miss" {
		t.Fatalf("absent: %v, want official-models-miss", err)
	}
	e.putEntry(time.Hour)
	if _, err := e.run(context.Background()); fallback.Reason(err) != "official-models-miss" {
		t.Fatalf("expired: %v, want official-models-miss", err)
	}
	e.putEntry(time.Minute)
	if got, err := e.run(context.Background()); err != nil || !reflect.DeepEqual(got, cachedList) {
		t.Fatalf("fresh: %v %v", got, err)
	}
	e.r.DelKey(officialKey)
	e.r.SetString(officialLock, []byte("1"))
	if got, err := e.run(context.Background()); err != nil || len(got) != 0 || got == nil {
		t.Fatalf("lock held, no entry: %#v %v, want []", got, err)
	}
	if e.queries != 0 {
		t.Fatalf("%d queries without a computation", e.queries)
	}
}

// A failed replica read is official-models-miss-failed (Node's catch would answer [], a different
// page), nothing written, the lock released; counted as an error.
func TestOfficialModelsLookupFailure(t *testing.T) {
	obs := &observed{}
	e := newOfficialEnv(&MissCompute{WriteBack: AllWrites(), Observe: obs.observe})
	e.fail = true
	_, err := e.run(context.Background())
	if got := fallback.Reason(err); got != "official-models-miss-failed" {
		t.Fatalf("err %v (%q)", err, got)
	}
	if o := obs.get(); o["official-models/error"] != 1 {
		t.Fatalf("observed %v", o)
	}
	wantAbsent(t, e.r, officialKey, officialLock)
}

// A cache read that fails is fetchThroughCache's fail-open path: the replica answers.
func TestOfficialModelsReadFailureFetches(t *testing.T) {
	e := newOfficialEnv(&MissCompute{WriteBack: AllWrites()})
	e.r.Err = testkit.ErrDown
	got, err := e.run(context.Background())
	if err != nil || !reflect.DeepEqual(got, fromReplica) || e.queries != 1 {
		t.Fatalf("got %v %v (%d queries), want the replica's rows", got, err, e.queries)
	}
}

// An entry fetchThroughCache treats as a miss (no `data`, a `cachedAt` that is not a number) is
// fetched; `data: null` is an empty list.
func TestOfficialModelsMalformedEntry(t *testing.T) {
	for _, c := range []struct {
		name  string
		entry jspack.Obj
		want  []OfficialModel
		q     int
	}{
		{"no data", jspack.O("cachedAt", float64(pageNow.UnixMilli())), fromReplica, 1},
		{"a Date cachedAt", jspack.O("data", []any{}, "cachedAt", pageNow), fromReplica, 1},
		{"null data", jspack.O("data", nil, "cachedAt", float64(pageNow.UnixMilli())), []OfficialModel{}, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := newOfficialEnv(&MissCompute{})
			e.r.SetString(officialKey, jspack.Pack(c.entry))
			got, err := e.run(context.Background())
			if err != nil || !reflect.DeepEqual(got, c.want) || e.queries != c.q {
				t.Fatalf("got %#v %v (%d queries), want %#v (%d)", got, err, e.queries, c.want, c.q)
			}
		})
	}
}

// Under a Go-first probe the read is recorded (one official-models read) and done on the replica
// even with write-back on: no lock, no write, not observed.
func TestOfficialModelsUnderPresence(t *testing.T) {
	obs := &observed{}
	e := newOfficialEnv(&MissCompute{WriteBack: AllWrites(), Observe: obs.observe})
	rec := &PresenceProbe{}
	got, err := e.run(WithPresence(context.Background(), rec))
	if err != nil || !reflect.DeepEqual(got, fromReplica) {
		t.Fatalf("got %v %v", got, err)
	}
	if m, d := rec.Misses(), rec.DBReads(); !reflect.DeepEqual(m, map[string]int{MissOfficialModels: 1}) || !reflect.DeepEqual(d, map[string]int{MissOfficialModels: 1}) {
		t.Fatalf("misses %v db reads %v", m, d)
	}
	if o := obs.get(); len(o) != 0 {
		t.Fatalf("observed %v under the probe", o)
	}
	wantAbsent(t, e.r, officialKey, officialLock)
}
