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
// generation building and one serving. owner is the process that last claimed the generation;
// writes check it (see Postgres.Claim for what that guarantees).
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
`

// lockKey is the advisory lock a consumer holds, per schema so that separate schemas of one
// database (tests) do not contend.
const lockKey = `hashtext(current_schema() || ':app-index-go')`

// ErrLocked is returned by Lock while another process holds the consumer lock.
var ErrLocked = errors.New("store: another consumer holds the lock")

// ErrFenced is returned by Apply, Live or Reset on a generation another process has claimed since
// (see Claim for what that fences and what it does not).
var ErrFenced = errors.New("store: generation claimed by another consumer")

// pgTables names one stream's tables: its cursor table, the row table its generations hold (a
// delete or Reset removes rows from it; tables hanging off it cascade) and its consumer lock.
type pgTables struct {
	cursors, rows, lock string
}

// appTables are the app index's tables.
var appTables = pgTables{cursors: "app_index_cursors", rows: "app_index_apps", lock: lockKey}

// pgGens is the generation half of a Postgres store: the cursor table, the consumer lock and the
// fence. Postgres (the app index) and ListingsPostgres (the listings read model) are built on it,
// each over its own tables.
type pgGens struct {
	pool  *pgxpool.Pool
	owner string
	sql   *strings.Replacer

	// beforeCommit, when set, is called where a write transaction would commit; an error rolls it
	// back. Tests use it to stand in for a crash between a change and its commit.
	beforeCommit func(op string) error
}

func newPgGens(pool *pgxpool.Pool, t pgTables) (*pgGens, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, err
	}
	return &pgGens{pool: pool, owner: hex.EncodeToString(b[:]),
		sql: strings.NewReplacer("{cursors}", t.cursors, "{rows}", t.rows, "{lock}", t.lock)}, nil
}

// q is a statement over this store's tables: {cursors}, {rows} and {lock} name them.
func (p *pgGens) q(tpl string) string { return p.sql.Replace(tpl) }

// create runs a stream's table DDL, then drops leftover retired generations.
func (p *pgGens) create(ctx context.Context, ddl string) error {
	err := pgx.BeginFunc(ctx, p.pool, func(tx pgx.Tx) error {
		// Serializes two processes starting at once: concurrent CREATE ... IF NOT EXISTS can race.
		if _, err := tx.Exec(ctx, p.q(`SELECT pg_advisory_xact_lock({lock} + 1)`)); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, ddl)
		return err
	})
	if err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	return p.dropRetired(ctx)
}

// Postgres is the production Store.
type Postgres struct {
	*pgGens
}

// NewPostgres creates the tables if they are missing, drops leftover retired generations and
// returns the store. The pool's search_path decides the schema.
func NewPostgres(ctx context.Context, pool *pgxpool.Pool) (*Postgres, error) {
	g, err := newPgGens(pool, appTables)
	if err != nil {
		return nil, err
	}
	if err := g.create(ctx, schemaSQL); err != nil {
		return nil, err
	}
	return &Postgres{g}, nil
}

// Lock takes the consumer lock: only its holder follows the registry and writes, so two processes
// (a rolling update) never interleave cursors. Searches need no lock. ErrLocked while another
// process holds it. The lock is a session advisory lock on a dedicated connection; the returned
// func releases it. Claim is the second line.
func (p *pgGens) Lock(ctx context.Context) (func(), error) {
	conn, err := p.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	var ok bool
	if err := conn.QueryRow(ctx, p.q(`SELECT pg_try_advisory_lock({lock})`)).Scan(&ok); err != nil {
		conn.Release()
		return nil, err
	}
	if !ok {
		conn.Release()
		return nil, ErrLocked
	}
	unlock := p.q(`SELECT pg_advisory_unlock({lock})`)
	//nolint:contextcheck // the release runs after the caller's context has ended, so it has its own
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = conn.Exec(ctx, unlock)
		conn.Release()
	}, nil
}

// Claim makes this process the writer of gen. What that guarantees: Apply, Live and Reset store the
// cursor only where the generation's owner is this process, in the same transaction as their
// change, so once another process has claimed a generation, every later write to it from this one
// fails with ErrFenced. It does not stop writes that commit before the other process claims, nor
// NewBuilding, which is not fenced. Writes committed before the claim are harmless: the new owner
// resumes from a cursor at or before them and applies those events again, and replaying is
// idempotent (an upsert replaces the whole row, a delete of a missing row does nothing).
func (p *pgGens) Claim(ctx context.Context, gen int64) error {
	tag, err := p.pool.Exec(ctx, p.q(`UPDATE {cursors} SET owner = $1 WHERE generation = $2 AND state <> 'retired'`), p.owner, gen)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoGeneration
	}
	return nil
}

func (p *pgGens) commit(ctx context.Context, tx pgx.Tx, op string) error {
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
func (p *pgGens) write(ctx context.Context, op string, gen int64, cursor string, fn func(tx pgx.Tx, state string) error) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var state, owner string
	err = tx.QueryRow(ctx, p.q(`
