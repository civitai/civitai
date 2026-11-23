package hydrate

import (
	"context"
	"errors"
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

// ShowcaseTTL is getVersionShowcaseCache's `ttl: CacheTTL.hour`. Past it an entry is stale, and
// Node's fetch (createCachedArray, packages/civitai-redis/src/cached-array.ts) serves it as it is only
// to a reader that misses the revalidate lock: the lock winner rebuilds it from the database in the
// request and serves the rebuilt list. A curation whose cache refresh failed leaves exactly such an
// entry (refresh falls back to invalidate, which backdates `cachedAt` so the entry goes stale once
// the invalidate window passes), so a stale `rows: []` says nothing about the curation. Inside that
// window the entry still reads fresh to Node too, and both answer from it.
const ShowcaseTTL = time.Hour

// Showcase is what the version-showcase cache says about a set of versions, as the guard in front of
// a port that does not apply curated showcases reads it (DESIGN.md §16.9).
type Showcase int

const (
	// ShowcaseUncurated: every version has a fresh entry, and none holds a row (or it is a notFound
	// marker, which Node's fetch leaves out of its answer whatever its age).
	ShowcaseUncurated Showcase = iota
	// ShowcaseCurated: some version's entry holds a row, or does not have the shape the Node reader
	// assumes, or its read failed (hasCuratedShowcase counts a failed read as curated).
	ShowcaseCurated
	// ShowcaseUnknown: some version has no entry Node's fetch would use as it is (no key, an
	// undecodable value, a bust's debounce marker). Node computes such an entry from the database
	// (a lag-aware read), so its absence says nothing about the curation.
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
// the other entries say), then ShowcaseUnknown over ShowcaseStale.
func (r *ShowcaseRead) State(ids []int) Showcase {
	if len(ids) == 0 {
		return ShowcaseUncurated
	}
	at := make(map[int]int, len(r.read.cmds))
	for i := range r.read.cmds {
		at[r.read.ids[i]] = i
	}
	now := time.Now()
	if r.read.p.Now != nil {
		now = r.read.p.Now()
	}
	state := ShowcaseUncurated
	for _, id := range ids {
		i, ok := at[id]
		if !ok {
			state = ShowcaseUnknown
			continue
		}
		cmd := r.read.cmds[i]
		if err := cmd.Err(); err != nil && !errors.Is(err, redis.Nil) {
			return ShowcaseCurated
		}
		e, st := entryState(cmd, 0, now, false)
		if st != stateEntry {
			state = ShowcaseUnknown
			continue
		}
		if e.NotFound {
			continue
		}
		rows, ok := e.Value["rows"].([]any)
		if !ok || len(rows) > 0 {
			// No `rows` array: `showcases[id]?.rows.length` throws in Node, which hasCuratedShowcase
			// counts as curated. Either way the port cannot answer it.
			return ShowcaseCurated
		}
		if e.Stale && state == ShowcaseUncurated {
			state = ShowcaseStale
		}
	}
	return state
}

// VersionShowcase reads the version-showcase cache for ids in one pipeline of its own and answers
// State over them.
func (s *Sources) VersionShowcase(ctx context.Context, ids []int) Showcase {
	if len(ids) == 0 {
		return ShowcaseUncurated
	}
	if s == nil || s.Packed == nil {
		return ShowcaseUnknown
	}
	b := NewBatch()
	r := s.Packed.QueueShowcases(b, ids)
	b.Exec(ctx)
	return r.State(ids)
}
