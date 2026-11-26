package hydrate

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// The version-showcase cache as the curated-showcase guard reads it. Entries are written as
// getVersionShowcaseCache writes them (a CachedVersionShowcase record plus `cachedAt`); the literal
// expectations follow curatedSiteFor (src/server/services/version-showcase.service.ts), which
// withCuratedShowcases and getCarouselShowcaseIds decide by: a row on either site is curated; a failed
// read is answered as curated here, with its error (the request is Node's); and createCachedArray's fetch: an
// entry past the cache's hour (`ttl: CacheTTL.hour`) is rebuilt by the reader that wins the
// revalidate lock, so the cache cannot answer it.

var showcaseNow = time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)

func showcaseEntry(id int, rows ...any) []byte {
	if rows == nil {
		rows = []any{}
	}
	return jspack.Pack(jspack.O("modelVersionId", id, "rows", rows, "community", []any{}, "cachedAt", showcaseNow.Add(-time.Minute)))
}

// showcaseAged is showcaseEntry written age before showcaseNow.
func showcaseAged(id int, age time.Duration, rows ...any) []byte {
	if rows == nil {
		rows = []any{}
	}
	return jspack.Pack(jspack.O("modelVersionId", id, "rows", rows, "community", []any{}, "cachedAt", showcaseNow.Add(-age)))
}

func showcaseRow(imageID int, site string) jspack.Obj {
	return jspack.O("imageId", imageID, "site", site, "source", "Owner", "position", 1, "excluded", false)
}

func TestVersionShowcaseState(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7101", showcaseEntry(7101))                           // uncurated
	r.SetString(KeyVersionShowcase+":7102", showcaseEntry(7102, showcaseRow(9001, "com"))) // curated on .com
	r.SetString(KeyVersionShowcase+":7103", showcaseEntry(7103, showcaseRow(9002, "red"))) // curated on .red only
	r.SetString(KeyVersionShowcase+":7104", jspack.Pack(jspack.O("notFound", true)))       // a notFound marker
	r.SetString(KeyVersionShowcase+":7105", jspack.Pack(jspack.O("debounce", true)))       // a bust's marker
	r.SetString(KeyVersionShowcase+":7106", jspack.Pack(jspack.O("modelVersionId", 7106))) // no rows member
	r.SetString(KeyVersionShowcase+":7107", []byte{0xc1})                                  // undecodable
	// Past the hour TTL: the Node reader that wins the revalidate lock rebuilds it from the database.
	r.SetString(KeyVersionShowcase+":7109", showcaseAged(7109, 61*time.Minute))
	r.SetString(KeyVersionShowcase+":7111", showcaseAged(7111, 59*time.Minute))                                                 // inside the hour: fresh
	r.SetString(KeyVersionShowcase+":7112", showcaseAged(7112, 3*time.Hour, showcaseRow(9003, "com")))                          // stale and curated
	r.SetString(KeyVersionShowcase+":7113", jspack.Pack(jspack.O("notFound", true, "cachedAt", showcaseNow.Add(-3*time.Hour)))) // an old notFound marker
	// No cachedAt: `undefined < ttlExpiry` is false in Node, so never stale.
	r.SetString(KeyVersionShowcase+":7114", jspack.Pack(jspack.O("modelVersionId", 7114, "rows", []any{}, "community", []any{})))
	r.KeyErr = func(key string) error {
		if key == KeyVersionShowcase+":7110" {
			return errors.New("shard down")
		}
		return nil
	}
	src := &Sources{Packed: &PackedReader{Redis: r, Now: func() time.Time { return showcaseNow }}}
	for _, c := range []struct {
		name string
		ids  []int
		want Showcase
	}{
		{"no versions", nil, ShowcaseUncurated},
		{"an empty rows entry", []int{7101}, ShowcaseUncurated},
		{"a stale empty entry", []int{7109}, ShowcaseStale},
		{"an empty entry inside the hour", []int{7111}, ShowcaseUncurated},
		{"stale beside fresh", []int{7101, 7111, 7109}, ShowcaseStale},
		{"a stale curated entry", []int{7112}, ShowcaseCurated},
		{"curated wins over stale", []int{7109, 7102}, ShowcaseCurated},
		{"a miss wins over stale", []int{7109, 7108}, ShowcaseUnknown},
		{"a miss wins over stale, either order", []int{7108, 7109}, ShowcaseUnknown},
		// fetch() serves a notFound marker before it looks at cachedAt.
		{"an old notFound marker", []int{7113}, ShowcaseUncurated},
		{"no cachedAt", []int{7114}, ShowcaseUncurated},
		{"a notFound marker", []int{7104}, ShowcaseUncurated},
		{"curated on .com", []int{7102}, ShowcaseCurated},
		{"curated on the other site only", []int{7103}, ShowcaseCurated},
		{"one curated among uncurated", []int{7101, 7109, 7103}, ShowcaseCurated},
		{"no key", []int{7108}, ShowcaseUnknown},
		{"a debounce marker", []int{7105}, ShowcaseUnknown},
		{"an undecodable value", []int{7107}, ShowcaseUnknown},
		{"uncurated and a miss", []int{7101, 7108}, ShowcaseUnknown},
		{"curated wins over a miss", []int{7108, 7102}, ShowcaseCurated},
		{"no rows member", []int{7106}, ShowcaseCurated},
	} {
		if got, err := src.VersionShowcase(context.Background(), c.ids); got != c.want || err != nil {
			t.Errorf("%s: %v (%v), want %v", c.name, got, err, c.want)
		}
	}
	// A GET that failed (not redis.Nil) is curated WITH the read's error, so the caller's fallback
	// names a read failure (`<reason>-miss-failed`), never a curation; the cache-only State still
	// answers it curated.
	for _, c := range []struct {
		name string
		ids  []int
	}{
		{"a failed read", []int{7110}},
		{"a failed read beside a miss", []int{7108, 7110}},
		{"a failed read beside an uncurated entry", []int{7101, 7110}},
	} {
		got, err := src.VersionShowcase(context.Background(), c.ids)
		if got != ShowcaseCurated || err == nil || err.Error() != "version showcase cache read: shard down" {
			t.Errorf("%s: %v (%v), want curated with the cache read's error", c.name, got, err)
		}
	}
	b := NewBatch()
	read := src.Packed.QueueShowcases(b, []int{7110})
	b.Exec(context.Background())
	if got := read.State([]int{7110}); got != ShowcaseCurated {
		t.Errorf("State over a failed read: %v, want curated", got)
	}
}

