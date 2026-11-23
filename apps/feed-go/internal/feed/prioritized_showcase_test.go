package feed

import (
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

// getAllImages reads the version's curated showcase for a prioritizedUserIds request with a
// modelVersionId (getCarouselShowcaseIds, src/server/services/image.service.ts) and, curated, serves
// that list in its order. Not ported: the guard hands a curated version, a failed read (both
// ShowcaseCurated) or an uncached entry (ShowcaseUnknown) to Node (DESIGN.md §16.9).
func TestServeInfinitePrioritizedCuratedShowcase(t *testing.T) {
	for _, c := range []struct {
		name     string
		showcase hydrate.Showcase
		want     string
	}{
		{"curated", hydrate.ShowcaseCurated, "prioritized-curated-showcase"},
		{"not cached", hydrate.ShowcaseUnknown, "prioritized-showcase-miss"},
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
