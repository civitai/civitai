package feed

import (
	"errors"
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// getAllImages reads the version's curated showcase for a prioritizedUserIds request with a
// modelVersionId (getCarouselShowcaseIds, src/server/services/image.service.ts) and, curated, serves
// that list in its order. Not ported: the guard hands a curated version (ShowcaseCurated), an
// uncached entry (ShowcaseUnknown) or a stale one (ShowcaseStale) to Node (DESIGN.md §16.9); a failed
// read is TestServeInfinitePrioritizedShowcaseReadFailure's.
func TestServeInfinitePrioritizedCuratedShowcase(t *testing.T) {
	for _, c := range []struct {
		name     string
		showcase hydrate.Showcase
		want     string
	}{
		{"curated", hydrate.ShowcaseCurated, "prioritized-curated-showcase"},
		{"not cached", hydrate.ShowcaseUnknown, "prioritized-showcase-miss"},
		{"stale", hydrate.ShowcaseStale, "prioritized-showcase-stale"},
	} {
		f := newCarouselFixture(t)
		src := f.deps.Sources.(*fakeV1Sources)
		src.showcase = c.showcase
		_, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{})
		if got := fallback.Reason(err); got != c.want {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.want)
		}
		if !reflect.DeepEqual(src.showcaseAsked, [][]int{{60}}) {
			t.Errorf("%s: showcase reads %v, want [[60]]", c.name, src.showcaseAsked)
		}
		if len(f.sql) != 0 {
			t.Errorf("%s: %d page queries before falling back", c.name, len(f.sql))
		}
	}

	// Uncurated: the Postgres page, as before the guard.
	f := newCarouselFixture(t)
	f.rows = []RawImage{infRow(31, 700), infRow(30, 700)}
	j, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{})
	if err != nil {
		t.Fatalf("uncurated: %v (%s)", err, fallback.Reason(err))
	}
	if got := itemIDs(j); !reflect.DeepEqual(got, []float64{31, 30}) {
		t.Errorf("uncurated: ids %v, want [31 30]", got)
	}
	if src := f.deps.Sources.(*fakeV1Sources); !reflect.DeepEqual(src.showcaseAsked, [][]int{{60}}) {
		t.Errorf("uncurated: showcase reads %v, want [[60]]", src.showcaseAsked)
	}

	// No version: Node reads no showcase (`prioritizedUserIds?.length && modelVersionId`), so neither
	// does this port, curated or not.
	f = newCarouselFixture(t)
	src := f.deps.Sources.(*fakeV1Sources)
	src.showcase = hydrate.ShowcaseCurated
	m := carouselInput()
	delete(m, "modelVersionId")
	m["modelId"] = num("50")
	if _, _, _, err := serveInf(t, f, m, InfiniteRequest{}); fallback.Reason(err) == "prioritized-curated-showcase" {
		t.Fatalf("a model alone fell back on the showcase: %v", err)
	}
	if len(src.showcaseAsked) != 0 {
		t.Errorf("a model alone: showcase reads %v, want none", src.showcaseAsked)
	}

	// Without prioritizedUserIds the version gallery is not the carousel: no read.
	f = newCarouselFixture(t)
	src = f.deps.Sources.(*fakeV1Sources)
	src.showcase = hydrate.ShowcaseCurated
	m = carouselInput()
	delete(m, "prioritizedUserIds")
	_, _, _, _ = serveInf(t, f, m, InfiniteRequest{})
	if len(src.showcaseAsked) != 0 {
		t.Errorf("no prioritizedUserIds: showcase reads %v, want none", src.showcaseAsked)
	}
}