// Whatever fails the whole read is curated (a transport failure on every command), and no client at
// all, or no reader, cannot say: unknown.
func TestVersionShowcaseUnreadable(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7101", showcaseEntry(7101))
	r.Err = errors.New("cluster down")
	if got, _ := (&Sources{Packed: &PackedReader{Redis: r}}).VersionShowcase(context.Background(), []int{7101}); got != ShowcaseCurated {
		t.Errorf("transport failure: %v, want curated", got)
	}
	if got, _ := (&Sources{Packed: &PackedReader{}}).VersionShowcase(context.Background(), []int{7101}); got != ShowcaseUnknown {
		t.Errorf("no client: %v, want unknown", got)
	}
	if got, _ := (&Sources{}).VersionShowcase(context.Background(), []int{7101}); got != ShowcaseUnknown {
		t.Errorf("no reader: %v, want unknown", got)
	}
}

// State answers only the ids asked about: an entry queued but not asked about does not count, and
// an id asked about but never queued is unknown.
func TestShowcaseReadStateSubset(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7101", showcaseEntry(7101))
	r.SetString(KeyVersionShowcase+":7102", showcaseEntry(7102, showcaseRow(9001, "com")))
	p := &PackedReader{Redis: r, Now: func() time.Time { return showcaseNow }}
	b := NewBatch()
	read := p.QueueShowcases(b, []int{7101, 7102})
	b.Exec(context.Background())
	if got := read.State([]int{7101}); got != ShowcaseUncurated {
		t.Errorf("the uncurated one alone: %v, want uncurated", got)
	}
	if got := read.State([]int{7101, 7102}); got != ShowcaseCurated {
		t.Errorf("both: %v, want curated", got)
	}
	if got := read.State([]int{7103}); got != ShowcaseUnknown {
		t.Errorf("never queued: %v, want unknown", got)
	}
}

// showcaseReplica is a replica answering sqlShowcaseCurated: a row when any bound version is in
// curated, an error when fail is set. bound is each query's version ids.
type showcaseReplica struct {
	curated map[int]bool
	fail    error
	bound   [][]int
}

