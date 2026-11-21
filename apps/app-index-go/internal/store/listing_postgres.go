package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// listingsSQL creates the listings read model's tables, beside the app index's and never joined to
// them: its own cursor table (so its generations, cursor and consumer lock are its own), one row
// per listing, and one row per media item. Like schemaSQL it is a rebuildable cache, created at
// startup and never migrated by hand: a change to what a row holds is a ListingsLayoutVersion bump
// in the consumer, which rebuilds beside. Created only when APP_INDEX_LISTINGS is on.
//
// app_index_listing_media holds every item exactly as the stream sent it, each with its own
// nsfw_level, rating and host. Nothing here applies a ceiling: the read API must (ListingMedia).
const listingsSQL = `
CREATE TABLE IF NOT EXISTS app_index_listing_cursors (
  generation bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schema text NOT NULL,
  layout integer NOT NULL,
  cursor text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('building', 'serving', 'retired')),
  owner text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_index_listing_cursors_one_per_state
  ON app_index_listing_cursors (state) WHERE state IN ('building', 'serving');
CREATE TABLE IF NOT EXISTS app_index_listings (
  generation bigint NOT NULL REFERENCES app_index_listing_cursors (generation) ON DELETE CASCADE,
  urn text NOT NULL,
  rev text NOT NULL,
  body jsonb NOT NULL,
  app text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  name_key text NOT NULL,
  kind text NOT NULL,
  category text,
  content_rating text,
  creator_id bigint,
  created_at timestamptz,
  updated_at timestamptz,
  recommended_count bigint NOT NULL,
  not_recommended_count bigint NOT NULL,
  review_count bigint NOT NULL,
  open_count bigint,
  install_count bigint NOT NULL,
  PRIMARY KEY (generation, urn)
);
CREATE TABLE IF NOT EXISTS app_index_listing_media (
  generation bigint NOT NULL,
  urn text NOT NULL,
  position integer NOT NULL,
  slot text NOT NULL,
  host text NOT NULL,
  url text NOT NULL,
  nsfw_level bigint NOT NULL,
  rating text NOT NULL,
  caption text,
  cover_url text,
  PRIMARY KEY (generation, urn, position),
  FOREIGN KEY (generation, urn) REFERENCES app_index_listings (generation, urn) ON DELETE CASCADE
);
`

// listingTables are the listings read model's tables; its consumer lock is its own, so it never
// contends with the app index's.
var listingTables = pgTables{
	cursors: "app_index_listing_cursors",
	rows:    "app_index_listings",
	lock:    `hashtext(current_schema() || ':app-index-go:listings')`,
}

// ListingsPostgres is the production Listings.
type ListingsPostgres struct {
	*pgGens
}

// NewListingsPostgres creates the listings tables if they are missing, drops leftover retired
// generations and returns the store. The pool's search_path decides the schema.
func NewListingsPostgres(ctx context.Context, pool *pgxpool.Pool) (*ListingsPostgres, error) {
	g, err := newPgGens(pool, listingTables)
	if err != nil {
		return nil, err
	}
	if err := g.create(ctx, listingsSQL); err != nil {
		return nil, err
	}
	return &ListingsPostgres{g}, nil
}

// Apply implements Generations: the listing row, its media and the cursor commit together, or
// none does. An upsert replaces the row and all of its media.
func (p *ListingsPostgres) Apply(ctx context.Context, gen int64, c Change) error {
	return p.apply(ctx, gen, c, func(tx pgx.Tx) error {
		l := c.Listing
		// Deleting first drops the old media (ON DELETE CASCADE), so a whole-row replace never
		// leaves an item the new body no longer has.
		if _, err := tx.Exec(ctx, `DELETE FROM app_index_listings WHERE generation = $1 AND urn = $2`, gen, l.URN); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
INSERT INTO app_index_listings (generation, urn, rev, body, app, slug, name, name_key, kind, category, content_rating,
  creator_id, created_at, updated_at, recommended_count, not_recommended_count, review_count, open_count, install_count)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''), $12, $13, $14, $15, $16, $17, $18, $19)`,
			gen, l.URN, l.Rev, []byte(l.Body), l.App, l.Slug, l.Name, nameKey(l.Name), l.Kind, l.Category, l.ContentRating,
			l.CreatorID, l.CreatedAt, l.UpdatedAt, l.Stats.RecommendedCount, l.Stats.NotRecommendedCount,
			l.Stats.ReviewCount, l.Stats.OpenCount, l.Stats.InstallCount)
		if err != nil {
			return err
		}
		for _, m := range l.Media {
			_, err := tx.Exec(ctx, `
INSERT INTO app_index_listing_media (generation, urn, position, slot, host, url, nsfw_level, rating, caption, cover_url)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), NULLIF($10, ''))`,
				gen, l.URN, m.Position, m.Slot, m.Host, m.URL, m.NsfwLevel, m.Rating, m.Caption, m.CoverURL)
			if err != nil {
				return err
			}
		}
		return nil
	})
}

// Count implements Listings.
func (p *ListingsPostgres) Count(ctx context.Context, gen int64) (int, error) {
	var n int
	err := p.pool.QueryRow(ctx, `
SELECT count(l.urn) FROM app_index_listing_cursors g LEFT JOIN app_index_listings l ON l.generation = g.generation
WHERE g.generation = $1 AND g.state <> 'retired' GROUP BY g.generation`, gen).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNoGeneration
	}
	return n, err
}

// Get implements Listings.
func (p *ListingsPostgres) Get(ctx context.Context, gen int64, urn string) (Listing, bool, error) {
	var l Listing
	var body []byte
	err := p.pool.QueryRow(ctx, `
SELECT urn, rev, body, app, slug, name, kind, coalesce(category, ''), coalesce(content_rating, ''), creator_id,
  created_at, updated_at, recommended_count, not_recommended_count, review_count, open_count, install_count
FROM app_index_listings WHERE generation = $1 AND urn = $2`, gen, urn).Scan(
		&l.URN, &l.Rev, &body, &l.App, &l.Slug, &l.Name, &l.Kind, &l.Category, &l.ContentRating, &l.CreatorID,
		&l.CreatedAt, &l.UpdatedAt, &l.Stats.RecommendedCount, &l.Stats.NotRecommendedCount, &l.Stats.ReviewCount,
		&l.Stats.OpenCount, &l.Stats.InstallCount)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := p.Count(ctx, gen); err != nil {
			return Listing{}, false, err
		}
		return Listing{}, false, nil
	}
	if err != nil {
		return Listing{}, false, err
	}
	l.Body = body
	if l.CreatedAt != nil {
		t := l.CreatedAt.UTC()
		l.CreatedAt = &t
	}
	if l.UpdatedAt != nil {
		t := l.UpdatedAt.UTC()
		l.UpdatedAt = &t
	}
	rows, err := p.pool.Query(ctx, `
SELECT position, slot, host, url, nsfw_level, rating, coalesce(caption, ''), coalesce(cover_url, '')
FROM app_index_listing_media WHERE generation = $1 AND urn = $2 ORDER BY position`, gen, urn)
	if err != nil {
		return Listing{}, false, err
	}
	defer rows.Close()
	l.Media = []ListingMedia{}
	for rows.Next() {
		var m ListingMedia
		if err := rows.Scan(&m.Position, &m.Slot, &m.Host, &m.URL, &m.NsfwLevel, &m.Rating, &m.Caption, &m.CoverURL); err != nil {
			return Listing{}, false, err
		}
		l.Media = append(l.Media, m)
	}
	return l, true, rows.Err()
}
