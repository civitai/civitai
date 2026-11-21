package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"
)

// Listing is one store-listing@v1 entity's row in the listings read model
// (apps/app-index-go/LISTINGS-READ-MODEL.md). Body is kept whole and is the one stored copy of
// the media: the columns are the identity, filter and sort keys copied out of it, and Media is
// decoded from it (every media item as the stream sent it, less any whose slot is unknown, dropped
// by ListingFromEntity) whenever a listing is read with its body. An empty string is a null column.
type Listing struct {
	URN  string
	Rev  string
	Body json.RawMessage
	// App is the URN of the app entity the listing presents.
	App      string
	Slug     string
	Name     string
	Kind     string
	Category string
	// ContentRating is the app entity's rating, the body's contentRating: the listing's own when it
	// is known, else its block's (the adapter's appContentRating). The stream reaches exactly the
	// audiences that rating admits. It is NOT what the store gates on.
	ContentRating string
	// ListingContentRating is the listing's own rating, the body's listingContentRating: the
	// column the store gates on and shows (al.content_rating: listingMatureFilter,
	// listingMediaCeiling, the card's contentRating). Empty is null.
	ListingContentRating string
	// CreatorID is the creator chip's user id; nil without a creator.
	CreatorID *int64
	// CreatedAt is the `newest` sort key; nil when the body has none.
	CreatedAt *time.Time
	UpdatedAt *time.Time
	Stats     ListingStats
	Media     []ListingMedia
}

// ListingStats is the listing's rollup. A counter the body does not carry as a count is nil (a
// null column), never a reason to drop the listing: OpenCount is nil off-site, and any counter that
// is missing, negative or not an integer is nil and reported as a Drop.
type ListingStats struct {
	RecommendedCount    *int64
	NotRecommendedCount *int64
	ReviewCount         *int64
	OpenCount           *int64
	InstallCount        *int64
}

// Drop is a part of a body the read model left out rather than reject the listing: a media item
// whose slot it does not know (What "media_item"), or a stats counter it could not read (What
// "stat"). The consumer logs and counts each one.
type Drop struct {
	What   string
	Reason string
}

// ListingMedia is one media item, in stream order (Position): the own icon, the own cover, the
// screenshots in order, then the civitai.red overrides (Host "red").
//
// Stored unfiltered, each with its own rating: the stream's per-audience filter is coarser than
// the store's, so a reader MUST NOT show these items as they are. The read API projects them per
// request through internal/listingread (ProjectMedia), which applies the listing-rating ceiling and
// the host rule (`listingMediaCeiling` and `redHostMediaCeiling` in
// src/server/services/blocks/listing-media-audience.ts) and shows a Host "red" item only on a
// red-capable host.
type ListingMedia struct {
	Position  int
	Slot      string // icon, cover or screenshot
	Host      string // any or red
	URL       string
	NsfwLevel int64
	Rating    string // pg, pg13, r, x or xxx
	Caption   string // screenshot only
	CoverURL  string // screenshot only: its rendition as a cover
}

// The enums of a media item (src/server/registry-adapter/schemas.ts, STORE_LISTING_SCHEMA_DOCUMENT).
// mediaLevelOf is each rating's NsfwLevel bit: an item's nsfwLevel must be exactly its rating's
// (src/shared/constants/browsingLevel.constants.ts, NSFW_LEVEL_BY_IMAGE_RATING).
var (
	mediaSlots   = map[string]bool{"icon": true, "cover": true, "screenshot": true}
	mediaHosts   = map[string]bool{"any": true, "red": true}
	mediaLevelOf = map[string]int64{"pg": 1, "pg13": 2, "r": 4, "x": 8, "xxx": 16}
)

type listingBody struct {
	App           *string         `json:"app"`
	Slug          *string         `json:"slug"`
	Name          *string         `json:"name"`
	Kind          *string         `json:"kind"`
	ContentRating json.RawMessage `json:"contentRating"`
	// ListingContentRating is required (null allowed): without it a listing cannot be gated.
	ListingContentRating json.RawMessage   `json:"listingContentRating"`
	Category             json.RawMessage   `json:"category"`
	Media                []json.RawMessage `json:"media"`
	Creator              json.RawMessage   `json:"creator"`
	Stats                json.RawMessage   `json:"stats"`
	CreatedAt            json.RawMessage   `json:"createdAt"`
	UpdatedAt            json.RawMessage   `json:"updatedAt"`
}