UPDATE {cursors} SET cursor = $1, updated_at = now()
WHERE generation = $2 AND state <> 'retired' AND owner = $3
RETURNING state, owner`), cursor, gen, p.owner).Scan(&state, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := tx.QueryRow(ctx, p.q(`SELECT EXISTS (SELECT 1 FROM {cursors} WHERE generation = $1 AND state <> 'retired')`), gen).Scan(&exists); err != nil {
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

// State implements Generations.
func (p *pgGens) State(ctx context.Context) (State, error) {
	rows, err := p.pool.Query(ctx, p.q(`SELECT generation, layout, schema, cursor, state FROM {cursors} WHERE state IN ('building', 'serving')`))
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

// NewBuilding implements Generations. The new generation is claimed by this process.
func (p *pgGens) NewBuilding(ctx context.Context, schema string, layout int) (Generation, error) {
	g := Generation{Layout: layout, Schema: schema, State: StateBuilding}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Generation{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, p.q(`DELETE FROM {cursors} WHERE state = 'building'`)); err != nil {
		return Generation{}, err
	}
	err = tx.QueryRow(ctx, p.q(`INSERT INTO {cursors} (schema, layout, state, owner) VALUES ($1, $2, 'building', $3) RETURNING generation`),
		schema, layout, p.owner).Scan(&g.ID)
	if err != nil {
		return Generation{}, err
	}
	if err := p.commit(ctx, tx, "new-building"); err != nil {
		return Generation{}, err
	}
	return g, nil
}

// Reset implements Generations.
func (p *pgGens) Reset(ctx context.Context, gen int64) error {
	return p.write(ctx, "reset", gen, "", func(tx pgx.Tx, _ string) error {
		_, err := tx.Exec(ctx, p.q(`DELETE FROM {rows} WHERE generation = $1`), gen)
		return err
	})
}

// apply makes one change to a generation and stores its cursor, in one transaction: upsert writes
// an upsert's row; a delete removes the row (and what cascades from it).
func (p *pgGens) apply(ctx context.Context, gen int64, c Change, upsert func(tx pgx.Tx) error) error {
	return p.write(ctx, "apply", gen, c.Cursor, func(tx pgx.Tx, _ string) error {
		switch c.Kind {
		case ChangeUpsert:
			return upsert(tx)
		case ChangeDelete:
			_, err := tx.Exec(ctx, p.q(`DELETE FROM {rows} WHERE generation = $1 AND urn = $2`), gen, c.URN)
			return err
		case ChangeProgress:
			return nil
		}
		return fmt.Errorf("store: unknown change kind %d", c.Kind)
	})
}

// Apply implements Store: the row change and the cursor commit together, or neither does.
func (p *Postgres) Apply(ctx context.Context, gen int64, c Change) error {
	return p.apply(ctx, gen, c, func(tx pgx.Tx) error {
		a := c.App
		// A whole-row replace.
		_, err := tx.Exec(ctx, `
