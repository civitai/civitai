package hydrate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// KeyVersionShowcase is REDIS_KEYS.CACHES.VERSION_SHOWCASE (packages/civitai-redis/src/client.ts):
// getVersionShowcaseCache's entries (src/server/services/version-showcase.service.ts), one per model
// version, `${key}:${modelVersionId}`. Each is a CachedVersionShowcase, `{ modelVersionId, rows,
// community, cachedAt }`, where `rows` are the version's ModelVersionShowcaseItem rows that are not
// removed (a creator's curation, on either site). The lookup writes a record for every id it is asked
// for, `rows: []` for an uncurated version.
const KeyVersionShowcase = "packed:caches:version-showcase"

// ShowcaseTTL is getVersionShowcaseCache's `ttl: CacheTTL.hour`. Past it the Node reader that wins
// the revalidate lock rebuilds the entry from the database, so a stale `rows: []` says nothing about
// the curation (DESIGN.md §16.9).
const ShowcaseTTL = time.Hour

// Showcase is what the version-showcase cache says about a set of versions, as the guard in front of
// a port that does not apply curated showcases reads it (DESIGN.md §16.9).
type Showcase int

const (
	// ShowcaseUncurated: every version has a fresh entry, and none holds a row (or it is a notFound
	// marker, which Node's fetch leaves out of its answer whatever its age).
	ShowcaseUncurated Showcase = iota
	// ShowcaseCurated: some version's entry holds a row, or does not have the shape the Node reader
	// assumes, or its read failed (hasCuratedShowcase counts a failed read as curated); or, for a
	// version with no usable entry, the replica holds a row or could not be read (ShowcaseState).
	ShowcaseCurated
	// ShowcaseUnknown: some version has no entry Node's fetch would use as it is (no key, an
	// undecodable value, a bust's debounce marker). Node computes such an entry from the database
	// (a lag-aware read), so its absence says nothing about the curation. ShowcaseState answers it
	// from the replica instead when misses are computed; it stays unknown without that.
	ShowcaseUnknown
	// ShowcaseStale: every version has an entry, none holds a row, but some entry is past ShowcaseTTL.
	// The Node reader that wins the revalidate lock answers from the database instead (ShowcaseTTL),
	// so the cache cannot say what Node serves.
	ShowcaseStale
)

// ShowcaseRead is one queued read of the version-showcase cache; State answers it after the batch's
// Exec.
type ShowcaseRead struct {
	read *PackedRead
}

// QueueShowcases adds the version-showcase GETs of ids to b, entries past ShowcaseTTL marked stale.
// With no client nothing is queued, and every id is then ShowcaseUnknown.
func (p *PackedReader) QueueShowcases(b *Batch, ids []int) *ShowcaseRead {
	return &ShowcaseRead{read: p.Queue(b, KeyVersionShowcase, ids, ShowcaseTTL)}
}

// State is the cache's answer for ids (a subset of the queued ids; an id that was not queued is
// ShowcaseUnknown). ShowcaseCurated wins over the others (a curated version needs the port whatever
// the other entries say), then ShowcaseUnknown over ShowcaseStale. Sources.ShowcaseState answers the
// ShowcaseUnknown versions from the replica instead.
func (r *ShowcaseRead) State(ids []int) Showcase {
	curated, missing, stale := r.classify(ids)
	return showcaseOf(curated, len(missing) > 0, stale)
}

// showcaseOf is the precedence State and ShowcaseState share: curated, then unknown, then stale.
func showcaseOf(curated, unknown, stale bool) Showcase {
	switch {
	case curated:
		return ShowcaseCurated
	case unknown:
		return ShowcaseUnknown
	case stale:
		return ShowcaseStale
	}
	return ShowcaseUncurated
}

