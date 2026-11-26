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

// THE CURRENT MAJOR. A read that names no `major` reads the collection's CURRENT major when the
// adapter names it, as a write that names none is stamped with the current one (WRITES-DESIGN.md,
// "Schema versioning"). This service holds no catalog, so the streams say it: the adapter's private
// and level streams name `currentMajor` in the `meta` of their `live` and `progress`
// (src/server/registry-adapter/doc-streams.ts collectionFamily), the major the document store stamps
// a write with, by its own rule (`currentCollectionMajors` over the approved manifest history).
//
// A read with no major opens its stream at a GUESS, the major the streams last named for the
// collection on this replica (majorHints), else 1, and reads it unfloored:
//
//   - the stream names the guess: the read is answered at it (under its floor, when it has one);
//   - it names another major: the hint becomes that major and the read is made once more there,
//     and answered there whatever that stream names (a major approved between the two reads moves
//     the hint again, for the next read). Never a third stream;
//   - it names none (an adapter from before `currentMajor`, a refused viewer, or two level streams
//     naming different majors): the read is answered at the guess, exactly as a read with no major
//     was before the adapter named it. Never a refusal: either service can ship, or roll back,
//     without the other.
//
// The hint is never trusted, only tried: a stream that names another major moves the read and the
// hint. A newly approved major therefore corrects it at the next read of the collection: the
// adapter re-reads every stream of a collection whose schema family changed and names the new major
// in a `progress`. A hinted major the adapter no longer resolves drops the hint: level streams end
// `not_resolved`; a private stream it does not resolve is empty and names nothing, so an empty,
// unnamed private stream at a hinted major other than 1 asks major 1 (which every collection has):
// one naming the hinted major keeps the hint (this viewer's stream is just empty), anything else
// drops it and the read continues from major 1. A viewer the adapter refuses also drops it (both
// streams name nothing): the next read relearns it. The hints are bounded (majorHintsMax; past it
// they are all dropped and relearned).
//
// A read that moves releases the streams its guess opened, when no other read used them
// (session.Manager.Release), so a cold hint does not hold two majors' streams against the caps.
//
// ONE RULE for the major a request that names none uses: a write's acknowledgement is held at the
// same guess (writes.Forwarder.UseImpliedMajor, set from majorHints.guess by Handler), so the
// read-back's floor finds it on the stream the read opens.
//
// An explicit `?major=N` is read exactly as before: at N, with no meta check.

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
			s.Streams.Release(at1.token, at1.schema)
		} else {
			// The hinted major is not the adapter's now: the hint is dropped, the read is major 1's.
			s.majors.forget(p.slug, p.collection)
			s.Streams.Release(p.token, p.schema)
			*p, snap, current = at1, snap1, c1
		}
	}
	if from := p.schema; !s.settle(p, current, false) {
		// Moved: the stream the guess opened is released (when this read alone used it).
		s.Streams.Release(p.token, from)
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
		}
		return b, err
	}
	b, err := read()
	if err != nil {
		return shared.Board{}, err
	}
	if from := p.major; !s.settle(p, b.Current, false) {
		// Moved: the streams the guess opened are released (those this read alone used).
		s.Shared.Release(v, p.slug, p.collection, from)
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