type mediaBody struct {
	Slot      json.RawMessage `json:"slot"`
	Host      *string         `json:"host"`
	URL       *string         `json:"url"`
	NsfwLevel *int64          `json:"nsfwLevel"`
	Rating    *string         `json:"rating"`
	Caption   json.RawMessage `json:"caption"`
	CoverURL  json.RawMessage `json:"coverUrl"`
}

// ListingFromEntity checks the fields of a store-listing@v1 body this read model relies on and
// copies them out. An error means the body is not one it can use: the consumer treats such an
// entity as deleted (registry spec, "Validity" rule 2). That is kept for the identity fields and
// for what gating reads: a media item whose host or rating is unknown, or whose nsfwLevel is not
// exactly its rating's level, fails the whole body, since the read model must not store an item it
// cannot gate. What it can leave out without misgating is dropped instead, and reported: a media
// item with an unknown slot, and a stats counter it cannot read (stored null).
func ListingFromEntity(urn, rev string, body json.RawMessage) (Listing, []Drop, error) {
	var b listingBody
	if err := json.Unmarshal(body, &b); err != nil {
		return Listing{}, nil, fmt.Errorf("body is not an object: %w", err)
	}
	switch {
	case b.App == nil || *b.App == "":
		return Listing{}, nil, errors.New("app missing")
	case b.Slug == nil || *b.Slug == "":
		return Listing{}, nil, errors.New("slug missing")
	case b.Name == nil:
		return Listing{}, nil, errors.New("name missing")
	case b.Kind == nil || (*b.Kind != "onsite" && *b.Kind != "offsite"):
		return Listing{}, nil, errors.New("kind missing or unknown")
	case b.ContentRating == nil:
		return Listing{}, nil, errors.New("contentRating missing")
	case b.ListingContentRating == nil:
		return Listing{}, nil, errors.New("listingContentRating missing")
	case b.Media == nil:
		return Listing{}, nil, errors.New("media missing")
	}
	l := Listing{URN: urn, Rev: rev, Body: body, App: *b.App, Slug: *b.Slug, Name: *b.Name, Kind: *b.Kind}
	var err error
	if l.ContentRating, err = nullableString(b.ContentRating); err != nil {
		return Listing{}, nil, fmt.Errorf("contentRating: %w", err)
	}
	if l.ListingContentRating, err = nullableString(b.ListingContentRating); err != nil {
		return Listing{}, nil, fmt.Errorf("listingContentRating: %w", err)
	}
	if l.Category, err = nullableString(b.Category); err != nil {
		return Listing{}, nil, fmt.Errorf("category: %w", err)
	}
	if l.CreatorID, err = creatorID(b.Creator); err != nil {
		return Listing{}, nil, fmt.Errorf("creator: %w", err)
	}
	if l.CreatedAt, err = nullableTime(b.CreatedAt); err != nil {
		return Listing{}, nil, fmt.Errorf("createdAt: %w", err)
	}
	if l.UpdatedAt, err = nullableTime(b.UpdatedAt); err != nil {
		return Listing{}, nil, fmt.Errorf("updatedAt: %w", err)
	}
	drops := statsFrom(b.Stats, &l.Stats)
	l.Media = make([]ListingMedia, 0, len(b.Media))
	for i, raw := range b.Media {
		m, keep, err := mediaFrom(raw)
		if err != nil {
			return Listing{}, nil, fmt.Errorf("media[%d]: %w", i, err)
		}
		if !keep {
			drops = append(drops, Drop{What: "media_item", Reason: fmt.Sprintf("media[%d]: slot missing or unknown", i)})
			continue
		}
		// Position is the item's index in the stream's array, so a dropped item leaves a gap.
		m.Position = i
		l.Media = append(l.Media, m)
	}
	return l, drops, nil
}