// classify sorts ids by their entries: curated when any entry says so (it ends the scan: nothing
// else can change the answer), else missing (the ids with no entry Node's fetch would use as it
// is, each once) and stale (some uncurated entry is past ShowcaseTTL).
func (r *ShowcaseRead) classify(ids []int) (curated bool, missing []int, stale bool) {
	if len(ids) == 0 {
		return false, nil, false
	}
	var at map[int]int
	var p *PackedReader
	if r != nil && r.read != nil {
		at = make(map[int]int, len(r.read.cmds))
		for i := range r.read.cmds {
			at[r.read.ids[i]] = i
		}
		p = r.read.p
	}
	now := time.Now()
	if p != nil && p.Now != nil {
		now = p.Now()
	}
	seen := make(map[int]bool, len(ids))
	for _, id := range ids {
		i, ok := at[id]
		if !ok {
			if !seen[id] {
				seen[id] = true
				missing = append(missing, id)
			}
			continue
		}
		cmd := r.read.cmds[i]
		if err := cmd.Err(); err != nil && !errors.Is(err, redis.Nil) {
			return true, nil, false
		}
		e, st := entryState(cmd, ShowcaseTTL, now, false)
		if st != stateEntry {
			if !seen[id] {
				seen[id] = true
				missing = append(missing, id)
			}
			continue
		}
		if e.NotFound {
			continue
		}
		rows, ok := e.Value["rows"].([]any)
		if !ok || len(rows) > 0 {
			// No `rows` array: `showcases[id]?.rows.length` throws in Node, which hasCuratedShowcase
			// counts as curated. Either way the port cannot answer it.
			return true, nil, false
		}
		if e.Stale {
			stale = true
		}
	}
	return false, missing, stale
}

// sqlShowcaseCurated is the first query of getVersionShowcaseCache's lookupFn
// (src/server/services/version-showcase.service.ts), `FROM "ModelVersionShowcaseItem" s WHERE
// s."modelVersionId" IN (...) AND NOT s."removed"`, narrowed to the one thing hasCuratedShowcase
// decides on: whether any of the versions has such a row. Every row counts, whatever its site,
// source or `excluded` flag (`rows.length`), so one row is the whole answer. The table's primary key
// leads with "modelVersionId".
const sqlShowcaseCurated = `SELECT 1 FROM "ModelVersionShowcaseItem" WHERE "modelVersionId" = ANY($1::int[]) AND NOT "removed" LIMIT 1`

// ShowcaseState is State over r for ids, with the versions it has no usable entry for (ShowcaseUnknown:
// no key, an undecodable value, a debounce marker, an id not queued) answered from the replica when s
// computes misses (s.Compute): one query over all of them (sqlShowcaseCurated); no row and they are
// uncurated, a row and the answer is ShowcaseCurated. A failed query is ShowcaseCurated with its
// error, as hasCuratedShowcase counts a failed read (the caller falls back, `<reason>-miss-failed`).
// Without s.Compute, or with no replica, they stay ShowcaseUnknown. A stale entry is not looked up:
// Node's reader that wins the revalidate lock rebuilds it, and ShowcaseStale still falls back.
//
// The query reads the replica. Node's lookup reads the primary for a version a recent write flagged
// (getDbWithoutLagBatch), so a curation made within the replica's lag can be read here as uncurated
// (DESIGN.md §16.9). Nothing is written back to the cache, and no answer is kept in process.
func (s *Sources) ShowcaseState(ctx context.Context, r *ShowcaseRead, ids []int) (Showcase, error) {
	curated, missing, stale := r.classify(ids)
	if curated || len(missing) == 0 {
		return showcaseOf(curated, false, stale), nil
	}
	if s == nil || s.Compute == nil || s.Replica == nil {
		return ShowcaseUnknown, nil
	}
	rows, err := s.Replica.Query(ctx, sqlShowcaseCurated, missing)
	if err != nil {
		return ShowcaseCurated, fmt.Errorf("version showcase: %w", err)
	}
	found := rows.Next()
	rows.Close()
	if err := rows.Err(); err != nil {
		return ShowcaseCurated, fmt.Errorf("version showcase: %w", err)
	}
	return showcaseOf(found, false, stale), nil
}

// VersionShowcase reads the version-showcase cache for ids in one pipeline of its own and answers
// ShowcaseState over them. With no cache reader every id is a miss.
func (s *Sources) VersionShowcase(ctx context.Context, ids []int) (Showcase, error) {
	if len(ids) == 0 {
		return ShowcaseUncurated, nil
	}
	if s == nil {
		return ShowcaseUnknown, nil
	}
	var r *ShowcaseRead
	if s.Packed != nil {
		b := NewBatch()
		r = s.Packed.QueueShowcases(b, ids)
		b.Exec(ctx)
	}
	return s.ShowcaseState(ctx, r, ids)
}