// With the miss computation on, a carousel version with no showcase entry is looked up on the
// replica (hydrate.Sources.VersionShowcase, getVersionShowcaseCache's lookup): no row and the
// carousel is the Postgres page; a row falls back as curated; a failed lookup falls back as
// prioritized-showcase-miss-failed.
func TestServeInfinitePrioritizedShowcaseMissComputed(t *testing.T) {
	for _, c := range []struct {
		name    string
		curated bool
		fail    error
		want    string
	}{
		{"no row", false, nil, ""},
		{"a row", true, nil, "prioritized-curated-showcase"},
		{"the lookup fails", false, errors.New("replica down"), "prioritized-showcase-miss-failed"},
	} {
		var bound [][]int
		db := &testkit.DB{Routes: []testkit.Route{{Match: `FROM "ModelVersionShowcaseItem" WHERE "modelVersionId" = ANY($1::int[])`,
			Rows: func(args []any) (*testkit.Rows, error) {
				ids, _ := args[0].([]int)
				bound = append(bound, ids)
				if c.fail != nil {
					return nil, c.fail
				}
				if c.curated {
					return testkit.NewRows([]string{"?column?"}, []any{int32(1)}), nil
				}
				return testkit.NewRows([]string{"?column?"}), nil
			}}}}
		f := newCarouselFixture(t)
		f.rows = []RawImage{infRow(31, 700), infRow(30, 700)}
		src := f.deps.Sources.(*fakeV1Sources)
		// The cache holds no entry for version 60.
		src.showcaseFrom = &hydrate.Sources{Packed: &hydrate.PackedReader{Redis: testkit.NewRedis()}, Replica: db, Compute: &hydrate.MissCompute{}}
		j, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{})
		if got := fallback.Reason(err); got != c.want {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.want)
		}
		if c.want == "" {
			if got := itemIDs(j); !reflect.DeepEqual(got, []float64{31, 30}) {
				t.Errorf("%s: ids %v, want [31 30]", c.name, got)
			}
		} else if len(f.sql) != 0 {
			t.Errorf("%s: %d page queries before falling back", c.name, len(f.sql))
		}
		if !reflect.DeepEqual(bound, [][]int{{60}}) {
			t.Errorf("%s: lookups bound %v, want [[60]]", c.name, bound)
		}
	}

	// Without the computation the same miss still falls back.
	f := newCarouselFixture(t)
	f.deps.Sources.(*fakeV1Sources).showcaseFrom = &hydrate.Sources{Packed: &hydrate.PackedReader{Redis: testkit.NewRedis()}}
	if _, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{}); fallback.Reason(err) != "prioritized-showcase-miss" {
		t.Errorf("no computation: reason %q (%v), want prioritized-showcase-miss", fallback.Reason(err), err)
	}
}

// A failed read of the version's showcase entry, or (with the computation, no entry) of its lag flag,
// is a read failure, never a curation or a miss: prioritized-showcase-miss-failed, nothing looked up
// on the replica. A flag that is set stays the miss.
func TestServeInfinitePrioritizedShowcaseReadFailure(t *testing.T) {
	failing := func(key string) *testkit.Redis {
		r := testkit.NewRedis()
		r.KeyErr = func(k string) error {
			if k == key {
				return testkit.ErrDown
			}
			return nil
		}
		return r
	}
	flagged := testkit.NewRedis()
	flagged.SetString("lag-helper:modelVersion:60", []byte("1"))
	for _, c := range []struct {
		name string
		r    *testkit.Redis
		want string
	}{
		{"the showcase GET fails", failing(hydrate.KeyVersionShowcase + ":60"), "prioritized-showcase-miss-failed"},
		{"the lag flag read fails", failing("lag-helper:modelVersion:60"), "prioritized-showcase-miss-failed"},
		{"the lag flag set", flagged, "prioritized-showcase-miss"},
	} {
		var bound [][]int
		db := &testkit.DB{Routes: []testkit.Route{{Match: `FROM "ModelVersionShowcaseItem" WHERE "modelVersionId" = ANY($1::int[])`,
			Rows: func(args []any) (*testkit.Rows, error) {
				ids, _ := args[0].([]int)
				bound = append(bound, ids)
				return testkit.NewRows([]string{"?column?"}), nil
			}}}}
		f := newCarouselFixture(t)
		f.rows = []RawImage{infRow(31, 700), infRow(30, 700)}
		f.deps.Sources.(*fakeV1Sources).showcaseFrom = &hydrate.Sources{Packed: &hydrate.PackedReader{Redis: c.r}, Replica: db, Compute: &hydrate.MissCompute{}}
		if _, _, _, err := serveInf(t, f, carouselInput(), InfiniteRequest{}); fallback.Reason(err) != c.want {
			t.Errorf("%s: reason %q (%v), want %q", c.name, fallback.Reason(err), err, c.want)
		}
		if len(bound) != 0 {
			t.Errorf("%s: lookups bound %v, want none", c.name, bound)
		}
	}
}