INSERT INTO app_index_apps (generation, urn, rev, body, slug, name, name_key, kind, category, rating, creator, tagline, icon_url, release)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), NULLIF($14, ''))
ON CONFLICT (generation, urn) DO UPDATE SET
  rev = EXCLUDED.rev, body = EXCLUDED.body, slug = EXCLUDED.slug, name = EXCLUDED.name, name_key = EXCLUDED.name_key,
  kind = EXCLUDED.kind, category = EXCLUDED.category, rating = EXCLUDED.rating, creator = EXCLUDED.creator,
  tagline = EXCLUDED.tagline, icon_url = EXCLUDED.icon_url, release = EXCLUDED.release`,
			gen, a.URN, a.Rev, []byte(a.Body), a.Slug, a.Name, nameKey(a.Name), a.Kind, a.Category, a.Rating, a.Creator,
			a.Tagline, a.IconURL, a.Release)
		return err
	})
}

// Live implements Generations. The switch is one transaction, so a search sees either the old
// generation or the new one, never neither. The old one's rows are deleted after the commit.
func (p *pgGens) Live(ctx context.Context, gen int64, cursor string) (bool, error) {
	promoted := false
	err := p.write(ctx, "live", gen, cursor, func(tx pgx.Tx, state string) error {
		if state != StateBuilding {
			return nil
		}
		if _, err := tx.Exec(ctx, p.q(`UPDATE {cursors} SET state = 'retired' WHERE state = 'serving'`)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, p.q(`UPDATE {cursors} SET state = 'serving' WHERE generation = $1`), gen); err != nil {
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

func (p *pgGens) dropRetired(ctx context.Context) error {
	_, err := p.pool.Exec(ctx, p.q(`DELETE FROM {cursors} WHERE state = 'retired'`))
	return err
}

// Search implements Store.
func (p *Postgres) Search(ctx context.Context, q Query) (Page, error) {
	tokens := Tokens(q.Text)
	if strings.TrimSpace(q.Text) != "" && len(tokens) == 0 {
		return Page{}, p.servingOrNotReady(ctx)
	}
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	where := []string{"g.state = 'serving'"}
	rank := "0::real"
	if len(tokens) > 0 {
		tsq := "to_tsquery('simple', " + arg(prefixTSQuery(tokens)) + ")"
		where = append(where, "a.search @@ "+tsq)
		rank = "ts_rank(a.search, " + tsq + ")"
	}
	if q.Kind != "" {
		where = append(where, "a.kind = "+arg(q.Kind))
	}
	if q.Category != "" {
		where = append(where, "a.category = "+arg(q.Category))
	}
	// In the query, before the LIMIT, so a page is filled with admitted rows. A null rating never
	// equals any element, so it is answered only when admitted is nil (Mature.admitted).
	if ratings := q.Mature.admitted(); ratings != nil {
		where = append(where, "lower(a.rating) = ANY("+arg(ratings)+"::text[])")
	}
	sql := `
SELECT a.urn, a.slug, a.name, coalesce(a.tagline, ''), a.kind, coalesce(a.category, ''), coalesce(a.rating, ''),
  coalesce(a.icon_url, ''), coalesce(a.creator, '')
FROM app_index_apps a JOIN app_index_cursors g ON g.generation = a.generation
WHERE ` + strings.Join(where, " AND ") + `
ORDER BY ` + rank + ` DESC, a.name_key COLLATE "C", a.urn COLLATE "C"
LIMIT ` + arg(q.limitOf())
	rows, err := p.pool.Query(ctx, sql, args...)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	var page Page
	for rows.Next() {
		var r Result
		if err := rows.Scan(&r.URN, &r.Slug, &r.Name, &r.Tagline, &r.Kind, &r.Category, &r.Rating, &r.IconURL, &r.Creator); err != nil {
			return Page{}, err
		}
		page.Results = append(page.Results, r)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
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
