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

// THE CURRENT MAJOR. A read that names no `major` reads the collection's CURRENT major, as a write
// that names none is stamped with the current one (WRITES-DESIGN.md, "Schema versioning"). This
// service holds no catalog, so the streams say it: the adapter's private and level streams name
// `currentMajor` in the `meta` of their `live` and `progress` (src/server/registry-adapter/doc-feed.ts
// currentMajorOf), the newest major it derived for the collection from the app's approved manifest
// history, the history the site's resolveSchemaMajor derives a write's major from.
//
// A read with no major opens its stream at a GUESS, the major the streams last named for the
// collection on this replica (majorHints), else 1, and reads it unfloored:
//
//   - the stream names the guess: the read is answered at it (under its floor, when it has one);
//   - it names another major: the hint becomes that major and the read is made once more there. That
//     stream must name its own major; one that names yet another is `major_unknown`;
//   - it names none and holds records (an adapter from before `currentMajor`, or two level streams
//     naming different majors): `major_unknown` (errMajorUnknown), a 503 with Retry-After, or REST
//     where REST is still the fallback. Never an answer at a major nothing showed is current;
//   - it names none and holds nothing (the adapter refused the viewer: a refused private stream is
//     empty and carries no meta): answered as before, since an empty answer is the same at every
//     major.
//
// The hint is never trusted, only tried: every answer is checked against the meta of the stream it
// came from. A newly approved major therefore corrects it at the next read of the collection: the
// adapter re-reads every stream of a collection whose schema family changed and names the new major
// in a `progress`. A hinted major the adapter no longer resolves (`not_resolved`) drops the hint.
// The hints are bounded (majorHintsMax; past it they are all dropped and relearned).
//
// An explicit `?major=N` is read exactly as before: at N, with no meta check.

// errMajorUnknown is a read with no major whose streams did not name the collection's current one.
var errMajorUnknown = errors.New("api: the streams named no current major for the collection")

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
// current and held n records (THE CURRENT MAJOR): done reports the read is answered at p.major; not
// done, p was moved to the named major and the read is made again there.
func (s *Server) settle(p *readParams, current, n int, corrected bool) (done bool, err error) {
	switch {
	case current == 0 && n > 0:
		return false, errMajorUnknown
	case current == 0:
		return true, nil
	case current == p.major:
		s.majors.set(p.slug, p.collection, current)
		return true, nil
	case corrected:
		return false, errMajorUnknown
	}
	s.majors.set(p.slug, p.collection, current)
	if err := p.at(current); err != nil {
		return false, errMajorUnknown
	}
	return false, nil
}

// view reads p's private stream: at p.major as named, or, for a read with no major, at the current
// major, p moved to it.
func (s *Server) view(ctx context.Context, p *readParams) ([]registry.Entity, error) {
	if !p.implied {
		snap, err := s.Streams.View(ctx, p.token, p.schema, p.minSeq)
		return snap.Entities, err
	}
	for corrected := false; ; corrected = true {
		snap, err := s.Streams.View(ctx, p.token, p.schema, 0)
		if err != nil {
			return nil, err
		}
		done, err := s.settle(p, shared.CurrentMajor(snap.Meta), len(snap.Entities), corrected)
		switch {
		case err != nil:
			return nil, err
		case !done:
			continue
		case p.minSeq == 0:
			return snap.Entities, nil
		}
		snap, err = s.Streams.View(ctx, p.token, p.schema, p.minSeq)
		return snap.Entities, err
	}
}

// sharedRead is view for a shared collection's board.
func (s *Server) sharedRead(ctx context.Context, v shared.Viewer, p *readParams) (shared.Board, error) {
	if !p.implied {
		return s.Shared.Read(ctx, v, p.slug, p.collection, p.major, p.minSeq)
	}
	for corrected := false; ; corrected = true {
		b, err := s.Shared.Read(ctx, v, p.slug, p.collection, p.major, 0)
		if err != nil {
			var ended *session.EndedError
			if errors.As(err, &ended) && ended.Reason == "not_resolved" && p.major != 1 {
				// A hinted major the adapter does not resolve now: the next read guesses 1 again.
				s.majors.forget(p.slug, p.collection)
			}
			return shared.Board{}, err
		}
		done, err := s.settle(p, b.Current, len(b.Docs), corrected)
		switch {
		case err != nil:
			return shared.Board{}, err
		case !done:
			continue
		case p.minSeq == 0:
			return b, nil
		}
		return s.Shared.Read(ctx, v, p.slug, p.collection, p.major, p.minSeq)
	}
}
