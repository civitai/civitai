// Package store holds the index: one row per app entity, keyed by URN, in generations. A
// generation is one complete copy of the index built from one subscription, with that
// subscription's cursor beside it. At most one generation is serving (answers searches) and at most
// one is building (a rebuild from an empty cursor, or the first start); a building generation
// becomes the serving one, and the old serving one is dropped, in one transaction at its `Live`.
//
// The cursor of a generation is written in the same transaction as the change it belongs to
// (registry spec, "Consumers" rule 1), so after a crash the index holds exactly what its stored
// cursor says: no missed change and no duplicate.
//
// Two implementations: Postgres (production) and Memory (a faithful in-process fake for the
// hermetic tests). Both pass the same contract tests (contract_test.go).
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// Generation states.
const (
	StateBuilding = "building"
	StateServing  = "serving"
	StateRetired  = "retired"
)

// Generation is one copy of the index and the cursor of the subscription building it.
type Generation struct {
	ID     int64
	Layout int
	Schema string
	Cursor string
	State  string
}

// State is the generations the index holds.
type State struct {
	Serving  *Generation
	Building *Generation
}

// App is one app entity's row. The filter columns are copied out of Body, which is kept whole.
// An empty string is a null column.
type App struct {
	URN      string
	Rev      string
	Body     json.RawMessage
	Slug     string
	Name     string
	Kind     string
	Category string
	Rating   string
	Creator  string
	Tagline  string
	IconURL  string
	Release  string
}

// ChangeKind is what a change does to a generation.
type ChangeKind int

// The changes a stream event makes. Every one stores its cursor.
const (
	ChangeUpsert ChangeKind = iota + 1
	ChangeDelete
	ChangeProgress
)

// Change is one event's effect on a generation: replace the row (Upsert), remove it (Delete) or
// nothing (Progress), and in every case store Cursor. An upsert carries the row of its store's
// stream: App for the app index, Listing for the listings read model.
type Change struct {
	Kind    ChangeKind
	App     App     // ChangeUpsert, app index
	Listing Listing // ChangeUpsert, listings read model
	URN     string  // ChangeDelete
	Cursor  string
}

// ErrNoGeneration is returned for a generation that does not exist (any more).
var ErrNoGeneration = errors.New("store: no such generation")

// Generations is the part of a store a stream consumer writes: the generations, their cursors and
// their rows. Store (the app index) and Listings (the listings read model) both implement it.
type Generations interface {
	// Lock takes the consumer lock (only its holder follows the registry and writes); ErrLocked
	// while another process holds it. The func releases it.
	Lock(ctx context.Context) (func(), error)
	// Claim makes this process the writer of gen.
	Claim(ctx context.Context, gen int64) error
	// State is the serving and building generations, each nil when there is none.
	State(ctx context.Context) (State, error)
	// NewBuilding starts an empty building generation, dropping any building one before it. The
	// serving generation, if any, keeps answering.
	NewBuilding(ctx context.Context, schema string, layout int) (Generation, error)
	// Reset empties a generation and its cursor, to build it again from an empty cursor.
	Reset(ctx context.Context, gen int64) error
	// Apply makes one change to a generation and stores its cursor, in one transaction.
	Apply(ctx context.Context, gen int64, c Change) error
	// Live stores the cursor of a `Live` event. When gen is building, it becomes the serving
	// generation in the same transaction and the old serving one is dropped; promoted reports it.
	Live(ctx context.Context, gen int64, cursor string) (promoted bool, err error)
}

// Store is the app index's state.
type Store interface {
	Generations
	// Search answers a query from the serving generation. With none, ErrNotReady.
	Search(ctx context.Context, q Query) (Page, error)
}

// ErrNotReady is returned by Search while no generation is serving.
var ErrNotReady = errors.New("store: no serving generation")

// appBody is the part of an app@v1 body this index reads. Unknown fields are ignored ("Consumers"
// rule 4); a field the schema adds later is ignored until someone indexes it.
type appBody struct {
	Slug          *string         `json:"slug"`
	Name          *string         `json:"name"`
	Kind          *string         `json:"kind"`
	ContentRating json.RawMessage `json:"contentRating"`
	Tagline       json.RawMessage `json:"tagline"`
	Category      json.RawMessage `json:"category"`
	IconURL       json.RawMessage `json:"iconUrl"`
	Creator       json.RawMessage `json:"creator"`
	Release       json.RawMessage `json:"release"`
}

// AppFromEntity checks the fields of an app@v1 body this index relies on and copies them out.
// An error means the body is not one this index can use: the consumer treats such an entity as
// deleted (registry spec, "Validity" rule 2). Checked by hand against the fields app@v1 declares
// (required slug, name, kind, contentRating; nullable strings otherwise), not against the
// schema document from the schema stream.
func AppFromEntity(urn, rev string, body json.RawMessage) (App, error) {
	var b appBody
	if err := json.Unmarshal(body, &b); err != nil {
		return App{}, fmt.Errorf("body is not an object: %w", err)
	}
	if b.Slug == nil || *b.Slug == "" {
		return App{}, errors.New("slug missing")
	}
	if b.Name == nil {
		return App{}, errors.New("name missing")
	}
	if b.Kind == nil || (*b.Kind != "onsite" && *b.Kind != "offsite") {
		return App{}, errors.New("kind missing or unknown")
	}
	if b.ContentRating == nil {
		return App{}, errors.New("contentRating missing")
	}
	a := App{URN: urn, Rev: rev, Body: body, Slug: *b.Slug, Name: *b.Name, Kind: *b.Kind}
	for _, f := range []struct {
		name string
		raw  json.RawMessage
		dst  *string
	}{
		{"contentRating", b.ContentRating, &a.Rating},
		{"tagline", b.Tagline, &a.Tagline},
		{"category", b.Category, &a.Category},
		{"iconUrl", b.IconURL, &a.IconURL},
		{"creator", b.Creator, &a.Creator},
		{"release", b.Release, &a.Release},
	} {
		s, err := nullableString(f.raw)
		if err != nil {
			return App{}, fmt.Errorf("%s: %w", f.name, err)
		}
		*f.dst = s
	}
	return a, nil
}

// DecodeApp is the upsert change of an app@v1 entity (AppFromEntity).
func DecodeApp(urn, rev string, body json.RawMessage) (Change, error) {
	a, err := AppFromEntity(urn, rev, body)
	if err != nil {
		return Change{}, err
	}
	return Change{Kind: ChangeUpsert, App: a}, nil
}

func nullableString(raw json.RawMessage) (string, error) {
	if raw == nil || string(raw) == "null" {
		return "", nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", errors.New("not a string or null")
	}
	return s, nil
}