func (s *showcaseReplica) db() *testkit.DB {
	return &testkit.DB{Routes: []testkit.Route{{Match: `FROM "ModelVersionShowcaseItem" WHERE "modelVersionId" = ANY($1::int[]) && NOT "removed"`,
		Rows: func(args []any) (*testkit.Rows, error) {
			ids, _ := args[0].([]int)
			s.bound = append(s.bound, ids)
			if s.fail != nil {
				return nil, s.fail
			}
			for _, id := range ids {
				if s.curated[id] {
					return testkit.NewRows([]string{"?column?"}, []any{int32(1)}), nil
				}
			}
			return testkit.NewRows([]string{"?column?"}), nil
		}}}}
}

// A version the cache holds no usable entry for is answered from the replica when misses are
// computed: getVersionShowcaseCache's lookup (version-showcase.service.ts) builds `rows` from its
// ModelVersionShowcaseItem rows that are not removed, and curatedSiteFor counts any row as curated;
// a failed read is answered as curated (the request is Node's). One query covers every such version of the call; a stale entry
// is not looked up (it still falls back), nor a bust's debounce marker (it stays unknown: a bust
// usually follows a curation the replica may not show yet), nor anything once a cached entry says
// curated.
func TestVersionShowcaseMissComputed(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7201", showcaseEntry(7201))                           // cached uncurated
	r.SetString(KeyVersionShowcase+":7204", showcaseAged(7204, 2*time.Hour))               // cached uncurated, stale
	r.SetString(KeyVersionShowcase+":7205", jspack.Pack(jspack.O("debounce", true)))       // a bust's marker
	r.SetString(KeyVersionShowcase+":7206", showcaseEntry(7206, showcaseRow(9201, "red"))) // cached curated
	r.SetString(KeyVersionShowcase+":7207", []byte{0xc1})                                  // undecodable
	// 7202 and 7208 have no key; the replica holds a row for 7203 only (also no key).
	for _, c := range []struct {
		name  string
		ids   []int
		want  Showcase
		bound [][]int
	}{
		{"a miss with no row", []int{7202}, ShowcaseUncurated, [][]int{{7202}}},
		{"a miss with a row", []int{7203}, ShowcaseCurated, [][]int{{7203}}},
		{"cached uncurated beside a miss with no row", []int{7201, 7202}, ShowcaseUncurated, [][]int{{7202}}},
		{"every computed kind of miss, one query", []int{7208, 7201, 7202, 7207}, ShowcaseUncurated, [][]int{{7208, 7202, 7207}}},
		{"a debounce marker: not looked up", []int{7205}, ShowcaseUnknown, nil},
		{"a debounce marker beside a miss with no row: not looked up", []int{7202, 7205}, ShowcaseUnknown, nil},
		{"a repeated miss is bound once", []int{7202, 7201, 7202}, ShowcaseUncurated, [][]int{{7202}}},
		{"a row among the misses", []int{7202, 7203, 7201}, ShowcaseCurated, [][]int{{7202, 7203}}},
		{"cached curated: no query", []int{7202, 7206}, ShowcaseCurated, nil},
		{"cached only: no query", []int{7201}, ShowcaseUncurated, nil},
		{"stale alone: not looked up", []int{7204}, ShowcaseStale, nil},
		{"stale beside a miss with no row", []int{7204, 7202}, ShowcaseStale, [][]int{{7202}}},
		{"a row wins over stale", []int{7204, 7203}, ShowcaseCurated, [][]int{{7203}}},
	} {
		rep := &showcaseReplica{curated: map[int]bool{7203: true}}
		src := &Sources{Packed: &PackedReader{Redis: r, Now: func() time.Time { return showcaseNow }}, Replica: rep.db(), Compute: &MissCompute{}}
		got, err := src.VersionShowcase(context.Background(), c.ids)
		if got != c.want || err != nil {
			t.Errorf("%s: %v (%v), want %v", c.name, got, err, c.want)
		}
		if !reflect.DeepEqual(rep.bound, c.bound) {
			t.Errorf("%s: queries bound %v, want %v", c.name, rep.bound, c.bound)
		}
	}
}

