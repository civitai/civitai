package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// schemaSQL creates the index's tables. The service owns its database: this is a rebuildable
// cache, so the tables are created here at startup, idempotently, and never migrated by hand. A
// change to what a row holds is a LayoutVersion bump in the consumer, which rebuilds beside.
//
// app_index_cursors is the cursor table: one row per generation, holding its subscription's cursor
// and whether it is building, serving or retired. The partial unique index keeps at most one
// generation building and one serving. owner fences writes to the process that claimed the
// generation (see Postgres.Lock).
const schemaSQL = `
CREATE TABLE IF NOT EXISTS app_index_cursors (
  generation bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schema text NOT NULL,
  layout integer NOT NULL,
  cursor text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('building', 'serving', 'retired')),
  owner text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_index_cursors_one_per_state
  ON app_index_cursors (state) WHERE state IN ('building', 'serving');
CREATE TABLE IF NOT EXISTS app_index_apps (
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
  first_seen_us bigint NOT NULL,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', name), 'A') ||
    setweight(to_tsvector('simple', slug), 'B') ||
    setweight(to_tsvector('simple', coalesce(tagline, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(creator, '')), 'C')
  ) STORED,
  PRIMARY KEY (generation, urn)
);
CREATE INDEX IF NOT EXISTS app_index_apps_search ON app_index_apps USING gin (search);
CREATE INDEX IF NOT EXISTS app_index_apps_by_name
  ON app_index_apps (generation, name_key COLLATE "C", urn COLLATE "C");
CREATE INDEX IF NOT EXISTS app_index_apps_by_seen
  ON app_index_apps (generation, first_seen_us DESC, urn COLLATE "C" DESC);
`

// lockKey is the advisory lock a consumer holds, per schema so that separate schemas of one
// database (tests) do not contend.
const lockKey = `hashtext(current_schema() || ':app-index-go')`

// ErrLocked is returned by Lock while another process holds the consumer lock.
var ErrLocked = errors.New("store: another consumer holds the lock")

// ErrFenced is returned by a write to a generation another process has claimed since.
var ErrFenced = errors.New("store: generation claimed by another consumer")

// Postgres is the production Store.
type Postgres struct {
	pool  *pgxpool.Pool
	owner string
	now   func() time.Time

	// beforeCommit, when set, is called where a write transaction would commit; an error rolls it
	// back. Tests use it to stand in for a crash between a change and its commit.
	beforeCommit func(op string) error
}

// NewPostgres creates the tables if they are missing, drops leftover retired generations and
// returns the store. The pool's search_path decides the schema.
func NewPostgres(ctx context.Context, pool *pgxpool.Pool) (*Postgres, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, err
	}
	p := &Postgres{pool: pool, owner: hex.EncodeToString(b[:]), now: time.Now}
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		// Serializes two processes starting at once: concurrent CREATE ... IF NOT EXISTS can race.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(`+lockKey+` + 1)`); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, schemaSQL)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("create schema: %w", err)
	}
	if err := p.dropRetired(ctx); err != nil {
		return nil, err
	}
	return p, nil
}

// Lock takes the consumer lock: only its holder follows the registry and writes, so two processes
// (a rolling update) never interleave cursors. Searches need no lock. ErrLocked while another
// process holds it. The lock lives on a dedicated connection; the returned func releases it. As a
// second line, every write is fenced to the process that last claimed its generation (Claim), so
// a holder whose lock connection silently dropped cannot write after another took over.
func (p *Postgres) Lock(ctx context.Context) (func(), error) {
	conn, err := p.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	var ok bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(`+lockKey+`)`).Scan(&ok); err != nil {
		conn.Release()
		return nil, err
	}
	if !ok {
		conn.Release()
		return nil, ErrLocked
	}
	//nolint:contextcheck // the release runs after the caller's context has ended, so it has its own
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = conn.Exec(ctx, `SELECT pg_advisory_unlock(`+lockKey+`)`)
		conn.Release()
	}, nil
}

// Claim makes this process the writer of gen; writes by any earlier claimant fail with ErrFenced.
func (p *Postgres) Claim(ctx context.Context, gen int64) error {
	tag, err := p.pool.Exec(ctx, `UPDATE app_index_cursors SET owner = $1 WHERE generation = $2 AND state <> 'retired'`, p.owner, gen)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoGeneration
	}
	return nil
}

func (p *Postgres) commit(ctx context.Context, tx pgx.Tx, op string) error {
	if p.beforeCommit != nil {
		if err := p.beforeCommit(op); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// write runs fn in a transaction that first stores gen's cursor, failing with ErrFenced when gen
// is no longer this process's. Storing the cursor first takes the generation row's lock, so
// writes to one generation are serialized. It returns the generation's state.
func (p *Postgres) write(ctx context.Context, op string, gen int64, cursor string, fn func(tx pgx.Tx, state string) error) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var state, owner string
	err = tx.QueryRow(ctx, `
UPDATE app_index_cursors SET cursor = $1, updated_at = now()
WHERE generation = $2 AND state <> 'retired' AND owner = $3
RETURNING state, owner`, cursor, gen, p.owner).Scan(&state, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM app_index_cursors WHERE generation = $1 AND state <> 'retired')`, gen).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return ErrFenced
		}
		return ErrNoGeneration
	}
	if err != nil {
		return err
	}
	if err := fn(tx, state); err != nil {
		return err
	}
	return p.commit(ctx, tx, op)
}

