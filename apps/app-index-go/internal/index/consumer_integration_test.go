//go:build integration

package index

import (
	"context"
	"net/http"
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/pgtest"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

func TestIntegrationScenariosPostgres(t *testing.T) {
	runScenarios(t, func(t *testing.T) store.Store {
		s, err := store.NewPostgres(context.Background(), pgtest.Pool(t))
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
}

func TestIntegrationListingScenariosPostgres(t *testing.T) {
	runListingScenarios(t, func(t *testing.T) store.Listings {
		s, err := store.NewListingsPostgres(context.Background(), pgtest.Pool(t))
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
}

// The stale mark lives in the store, not in the process: a listings store reopened over the same
// database (a restart, or another replica's API) still answers not-ready while the serving
// generation holds a stale row, and the consumer that resumes from the stored cursor ends it with
// a delete of that listing.
func TestIntegrationStaleRowSurvivesARestart(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()
	st, err := store.NewListingsPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	h := startListings(t, st)
	c := h.reg.next(t)
	c.listing(t, "alpha", "Alpha")
	c.listing(t, "beta", "Beta")
	c.live(t, "L1")
	h.servingCursorIs(t, "L1")
	c.invalidListing(t, "alpha", "c1")
	h.servingCursorIs(t, "c1")
	h.cancel()
	<-h.done

	reopened, err := store.NewListingsPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	wantListingsStatus(t, reopened, "after a restart with a stale row", http.StatusServiceUnavailable)

	h2 := startListings(t, reopened)
	c2 := h2.reg.next(t)
	if c2.cursor != "c1" {
		t.Fatalf("resumed from %q, want c1", c2.cursor)
	}
	// The restarted consumer reads the mark from the store before it applies anything.
	h2.staleGaugeIs(t, 1)
	c2.delListing(t, "alpha", "c2")
	h2.servingCursorIs(t, "c2")
	wantListingsStatus(t, reopened, "after a delete of the stale listing", http.StatusOK)
	h2.staleGaugeIs(t, 0)
}
