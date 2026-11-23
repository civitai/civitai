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
// for, `rows: []` for an uncurated version. TTL an hour, served stale while revalidating, so Node
// answers from a stale entry as from a fresh one.
const KeyVersionShowcase = "packed:caches:version-showcase"

// Showcase is what the version-showcase cache says about a set of versions, as the guard in front of
// a port that does not apply curated showcases reads it (DESIGN.md §16.9).
type Showcase int

const (
	// ShowcaseUncurated: every version has an entry, and none holds a row (or it is a notFound
	// marker, which Node's fetch leaves out of its answer).
	ShowcaseUncurated Showcase = iota
	// ShowcaseCurated: some version's entry holds a row, or does not have the shape the Node reader
	// assumes, or its read failed (hasCuratedShowcase counts a failed read as curated).
	ShowcaseCurated
	// ShowcaseUnknown: some version has no entry Node's fetch would use as it is (no key, an
	// undecodable value, a bust's debounce marker). Node computes such an entry from the database
	// (a lag-aware read), so its absence says nothing about the curation.
	ShowcaseUnknown
)

// ShowcaseRead is one queued read of the version-showcase cache; State answers it after the batch's
// Exec.
type ShowcaseRead struct {
	ids  []int
	cmds []*redis.StringCmd
}

// QueueShowcases adds the version-showcase GETs of ids to b. With no client nothing is queued, and
// every id is then ShowcaseUnknown.
func (p *PackedReader) QueueShowcases(b *Batch, ids []int) *ShowcaseRead {
	r := p.Queue(b, KeyVersionShowcase, ids, 0)
	return &ShowcaseRead{ids: r.ids, cmds: r.cmds}
}

// State is the cache's answer for ids (a subset of the queued ids; an id that was not queued is
// ShowcaseUnknown). ShowcaseCurated wins over ShowcaseUnknown: a curated version needs the port
// whatever the other entries say.
func (r *ShowcaseRead) State(ids []int) Showcase {
	if len(ids) == 0 {
		return ShowcaseUncurated
	}
	at := make(map[int]int, len(r.cmds))
	for i := range r.cmds {
		at[r.ids[i]] = i
	}
	state := ShowcaseUncurated
	for _, id := range ids {
		i, ok := at[id]
		if !ok {
			state = ShowcaseUnknown
			continue
		}
		cmd := r.cmds[i]
		if err := cmd.Err(); err != nil && !errors.Is(err, redis.Nil) {
			return ShowcaseCurated
		}
		e, st := entryState(cmd, 0, time.Time{}, false)
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