// State implements Store.
func (p *Postgres) State(ctx context.Context) (State, error) {
	rows, err := p.pool.Query(ctx, `SELECT generation, layout, schema, cursor, state FROM app_index_cursors WHERE state IN ('building', 'serving')`)
	if err != nil {
		return State{}, err
	}
	defer rows.Close()
	var st State
	for rows.Next() {
		var g Generation
		if err := rows.Scan(&g.ID, &g.Layout, &g.Schema, &g.Cursor, &g.State); err != nil {
			return State{}, err
		}
		if g.State == StateServing {
			st.Serving = &g
		} else {
			st.Building = &g
		}
	}
	return st, rows.Err()
}

// NewBuilding implements Store. The new generation is claimed by this process.
func (p *Postgres) NewBuilding(ctx context.Context, schema string, layout int) (Generation, error) {
	g := Generation{Layout: layout, Schema: schema, State: StateBuilding}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Generation{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM app_index_cursors WHERE state = 'building'`); err != nil {
		return Generation{}, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO app_index_cursors (schema, layout, state, owner) VALUES ($1, $2, 'building', $3) RETURNING generation`,
		schema, layout, p.owner).Scan(&g.ID)
	if err != nil {
		return Generation{}, err
	}
	if err := p.commit(ctx, tx, "new-building"); err != nil {
		return Generation{}, err
	}
	return g, nil
}

// Reset implements Store.
func (p *Postgres) Reset(ctx context.Context, gen int64) error {
	return p.write(ctx, "reset", gen, "", func(tx pgx.Tx, _ string) error {
		_, err := tx.Exec(ctx, `DELETE FROM app_index_apps WHERE generation = $1`, gen)
		return err
	})
}

// Apply implements Store: the row change and the cursor commit together, or neither does.
func (p *Postgres) Apply(ctx context.Context, gen int64, c Change) error {
	return p.write(ctx, "apply", gen, c.Cursor, func(tx pgx.Tx, _ string) error {
		switch c.Kind {
		case ChangeUpsert:
			a := c.App
			// A whole-row replace. first_seen_us is kept from this generation's row, else carried
			// from the serving generation's (a rebuild keeps "newest" stable), else now.
			_, err := tx.Exec(ctx, `
INSERT INTO app_index_apps (generation, urn, rev, body, slug, name, name_key, kind, category, rating, creator, tagline, icon_url, release, first_seen_us)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''),
  COALESCE((SELECT s.first_seen_us FROM app_index_apps s JOIN app_index_cursors g ON g.generation = s.generation
            WHERE g.state = 'serving' AND s.urn = $2), $15))
ON CONFLICT (generation, urn) DO UPDATE SET
  rev = EXCLUDED.rev, body = EXCLUDED.body, slug = EXCLUDED.slug, name = EXCLUDED.name, name_key = EXCLUDED.name_key,
  kind = EXCLUDED.kind, category = EXCLUDED.category, rating = EXCLUDED.rating, creator = EXCLUDED.creator,
  tagline = EXCLUDED.tagline, icon_url = EXCLUDED.icon_url, release = EXCLUDED.release`,
				gen, a.URN, a.Rev, []byte(a.Body), a.Slug, a.Name, nameKey(a.Name), a.Kind, a.Category, a.Rating, a.Creator,
				a.Tagline, a.IconURL, a.Release, p.now().UnixMicro())
			return err
		case ChangeDelete:
			_, err := tx.Exec(ctx, `DELETE FROM app_index_apps WHERE generation = $1 AND urn = $2`, gen, c.URN)
			return err
		case ChangeProgress:
			return nil
		}
		return fmt.Errorf("store: unknown change kind %d", c.Kind)
	})
}