// statsFrom reads the counters of a stats object into dst. Each counter is a non-negative integer
// or nil; anything else (stats missing or not an object, a counter missing, negative or not an
// integer) is nil and a Drop. openCount null is the off-site value, not a drop.
func statsFrom(raw json.RawMessage, dst *ListingStats) []Drop {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		// Every counter stays nil: one drop for the object, not one per counter.
		return []Drop{{What: "stat", Reason: "stats missing or not an object"}}
	}
	var drops []Drop
	for _, f := range []struct {
		name     string
		dst      **int64
		nullable bool
	}{
		{"recommendedCount", &dst.RecommendedCount, false},
		{"notRecommendedCount", &dst.NotRecommendedCount, false},
		{"reviewCount", &dst.ReviewCount, false},
		{"openCount", &dst.OpenCount, true},
		{"installCount", &dst.InstallCount, false},
	} {
		v, ok := fields[f.name]
		if ok && string(v) == "null" && f.nullable {
			continue
		}
		var n int64
		if !ok || json.Unmarshal(v, &n) != nil || n < 0 {
			drops = append(drops, Drop{What: "stat", Reason: "stats." + f.name + " missing or not a count"})
			continue
		}
		*f.dst = &n
	}
	return drops
}

// mediaFrom reads one media item. keep is false for an item whose slot is missing or unknown: it is
// dropped, the listing kept. Every other defect is an error, failing the whole body.
func mediaFrom(raw json.RawMessage) (m ListingMedia, keep bool, err error) {
	var mb mediaBody
	if err := json.Unmarshal(raw, &mb); err != nil {
		return ListingMedia{}, false, errors.New("not an object")
	}
	var slot string
	if json.Unmarshal(mb.Slot, &slot) != nil || !mediaSlots[slot] {
		return ListingMedia{}, false, nil
	}
	switch {
	case mb.Host == nil || !mediaHosts[*mb.Host]:
		return ListingMedia{}, false, errors.New("host missing or unknown")
	case mb.URL == nil || *mb.URL == "":
		return ListingMedia{}, false, errors.New("url missing")
	case mb.NsfwLevel == nil:
		return ListingMedia{}, false, errors.New("nsfwLevel missing")
	case mb.Rating == nil || mediaLevelOf[*mb.Rating] == 0:
		return ListingMedia{}, false, errors.New("rating missing or unknown")
	case *mb.NsfwLevel != mediaLevelOf[*mb.Rating]:
		// 0, Blocked, a flag of several bits, or another rating's bit: the item cannot be gated.
		return ListingMedia{}, false, fmt.Errorf("nsfwLevel %d is not rating %s's level", *mb.NsfwLevel, *mb.Rating)
	}
	m = ListingMedia{Slot: slot, Host: *mb.Host, URL: *mb.URL, NsfwLevel: *mb.NsfwLevel, Rating: *mb.Rating}
	if m.Caption, err = nullableString(mb.Caption); err != nil {
		return ListingMedia{}, false, fmt.Errorf("caption: %w", err)
	}
	if m.CoverURL, err = nullableString(mb.CoverURL); err != nil {
		return ListingMedia{}, false, fmt.Errorf("coverUrl: %w", err)
	}
	return m, true, nil
}

func creatorID(raw json.RawMessage) (*int64, error) {
	if raw == nil || string(raw) == "null" {
		return nil, nil
	}
	var c struct {
		ID *int64 `json:"id"`
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, errors.New("not an object or null")
	}
	return c.ID, nil
}

func nullableTime(raw json.RawMessage) (*time.Time, error) {
	s, err := nullableString(raw)
	if err != nil || s == "" {
		return nil, err
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return nil, errors.New("not an RFC 3339 date-time")
	}
	// Postgres timestamptz holds microseconds; truncating here keeps both stores equal.
	t = t.UTC().Truncate(time.Microsecond)
	return &t, nil
}

// DecodeListing is the upsert change of a store-listing@v1 entity (ListingFromEntity), with what it
// dropped.
func DecodeListing(urn, rev string, body json.RawMessage) (Change, error) {
	l, drops, err := ListingFromEntity(urn, rev, body)
	if err != nil {
		return Change{}, err
	}
	return Change{Kind: ChangeUpsert, Listing: l, Dropped: drops}, nil
}