// A failed replica read is ShowcaseCurated with its error (the caller falls back and Node decides);
// without the miss computation, or without a replica, a miss stays ShowcaseUnknown and nothing is
// queried.
func TestVersionShowcaseMissComputeFailsOrOff(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7301", showcaseEntry(7301))
	packed := &PackedReader{Redis: r, Now: func() time.Time { return showcaseNow }}

	rep := &showcaseReplica{fail: errors.New("replica down")}
	got, err := (&Sources{Packed: packed, Replica: rep.db(), Compute: &MissCompute{}}).VersionShowcase(context.Background(), []int{7301, 7302})
	if got != ShowcaseCurated || err == nil {
		t.Errorf("failed query: %v (%v), want curated with an error", got, err)
	}
	if !reflect.DeepEqual(rep.bound, [][]int{{7302}}) {
		t.Errorf("failed query: bound %v, want [[7302]]", rep.bound)
	}

	rep = &showcaseReplica{}
	if got, err := (&Sources{Packed: packed, Replica: rep.db()}).VersionShowcase(context.Background(), []int{7301, 7302}); got != ShowcaseUnknown || err != nil {
		t.Errorf("no computation: %v (%v), want unknown", got, err)
	}
	if got, err := (&Sources{Packed: packed, Compute: &MissCompute{}}).VersionShowcase(context.Background(), []int{7301, 7302}); got != ShowcaseUnknown || err != nil {
		t.Errorf("no replica: %v (%v), want unknown", got, err)
	}
	if len(rep.bound) != 0 {
		t.Errorf("queried without the computation: %v", rep.bound)
	}

	// No cache reader at all: every version is a miss, answered from the replica.
	rep = &showcaseReplica{}
	if got, err := (&Sources{Replica: rep.db(), Compute: &MissCompute{}}).VersionShowcase(context.Background(), []int{7303, 7304}); got != ShowcaseUncurated || err != nil {
		t.Errorf("no cache reader: %v (%v), want uncurated", got, err)
	}
	if !reflect.DeepEqual(rep.bound, [][]int{{7303, 7304}}) {
		t.Errorf("no cache reader: bound %v, want [[7303 7304]]", rep.bound)
	}
}

// ShowcaseState over a queued read answers only the ids asked about: an id never queued is a miss
// looked up with the others, and a queued entry not asked about is neither read nor looked up.
func TestShowcaseStateSubsetComputed(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7401", showcaseEntry(7401))
	r.SetString(KeyVersionShowcase+":7402", showcaseEntry(7402, showcaseRow(9401, "com")))
	p := &PackedReader{Redis: r, Now: func() time.Time { return showcaseNow }}
	b := NewBatch()
	read := p.QueueShowcases(b, []int{7401, 7402, 7403})
	b.Exec(context.Background())
	rep := &showcaseReplica{curated: map[int]bool{7405: true}}
	src := &Sources{Packed: p, Replica: rep.db(), Compute: &MissCompute{}}
	if got, err := src.ShowcaseState(context.Background(), read, []int{7401, 7403, 7404}); got != ShowcaseUncurated || err != nil {
		t.Errorf("a queued miss and an unqueued id: %v (%v), want uncurated", got, err)
	}
	if got, err := src.ShowcaseState(context.Background(), read, []int{7401, 7405}); got != ShowcaseCurated || err != nil {
		t.Errorf("an unqueued id with a row: %v (%v), want curated", got, err)
	}
	if !reflect.DeepEqual(rep.bound, [][]int{{7403, 7404}, {7405}}) {
		t.Errorf("bound %v, want [[7403 7404] [7405]]", rep.bound)
	}
}

