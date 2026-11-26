package api

import (
	"context"
	"errors"
	"sync"

	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/shared"
	"github.com/civitai/civitai/apps/app-data-go/internal/urn"
)

// THE CURRENT MAJOR. A read that names no `major` reads the collection's current major as the
// adapter's private and level streams name it (`currentMajor` in their `live`/`progress` meta). The
// rule lives in the adapter: `currentCollectionMajors`, the major the store stamps a write with.
//
//   - The read opens at a GUESS: the major the streams last named for the collection on this replica
//     (majorHints, bounded), else 1.
//   - A stream naming another major moves the read there, once; the read is then answered at that
//     major whatever its stream names. Separately, an empty, unnamed private stream at a hinted major
//     other than 1 (what the adapter sends for a major it does not resolve) is checked against @v1,
//     which keeps or drops the hint; level streams drop it on `not_resolved`.
//   - A stream naming no major is answered at the guess, never refused, so app-data-go and the
//     adapter ship and roll back independently.
//   - A write naming no major is acknowledged at the same guess (writes.Forwarder.UseImpliedMajor),
//     so the read-back's floor finds the acknowledgement on the stream the read opens.
//   - A read that moves releases only the streams it opened (session.Lease).
//
// An explicit `?major=N` is read at N, with no meta check. Outcomes are counted: metrics.go.

// majorHintsMax bounds the collections whose current major is remembered.
const majorHintsMax = 10_000

// majorHints remembers, per app collection, the current major its streams last named.
type majorHints struct {
	mu sync.Mutex
	m  map[string]int
}

func hintKey(slug, collection string) string { return slug + "/" + collection }

// guess is the major a read with no major opens first: the last one named, else 1.
func (h *majorHints) guess(slug, collection string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if n, ok := h.m[hintKey(slug, collection)]; ok {
		return n
	}
	return 1
}

func (h *majorHints) set(slug, collection string, major int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	k := hintKey(slug, collection)
	if h.m == nil {
		h.m = map[string]int{}
	}
	if _, had := h.m[k]; !had && len(h.m) >= majorHintsMax {
		clear(h.m)
	}
	h.m[k] = major
}

func (h *majorHints) forget(slug, collection string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.m, hintKey(slug, collection))
}

// at moves p to major.
func (p *readParams) at(major int) error {
	schema, err := urn.CollectionSchema(p.slug, p.collection, major)
	if err != nil {
		return err
	}
	p.schema, p.major = schema, major
	return nil
}

// settle decides a read with no major after one unfloored read at p.major whose streams named
// current (0: none), corrected when it was already moved once (THE CURRENT MAJOR): true when the
// read is answered at p.major; false when p was moved to the named major, to be read there.
func (s *Server) settle(p *readParams, current int, corrected bool) bool {
	if !corrected {
		switch current {
		case 0:
			s.impliedMajor("unnamed")
		case p.major:
			s.impliedMajor("matched")
		default:
			s.impliedMajor("moved")
		}
	}
	if current == 0 {
		return true
	}
	s.majors.set(p.slug, p.collection, current)
	if current == p.major || corrected {
		return true
	}
	// A major no schema URN of p's collection can carry is not followed: answered at the guess.
	return p.at(current) != nil
}

func (s *Server) impliedMajor(outcome string) {
	if s.Metrics != nil {
		s.Metrics.ImpliedMajor.WithLabelValues(outcome).Inc()
	}
}

// impliedMajorUser takes the rule for the major a request that names none uses (the write
// forwarder, writes.Forwarder.UseImpliedMajor), so reads and writes share it.
type impliedMajorUser interface {
	UseImpliedMajor(rule func(slug, collection string) int)
}

// view reads p's private stream: at p.major as named, or, for a read with no major, at the current
// major, p moved to it.
func (s *Server) view(ctx context.Context, p *readParams) ([]registry.Entity, error) {
	if !p.implied {
		snap, err := s.Streams.View(ctx, p.token, p.schema, p.minSeq)
		return snap.Entities, err
	}
	snap, err := s.Streams.View(ctx, p.token, p.schema, 0)
	if err != nil {
		return nil, err
	}
	current := shared.CurrentMajor(snap.Meta)
	if current == 0 && len(snap.Entities) == 0 && p.major != 1 {
		// An empty stream naming nothing at a hinted major: what the adapter sends for a major it
		// does not resolve (or a viewer it refuses). Major 1, which every collection has, says which.
		at1 := *p
		_ = at1.at(1)
		snap1, err := s.Streams.View(ctx, at1.token, at1.schema, 0)
		if err != nil {
			return nil, err
		}
		if c1 := shared.CurrentMajor(snap1.Meta); c1 == p.major {
			// The hint holds: this viewer's stream at it is empty. The @v1 stream was only asked.
			snap1.Lease.Release()
		} else {
			// The hinted major is not the adapter's now: the hint is dropped, the read is major 1's.
			s.majors.forget(p.slug, p.collection)
			s.impliedMajor("hint_dropped")
			snap.Lease.Release()
			*p, snap, current = at1, snap1, c1
		}
	}
	if guess := snap.Lease; !s.settle(p, current, false) {
		// Moved: the stream the guess opened is released (while no other read has taken it).
		guess.Release()
		if snap, err = s.Streams.View(ctx, p.token, p.schema, 0); err != nil {
			return nil, err
		}
		s.settle(p, shared.CurrentMajor(snap.Meta), true)
	}
	if p.minSeq == 0 {
		return snap.Entities, nil
	}
	snap, err = s.Streams.View(ctx, p.token, p.schema, p.minSeq)
	return snap.Entities, err
}

// sharedRead is view for a shared collection's board. A hinted major the adapter does not resolve
// ends the level streams `not_resolved`: the hint is dropped.
func (s *Server) sharedRead(ctx context.Context, v shared.Viewer, p *readParams) (shared.Board, error) {
	if !p.implied {
		return s.Shared.Read(ctx, v, p.slug, p.collection, p.major, p.minSeq)
	}
	read := func() (shared.Board, error) {
		b, err := s.Shared.Read(ctx, v, p.slug, p.collection, p.major, 0)
		var ended *session.EndedError
		if errors.As(err, &ended) && ended.Reason == "not_resolved" && p.major != 1 {
			// A hinted major the adapter does not resolve now: the next read guesses 1 again.
			s.majors.forget(p.slug, p.collection)
			s.impliedMajor("hint_dropped")
		}
		return b, err
	}
	b, err := read()
	if err != nil {
		return shared.Board{}, err
	}
	if guess := b.Leases; !s.settle(p, b.Current, false) {
		// Moved: the streams the guess opened are released (each while no other read has taken it).
		for _, l := range guess {
			l.Release()
		}
		if b, err = read(); err != nil {
			return shared.Board{}, err
		}
		s.settle(p, b.Current, true)
	}
	if p.minSeq == 0 {
		return b, nil
	}
	return s.Shared.Read(ctx, v, p.slug, p.collection, p.major, p.minSeq)
}