// Listings is the listings read model's state: the generations of the store-listing@v1 stream,
// and the reads the listing API (internal/api, internal/listingread) answers from. A listing read
// with its body is decoded from that body by ListingFromEntity, so Media are the items the ingest
// validated, by the same rule. Every read of a generation that does not exist (any more) is
// ErrNoGeneration.
type Listings interface {
	Generations
	// Count is how many listings gen holds. The consumer holds a snapshot that ends with none.
	Count(ctx context.Context, gen int64) (int, error)
	// Get is one listing of gen, with its media in stream order; false when gen does not hold it.
	Get(ctx context.Context, gen int64, urn string) (Listing, bool, error)
	// Keys is every listing of gen with its columns only (no Body, no Media), for the grid's filter
	// and sort. In no particular order.
	Keys(ctx context.Context, gen int64) ([]Listing, error)
	// GetMany is the listings of gen that urns name, each with its body and media, in no
	// particular order. A URN gen does not hold is left out.
	GetMany(ctx context.Context, gen int64, urns []string) ([]Listing, error)
	// BySlug is the listing of gen whose slug is slug, with its body and media; false when there
	// is none.
	BySlug(ctx context.Context, gen int64, slug string) (Listing, bool, error)
}

// decodeStored is a stored listing read back from its body. The body passed ListingFromEntity at
// ingest, so an error here means the decoding rule changed without a ListingsLayoutVersion bump.
func decodeStored(urn, rev string, body []byte) (Listing, error) {
	l, _, err := ListingFromEntity(urn, rev, json.RawMessage(body))
	if err != nil {
		return Listing{}, fmt.Errorf("stored listing %s: %w", urn, err)
	}
	return l, nil
}

// keyOf is l without its body and media: what Keys returns.
func keyOf(l Listing) Listing {
	l.Body = nil
	l.Media = nil
	return l
}

// ListingsMemory is the in-process Listings, with the same transaction semantics as
// ListingsPostgres (contract_test.go).
type ListingsMemory struct {
	memGens[Listing]
}

// NewListingsMemory returns an empty ListingsMemory.
func NewListingsMemory() *ListingsMemory {
	return &ListingsMemory{newMemGens(func(c Change) (string, Listing) { return c.Listing.URN, c.Listing })}
}

// Count implements Listings.
func (m *ListingsMemory) Count(_ context.Context, gen int64) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return 0, ErrNoGeneration
	}
	return len(g.rows), nil
}

// Get implements Listings.
func (m *ListingsMemory) Get(_ context.Context, gen int64, urn string) (Listing, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return Listing{}, false, ErrNoGeneration
	}
	l, ok := g.rows[urn]
	if !ok {
		return Listing{}, false, nil
	}
	d, err := decodeStored(l.URN, l.Rev, bytes.Clone(l.Body))
	return d, err == nil, err
}

// Keys implements Listings.
func (m *ListingsMemory) Keys(_ context.Context, gen int64) ([]Listing, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return nil, ErrNoGeneration
	}
	out := make([]Listing, 0, len(g.rows))
	for _, l := range g.rows {
		out = append(out, keyOf(l))
	}
	return out, nil
}

// GetMany implements Listings.
func (m *ListingsMemory) GetMany(_ context.Context, gen int64, urns []string) ([]Listing, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return nil, ErrNoGeneration
	}
	var out []Listing
	for _, urn := range slices.Compact(slices.Sorted(slices.Values(urns))) {
		l, ok := g.rows[urn]
		if !ok {
			continue
		}
		d, err := decodeStored(l.URN, l.Rev, bytes.Clone(l.Body))
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, nil
}

// BySlug implements Listings.
func (m *ListingsMemory) BySlug(_ context.Context, gen int64, slug string) (Listing, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return Listing{}, false, ErrNoGeneration
	}
	// The lowest URN wins, as in ListingsPostgres; a slug names one URN in practice.
	var found *Listing
	for _, l := range g.rows {
		if l.Slug == slug && (found == nil || l.URN < found.URN) {
			found = &l
		}
	}
	if found == nil {
		return Listing{}, false, nil
	}
	d, err := decodeStored(found.URN, found.Rev, bytes.Clone(found.Body))
	return d, err == nil, err
}