// Node's lookup reads the primary for a version a recent write flagged (getDbWithoutLagBatch
// ('modelVersion', ids): `lag-helper:modelVersion:<id>`, namespace prefixed, set by
// refreshVersionShowcases' preventReplicationLagBatch). A missed version with its flag set (any
// non-empty value, the tracker's `Boolean(value)`) is not computed: it stays ShowcaseUnknown and the
// replica is not queried, so the caller falls back as a miss. A failed flag read is not queried
// either, but is curated with the read's error (the caller's `<reason>-miss-failed`), unless a flag is
// found set. A flag on another version, on a version the cache answers, or an empty flag, changes
// nothing.
func TestVersionShowcaseLagFlag(t *testing.T) {
	const ns = "ns:"
	r := testkit.NewRedis()
	r.SetString(ns+KeyVersionShowcase+":7504", showcaseEntry(7504)) // cached uncurated
	// 7501, 7502, 7503, 7505 and 7506 have no showcase entry.
	r.SetString(ns+"lag-helper:modelVersion:7502", []byte("true"))
	r.SetString(ns+"lag-helper:modelVersion:7503", []byte("1"))
	r.SetString(ns+"lag-helper:modelVersion:7504", []byte("true"))
	r.SetString(ns+"lag-helper:modelVersion:7505", []byte(""))
	// Unprefixed: not the key Node writes, so not a flag.
	r.SetString("lag-helper:modelVersion:7501", []byte("true"))
	r.KeyErr = func(key string) error {
		if key == ns+"lag-helper:modelVersion:7506" {
			return errors.New("shard down")
		}
		return nil
	}
	for _, c := range []struct {
		name  string
		ids   []int
		want  Showcase
		bound [][]int
		obs   map[string]int
		err   string // the error's text; "" for none
	}{
		{"unflagged miss: computed", []int{7501}, ShowcaseUncurated, [][]int{{7501}}, map[string]int{"version-showcase/computed": 1}, ""},
		{"flagged miss: not computed", []int{7502}, ShowcaseUnknown, nil, map[string]int{}, ""},
		{"another flag value: not computed", []int{7503}, ShowcaseUnknown, nil, map[string]int{}, ""},
		{"one flagged among misses: not computed", []int{7501, 7502}, ShowcaseUnknown, nil, map[string]int{}, ""},
		{"the flag is on a cached version: computed", []int{7504, 7501}, ShowcaseUncurated, [][]int{{7501}}, map[string]int{"version-showcase/computed": 1}, ""},
		{"an empty flag: computed", []int{7505, 7501}, ShowcaseUncurated, [][]int{{7505, 7501}}, map[string]int{"version-showcase/computed": 2}, ""},
		{"a failed flag read: not computed, the read's error", []int{7506}, ShowcaseCurated, nil, map[string]int{}, "version showcase lag flag read: shard down"},
		{"a failed flag read among misses: not computed, the read's error", []int{7501, 7506}, ShowcaseCurated, nil, map[string]int{}, "version showcase lag flag read: shard down"},
		{"a failed flag read, another flagged: the flag wins", []int{7506, 7502}, ShowcaseUnknown, nil, map[string]int{}, ""},
	} {
		rep := &showcaseReplica{}
		obs := &observed{}
		src := &Sources{Packed: &PackedReader{Redis: r, Prefix: ns, Now: func() time.Time { return showcaseNow }}, Replica: rep.db(),
			Compute: &MissCompute{Observe: obs.observe}}
		got, err := src.VersionShowcase(context.Background(), c.ids)
		gotErr := ""
		if err != nil {
			gotErr = err.Error()
		}
		if got != c.want || gotErr != c.err {
			t.Errorf("%s: %v (%q), want %v (%q)", c.name, got, gotErr, c.want, c.err)
		}
		if !reflect.DeepEqual(rep.bound, c.bound) {
			t.Errorf("%s: queries bound %v, want %v", c.name, rep.bound, c.bound)
		}
		if g := obs.get(); !reflect.DeepEqual(g, c.obs) {
			t.Errorf("%s: observed %v, want %v", c.name, g, c.obs)
		}
	}
}

// Each computed decision counts its missed versions (feed_go_cache_miss_total{cache="version-showcase"}):
// "computed" with the replica's answer, "error" when the query fails. A decision taken from the cache
// alone, a debounce marker and a Go-first probe count nothing.
func TestVersionShowcaseMissObserved(t *testing.T) {
	r := testkit.NewRedis()
	r.SetString(KeyVersionShowcase+":7601", showcaseEntry(7601))
	r.SetString(KeyVersionShowcase+":7602", jspack.Pack(jspack.O("debounce", true)))
	packed := &PackedReader{Redis: r, Now: func() time.Time { return showcaseNow }}
	for _, c := range []struct {
		name  string
		ids   []int
		fail  error
		probe bool
		want  map[string]int
	}{
		{"two misses, no row", []int{7601, 7603, 7604}, nil, false, map[string]int{"version-showcase/computed": 2}},
		{"a miss with a row", []int{7605}, nil, false, map[string]int{"version-showcase/computed": 1}},
		{"a failed query", []int{7603, 7604, 7606}, errors.New("replica down"), false, map[string]int{"version-showcase/error": 3}},
		{"cached only", []int{7601}, nil, false, map[string]int{}},
		{"a debounce marker", []int{7602, 7603}, nil, false, map[string]int{}},
		{"under a probe", []int{7603}, nil, true, map[string]int{}},
	} {
		rep := &showcaseReplica{curated: map[int]bool{7605: true}, fail: c.fail}
		obs := &observed{}
		src := &Sources{Packed: packed, Replica: rep.db(), Compute: &MissCompute{Observe: obs.observe}}
		ctx := context.Background()
		if c.probe {
			ctx = WithPresence(ctx, &PresenceProbe{})
		}
		_, _ = src.VersionShowcase(ctx, c.ids)
		if g := obs.get(); !reflect.DeepEqual(g, c.want) {
			t.Errorf("%s: observed %v, want %v", c.name, g, c.want)
		}
	}
}
