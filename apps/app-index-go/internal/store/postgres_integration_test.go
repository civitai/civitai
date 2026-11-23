//go:build integration

package store

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/pgtest"
)

func (p *Postgres) setFailBeforeCommit(f func(op string) error) { p.beforeCommit = f }

// newTestPostgres is a Postgres store on a fresh schema (pgtest.Pool).
func newTestPostgres(t *testing.T) *Postgres {
	t.Helper()
	s, err := NewPostgres(context.Background(), pgtest.Pool(t))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestIntegrationPostgresContract(t *testing.T) {
	runContract(t, func(t *testing.T) testStore { return newTestPostgres(t) })
}

func TestIntegrationPostgresSchemaIsIdempotent(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()
	s1, err := NewPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	g := mustBuilding(t, s1)
	mustApply(t, s1, g.ID, upsert(catalog[0], "c1"))
	mustLive(t, s1, g.ID, "L1")
	s2, err := NewPostgres(ctx, pool)
	if err != nil {
		t.Fatalf("second start: %v", err)
	}
	if st := mustState(t, s2); st.Serving == nil || st.Serving.Cursor != "L1" {
		t.Fatalf("restart lost the index: %+v", st.Serving)
	}
}

// The relevance ORDER is Postgres's own (ts_rank), so it is pinned here and not in the contract.
func TestIntegrationPostgresRelevanceOrder(t *testing.T) {
	s := newTestPostgres(t)
	g := mustBuilding(t, s)
	for _, f := range catalog {
		mustApply(t, s, g.ID, upsert(f, ""))
	}
	mustLive(t, s, g.ID, "L")
	// A name match (weight A) outranks a tagline match (B), which outranks a creator match (C).
	got := slugs(t, s, Query{Text: "pix"})
	if want := []string{"pixel-forge", "gamma-tools", "echo-music"}; !slices.Equal(got, want) {
		t.Fatalf("relevance = %v, want %v", got, want)
	}
}

func TestIntegrationPostgresLockIsExclusive(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()
	s1, err := NewPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	s2, err := NewPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	unlock, err := s1.Lock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s2.Lock(ctx); !errors.Is(err, ErrLocked) {
		t.Fatalf("second lock: %v, want ErrLocked", err)
	}
	unlock()
	unlock2, err := s2.Lock(ctx)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	unlock2()
}

func TestIntegrationPostgresWritesAreFenced(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()
	s1, err := NewPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	s2, err := NewPostgres(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	g := mustBuilding(t, s1)
	mustApply(t, s1, g.ID, upsert(catalog[0], "c1"))
	if err := s2.Claim(ctx, g.ID); err != nil {
		t.Fatal(err)
	}
	if err := s1.Apply(ctx, g.ID, upsert(catalog[1], "c2")); !errors.Is(err, ErrFenced) {
		t.Fatalf("superseded writer: %v, want ErrFenced", err)
	}
	if _, err := s1.Live(ctx, g.ID, "L"); !errors.Is(err, ErrFenced) {
		t.Fatalf("superseded writer live: %v, want ErrFenced", err)
	}
	mustApply(t, s2, g.ID, upsert(catalog[1], "c3"))
	if c := mustState(t, s2).Building.Cursor; c != "c3" {
		t.Fatalf("cursor %q", c)
	}
}

// layout1SQL is app_index_apps as layout 1 created it, before listing_rating and listing_rated.
const layout1SQL = `
CREATE TABLE app_index_cursors (
  generation bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schema text NOT NULL,
  layout integer NOT NULL,
  cursor text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('building', 'serving', 'retired')),
  owner text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_index_apps (
  generation bigint NOT NULL REFERENCES app_index_cursors (generation) ON DELETE CASCADE,
  urn text NOT NULL,
  rev text NOT NULL,
  body jsonb NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  name_key text NOT NULL,
  kind text NOT NULL,
  category text,
  rating text,
  creator text,
  tagline text,
  icon_url text,
  release text,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', name), 'A') ||
    setweight(to_tsvector('simple', slug), 'B') ||
    setweight(to_tsvector('simple', coalesce(tagline, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(creator, '')), 'C')
  ) STORED,
  PRIMARY KEY (generation, urn)
);
INSERT INTO app_index_cursors (schema, layout, cursor, state) VALUES ('urn:schema:apps.civitai.com:app@v1', 1, 'L1', 'serving');
INSERT INTO app_index_apps (generation, urn, rev, body, slug, name, name_key, kind, rating) VALUES
  (1, 'urn:apps.civitai.com:app/old-x', 'r1', '{"slug":"old-x","name":"old-x","kind":"onsite","contentRating":"x","listingContentRating":null}', 'old-x', 'old-x', 'old-x', 'onsite', 'x'),
  (1, 'urn:apps.civitai.com:app/old-null', 'r2', '{"slug":"old-null","name":"old-null","kind":"onsite","contentRating":null}', 'old-null', 'old-null', 'old-null', 'onsite', NULL);
`

// A database a layout 1 index created gains the new columns at startup, and the rows it holds are
// filtered on their rating exactly as before (listing_rated false), even one whose stored body
// carries listingContentRating: layout 1 never read it, so only the layout 2 rebuild beside it
// (index.LayoutVersion) changes what they answer.
func TestIntegrationPostgresLayout1RowsKeepTheirRating(t *testing.T) {
	pool := pgtest.Pool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, layout1SQL); err != nil {
		t.Fatal(err)
	}
	s, err := NewPostgres(ctx, pool)
	if err != nil {
		t.Fatalf("start over layout 1: %v", err)
	}
	if got := slugs(t, s, Query{}); !slices.Equal(got, []string{"old-null"}) {
		t.Errorf("SFW over layout 1 rows = %v, want [old-null]", got)
	}
	if got := slugs(t, s, Query{Mature: Mature{X: true}}); !slices.Equal(got, []string{"old-null", "old-x"}) {
		t.Errorf("X over layout 1 rows = %v, want [old-null old-x]", got)
	}
	// A row written now, into the same generation, is filtered on its listing's rating.
	if err := s.Claim(ctx, 1); err != nil {
		t.Fatal(err)
	}
	mustApply(t, s, 1, Change{Kind: ChangeUpsert, App: listedApp("new-x", "x", nil), Cursor: "c2"})
	if got := slugs(t, s, Query{}); !slices.Equal(got, []string{"new-x", "old-null"}) {
		t.Errorf("SFW after a layout 2 write = %v, want [new-x old-null]", got)
	}
}