// Live implements Store. The switch is one transaction, so a search sees either the old
// generation or the new one, never neither. The old one's rows are deleted after the commit.
func (p *Postgres) Live(ctx context.Context, gen int64, cursor string) (bool, error) {
	promoted := false
	err := p.write(ctx, "live", gen, cursor, func(tx pgx.Tx, state string) error {
		if state != StateBuilding {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE app_index_cursors SET state = 'retired' WHERE state = 'serving'`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE app_index_cursors SET state = 'serving' WHERE generation = $1`, gen); err != nil {
			return err
		}
		promoted = true
		return nil
	})
	if err != nil {
		return false, err
	}
	if promoted {
		if err := p.dropRetired(ctx); err != nil {
			return true, err
		}
	}
	return promoted, nil
}

func (p *Postgres) dropRetired(ctx context.Context) error {
	_, err := p.pool.Exec(ctx, `DELETE FROM app_index_cursors WHERE state = 'retired'`)
	return err
}

// Search implements Store.
func (p *Postgres) Search(ctx context.Context, q Query) (Page, error) {
	tokens := Tokens(q.Text)
	if strings.TrimSpace(q.Text) != "" && len(tokens) == 0 {
		return Page{}, p.servingOrNotReady(ctx)
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	sortBy := q.effectiveSort()
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	where := []string{"g.state = 'serving'"}
	rank := "0::float8"
	if len(tokens) > 0 {
		tsq := "to_tsquery('simple', " + arg(prefixTSQuery(tokens)) + ")"
		where = append(where, "a.search @@ "+tsq)
		rank = "ts_rank(a.search, " + tsq + ")::float8"
	}
	if q.Kind != "" {
		where = append(where, "a.kind = "+arg(q.Kind))
	}
	if q.Category != "" {
		where = append(where, "a.category = "+arg(q.Category))
	}
	var keyset, order string
	switch sortBy {
	case SortRelevance:
		order = `m.rank DESC, m.name_key COLLATE "C", m.urn COLLATE "C"`
		if q.After != nil {
			r, n, u := arg(q.After.Rank), arg(q.After.Name), arg(q.After.URN)
			keyset = `m.rank < ` + r + ` OR (m.rank = ` + r + ` AND (m.name_key COLLATE "C", m.urn COLLATE "C") > (` + n + `, ` + u + `))`
		}
	case SortNewest:
		order = `m.first_seen_us DESC, m.urn COLLATE "C" DESC`
		if q.After != nil {
			keyset = `(m.first_seen_us, m.urn COLLATE "C") < (` + arg(q.After.Seen) + `, ` + arg(q.After.URN) + `)`
		}
	default:
		order = `m.name_key COLLATE "C", m.urn COLLATE "C"`
		if q.After != nil {
			keyset = `(m.name_key COLLATE "C", m.urn COLLATE "C") > (` + arg(q.After.Name) + `, ` + arg(q.After.URN) + `)`
		}
	}
	if keyset == "" {
		keyset = "true"
	}
	sql := `
SELECT m.urn, m.slug, m.name, m.tagline, m.kind, m.category, m.rating, m.icon_url, m.creator, m.name_key, m.first_seen_us, m.rank
FROM (
  SELECT a.urn, a.slug, a.name, coalesce(a.tagline, '') AS tagline, a.kind, coalesce(a.category, '') AS category,
    coalesce(a.rating, '') AS rating, coalesce(a.icon_url, '') AS icon_url, coalesce(a.creator, '') AS creator,
    a.name_key, a.first_seen_us, ` + rank + ` AS rank
  FROM app_index_apps a JOIN app_index_cursors g ON g.generation = a.generation
  WHERE ` + strings.Join(where, " AND ") + `
) m
WHERE ` + keyset + `
ORDER BY ` + order + `
LIMIT ` + arg(limit+1)
	rows, err := p.pool.Query(ctx, sql, args...)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	var page Page
	var keys []Key
	for rows.Next() {
		var r Result
		var k Key
		if err := rows.Scan(&r.URN, &r.Slug, &r.Name, &r.Tagline, &r.Kind, &r.Category, &r.Rating, &r.IconURL, &r.Creator,
			&k.Name, &k.Seen, &k.Rank); err != nil {
			return Page{}, err
		}
		k.URN = r.URN
		page.Results = append(page.Results, r)
		keys = append(keys, k)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	if len(page.Results) > limit {
		page.Results = page.Results[:limit]
		k := keys[limit-1]
		switch sortBy {
		case SortRelevance:
			k.Seen = 0
		case SortNewest:
			k.Rank, k.Name = 0, ""
		default:
			k.Rank, k.Seen = 0, 0
		}
		page.Next = &k
	}
	if len(page.Results) == 0 {
		return Page{}, p.servingOrNotReady(ctx)
	}
	return page, nil
}

// servingOrNotReady tells an empty answer from no index: ErrNotReady when nothing is serving.
func (p *Postgres) servingOrNotReady(ctx context.Context) error {
	var ok bool
	if err := p.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM app_index_cursors WHERE state = 'serving')`).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return ErrNotReady
	}
	return nil
}
