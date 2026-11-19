//go:build integration

package store

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/pgtest"
)

func (p *Postgres) setFailBeforeCommit(f func(op string) error) { p.beforeCommit = f }
func (p *Postgres) setNow(f func() time.Time)                   { p.now = f }

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
	got := slugs(t, s, Query{Text: "pix", Sort: SortRelevance})
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
