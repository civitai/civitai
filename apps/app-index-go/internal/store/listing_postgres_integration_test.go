//go:build integration

package store

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/pgtest"
)

func (p *ListingsPostgres) setFailBeforeCommit(f func(op string) error) { p.beforeCommit = f }

func TestIntegrationListingsPostgresContract(t *testing.T) {
	runListingsContract(t, func(t *testing.T) listingsTestStore {
		s, err := NewListingsPostgres(context.Background(), pgtest.Pool(t))
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
}

// The two streams share a database and nothing else: their generations, cursors, rows and
// consumer locks are separate, so one switching over, resetting or holding its lock never touches
// the other (the app index's /search included).
func TestIntegrationListingsBesideTheAppIndex(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()
	apps, err := NewPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	ls, err := NewListingsPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	ag := mustBuilding(t, apps)
	mustApply(t, apps, ag.ID, upsert(catalog[0], ""), upsert(catalog[1], ""))
	mustLive(t, apps, ag.ID, "A1")

	lg, err := ls.NewBuilding(ctx, listingSchemaURN, 1)
	if err != nil {
		t.Fatal(err)
	}
	mustApply(t, ls, lg.ID, listingUpsert(mustListing("alpha", "Alpha"), ""))
	if st := mustState(t, ls); st.Serving != nil || st.Building == nil || st.Building.ID != lg.ID {
		t.Fatalf("listings state %+v: the app index's serving generation leaked in", st)
	}
	if !mustLive(t, ls, lg.ID, "L1") {
		t.Fatal("the listings Live did not promote its own building generation")
	}
	// A rebuild of the app index retires only its own generations.
	ag2 := mustBuilding(t, apps)
	mustApply(t, apps, ag2.ID, upsert(catalog[2], ""))
	mustLive(t, apps, ag2.ID, "A2")
	if st := mustState(t, ls); st.Serving == nil || st.Serving.ID != lg.ID || st.Serving.Cursor != "L1" {
		t.Fatalf("listings serving %+v after an app index switch", st.Serving)
	}
	if n := mustCount(t, ls, lg.ID); n != 1 {
		t.Fatalf("listings count %d after an app index switch, want 1", n)
	}
	if got := slugs(t, apps, Query{}); !slices.Equal(got, []string{"beta-paint"}) {
		t.Fatalf("app search %v, want [beta-paint]", got)
	}
	// Each holds its own consumer lock.
	ua, err := apps.Lock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer ua()
	ul, err := ls.Lock(ctx)
	if err != nil {
		t.Fatalf("listings lock while the app index holds its own: %v", err)
	}
	defer ul()
	ls2, err := NewListingsPostgres(ctx, pool)
	if err != nil {
		t.Fatalf("second start: %v", err)
	}
	if _, err := ls2.Lock(ctx); !errors.Is(err, ErrLocked) {
		t.Fatalf("a second listings consumer locked: %v, want ErrLocked", err)
	}
}

// A database slice 2 created still has app_index_listing_media. Starting drops it and keeps every
// listing, whose media are read from its body.
func TestIntegrationListingsDropsTheMediaTable(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()
	ls, err := NewListingsPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	g, err := ls.NewBuilding(ctx, listingSchemaURN, 1)
	if err != nil {
		t.Fatal(err)
	}
	mustApply(t, ls, g.ID, listingUpsert(mustListing("alpha", "Alpha"), ""))
	// The slice 2 table, as it was created, with a row in it.
	if _, err := pool.Exec(ctx, `
CREATE TABLE app_index_listing_media (
  generation bigint NOT NULL, urn text NOT NULL, position integer NOT NULL, slot text NOT NULL, host text NOT NULL,
  url text NOT NULL, nsfw_level bigint NOT NULL, rating text NOT NULL, caption text, cover_url text,
  PRIMARY KEY (generation, urn, position),
  FOREIGN KEY (generation, urn) REFERENCES app_index_listings (generation, urn) ON DELETE CASCADE)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO app_index_listing_media VALUES ($1, $2, 0, 'icon', 'any', 'u', 1, 'pg', NULL, NULL)`,
		g.ID, listingURN("alpha")); err != nil {
		t.Fatal(err)
	}
	ls2, err := NewListingsPostgres(ctx, pool)
	if err != nil {
		t.Fatalf("restart over a slice 2 database: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'app_index_listing_media'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("app_index_listing_media still exists (%d, %v)", n, err)
	}
	l, ok := mustGet(t, ls2, g.ID, listingURN("alpha"))
	if !ok {
		t.Fatal("the listing was lost")
	}
	checkListing(t, l, "alpha", "Alpha")
}
