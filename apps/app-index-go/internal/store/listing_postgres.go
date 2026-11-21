package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// listingsSQL creates the listings read model's tables, beside the app index's and never joined to
// them: its own cursor table (so its generations, cursor and consumer lock are its own) and one row
// per listing. Like schemaSQL it is a rebuildable cache, created at startup and never migrated by
// hand: a change to what a row holds is a ListingsLayoutVersion bump in the consumer, which
// rebuilds beside. Created only when APP_INDEX_LISTINGS is on.
//
// The stats columns are nullable: a counter the body does not carry as a count is stored null and
// the listing kept (store.ListingStats).
//
// The media live in the body only, every item as the stream sent it, each with its own nsfwLevel,
// rating and host; a read decodes them from it (decodeStored). Nothing here applies a ceiling: the
// read API does, per request (listingread.ProjectMedia). The DROP below removes
// app_index_listing_media, a per-item copy of the media that an earlier layout wrote and nothing
// read, from a database that still has it.
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
  listing_content_rating text,
  creator_id bigint,
  created_at timestamptz,
  updated_at timestamptz,
  recommended_count bigint,
  not_recommended_count bigint,
  review_count bigint,
  open_count bigint,
  install_count bigint,
  PRIMARY KEY (generation, urn)
);
DROP TABLE IF EXISTS app_index_listing_media;
CREATE INDEX IF NOT EXISTS app_index_listings_slug ON app_index_listings (generation, slug);
ALTER TABLE app_index_listings ADD COLUMN IF NOT EXISTS listing_content_rating text;
ALTER TABLE app_index_listings
  ALTER COLUMN recommended_count DROP NOT NULL,
  ALTER COLUMN not_recommended_count DROP NOT NULL,
  ALTER COLUMN review_count DROP NOT NULL,
  ALTER COLUMN install_count DROP NOT NULL;
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

// Apply implements Generations: the listing row and the cursor commit together, or neither does.
// An upsert replaces the row, body (and so media) included.
func (p *ListingsPostgres) Apply(ctx context.Context, gen int64, c Change) error {
	return p.apply(ctx, gen, c, func(tx pgx.Tx) error {
		l := c.Listing
		if _, err := tx.Exec(ctx, `DELETE FROM app_index_listings WHERE generation = $1 AND urn = $2`, gen, l.URN); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
INSERT INTO app_index_listings (generation, urn, rev, body, app, slug, name, name_key, kind, category, content_rating,
  creator_id, created_at, updated_at, recommended_count, not_recommended_count, review_count, open_count, install_count,
  listing_content_rating)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULLIF($10, ''), NULLIF($11, ''), $12, $13, $14, $15, $16, $17, $18, $19,
  NULLIF($20, ''))`,
			gen, l.URN, l.Rev, []byte(l.Body), l.App, l.Slug, l.Name, nameKey(l.Name), l.Kind, l.Category, l.ContentRating,
			l.CreatorID, l.CreatedAt, l.UpdatedAt, l.Stats.RecommendedCount, l.Stats.NotRecommendedCount,
			l.Stats.ReviewCount, l.Stats.OpenCount, l.Stats.InstallCount, l.ListingContentRating)
		return err
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

// stillThere is ErrNoGeneration unless gen exists and is not retired. Every read calls it AFTER
// reading, not before: a generation switch drops the old generation's rows in one transaction, so a
// read that raced it may have seen none of them, and only a check after the read can tell that
// empty answer from a real one. A read that saw the rows and then lost the race is also refused, so
// the API never mixes two reads of different generations into one answer (it answers 503).
func (p *ListingsPostgres) stillThere(ctx context.Context, gen int64) error {
	var ok bool
	if err := p.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM app_index_listing_cursors
WHERE generation = $1 AND state <> 'retired')`, gen).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return ErrNoGeneration
	}
	return nil
}

// Get implements Listings.
func (p *ListingsPostgres) Get(ctx context.Context, gen int64, urn string) (Listing, bool, error) {
	return p.one(ctx, gen, `urn = $2`, urn)
}

// BySlug implements Listings. The lowest URN wins; a slug names one URN in practice.
func (p *ListingsPostgres) BySlug(ctx context.Context, gen int64, slug string) (Listing, bool, error) {
	return p.one(ctx, gen, `slug = $2`, slug)
}

func (p *ListingsPostgres) one(ctx context.Context, gen int64, where string, arg string) (Listing, bool, error) {
	var urn, rev string
	var body []byte
	err := p.pool.QueryRow(ctx, `SELECT urn, rev, body FROM app_index_listings WHERE generation = $1 AND `+where+
		` ORDER BY urn LIMIT 1`, gen, arg).Scan(&urn, &rev, &body)
	found := !errors.Is(err, pgx.ErrNoRows)
	if found && err != nil {
		return Listing{}, false, err
	}
	if err := p.stillThere(ctx, gen); err != nil {
		return Listing{}, false, err
	}
	if !found {
		return Listing{}, false, nil
	}
	l, err := decodeStored(urn, rev, body)
	return l, err == nil, err
}

// GetMany implements Listings.
func (p *ListingsPostgres) GetMany(ctx context.Context, gen int64, urns []string) ([]Listing, error) {
	rows, err := p.pool.Query(ctx, `SELECT urn, rev, body FROM app_index_listings WHERE generation = $1 AND urn = ANY($2)`, gen, urns)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Listing
	for rows.Next() {
		var urn, rev string
		var body []byte
		if err := rows.Scan(&urn, &rev, &body); err != nil {
			return nil, err
		}
		l, err := decodeStored(urn, rev, body)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := p.stillThere(ctx, gen); err != nil {
		return nil, err
	}
	return out, nil
}

// Keys implements Listings.
func (p *ListingsPostgres) Keys(ctx context.Context, gen int64) ([]Listing, error) {
	rows, err := p.pool.Query(ctx, `
SELECT urn, rev, app, slug, name, kind, coalesce(category, ''), coalesce(content_rating, ''),
  coalesce(listing_content_rating, ''), creator_id, created_at, updated_at, recommended_count, not_recommended_count,
  review_count, open_count, install_count
FROM app_index_listings WHERE generation = $1`, gen)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Listing
	for rows.Next() {
		var l Listing
		if err := rows.Scan(&l.URN, &l.Rev, &l.App, &l.Slug, &l.Name, &l.Kind, &l.Category, &l.ContentRating,
			&l.ListingContentRating, &l.CreatorID,
			&l.CreatedAt, &l.UpdatedAt, &l.Stats.RecommendedCount, &l.Stats.NotRecommendedCount, &l.Stats.ReviewCount,
			&l.Stats.OpenCount, &l.Stats.InstallCount); err != nil {
			return nil, err
		}
		for _, t := range []**time.Time{&l.CreatedAt, &l.UpdatedAt} {
			if *t != nil {
				u := (*t).UTC()
				*t = &u
			}
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := p.stillThere(ctx, gen); err != nil {
		return nil, err
	}
	return out, nil
}
