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
// (apps/app-index-go/LISTINGS-READ-MODEL.md). Body is kept whole; the columns are the identity,
// filter and sort keys copied out of it, and Media is every media item exactly as the stream sent
// it. An empty string is a null column.
type Listing struct {
	URN  string
	Rev  string
	Body json.RawMessage
	// App is the URN of the app entity the listing presents.
	App           string
	Slug          string
	Name          string
	Kind          string
	Category      string
	ContentRating string
	// CreatorID is the creator chip's user id; nil without a creator.
	CreatorID *int64
	// CreatedAt is the `newest` sort key; nil when the body has none.
	CreatedAt *time.Time
	UpdatedAt *time.Time
	Stats     ListingStats
	Media     []ListingMedia
}

// ListingStats is the listing's rollup. OpenCount is nil off-site.
type ListingStats struct {
	RecommendedCount    int64
	NotRecommendedCount int64
	ReviewCount         int64
	OpenCount           *int64
	InstallCount        int64
}

// ListingMedia is one media item, in stream order (Position): the own icon, the own cover, the
// screenshots in order, then the civitai.red overrides (Host "red").
//
// Stored unfiltered, each with its own rating: the stream's per-audience filter is coarser than
// the store's, so a reader MUST NOT show these rows as they are. The read API (slice 3) applies, per
// request, the listing-rating ceiling and the host rule (`listingMediaCeiling` and
// `redHostMediaCeiling` in src/server/services/blocks/listing-media-audience.ts), and shows a
// Host "red" item only on a red-capable host.
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
var (
	mediaSlots   = map[string]bool{"icon": true, "cover": true, "screenshot": true}
	mediaHosts   = map[string]bool{"any": true, "red": true}
	mediaRatings = map[string]bool{"pg": true, "pg13": true, "r": true, "x": true, "xxx": true}
)

type listingBody struct {
	App           *string           `json:"app"`
	Slug          *string           `json:"slug"`
	Name          *string           `json:"name"`
	Kind          *string           `json:"kind"`
	ContentRating json.RawMessage   `json:"contentRating"`
	Category      json.RawMessage   `json:"category"`
	Media         []json.RawMessage `json:"media"`
	Creator       json.RawMessage   `json:"creator"`
	Stats         *struct {
		RecommendedCount    *int64          `json:"recommendedCount"`
		NotRecommendedCount *int64          `json:"notRecommendedCount"`
		ReviewCount         *int64          `json:"reviewCount"`
		OpenCount           json.RawMessage `json:"openCount"`
		InstallCount        *int64          `json:"installCount"`
	} `json:"stats"`
	CreatedAt json.RawMessage `json:"createdAt"`
	UpdatedAt json.RawMessage `json:"updatedAt"`
}

type mediaBody struct {
	Slot      *string         `json:"slot"`
	Host      *string         `json:"host"`
	URL       *string         `json:"url"`
	NsfwLevel *int64          `json:"nsfwLevel"`
	Rating    *string         `json:"rating"`
	Caption   json.RawMessage `json:"caption"`
	CoverURL  json.RawMessage `json:"coverUrl"`
}

// ListingFromEntity checks the fields of a store-listing@v1 body this read model relies on and
// copies them out. An error means the body is not one it can use: the consumer treats such an
// entity as deleted (registry spec, "Validity" rule 2). A media item with an unknown slot, host or
// rating fails the whole body rather than being dropped: the read model cannot apply a ceiling to a
// rating it does not know, and must not store an item it cannot gate.
func ListingFromEntity(urn, rev string, body json.RawMessage) (Listing, error) {
	var b listingBody
	if err := json.Unmarshal(body, &b); err != nil {
		return Listing{}, fmt.Errorf("body is not an object: %w", err)
	}
	switch {
	case b.App == nil || *b.App == "":
		return Listing{}, errors.New("app missing")
	case b.Slug == nil || *b.Slug == "":
		return Listing{}, errors.New("slug missing")
	case b.Name == nil:
		return Listing{}, errors.New("name missing")
	case b.Kind == nil || (*b.Kind != "onsite" && *b.Kind != "offsite"):
		return Listing{}, errors.New("kind missing or unknown")
	case b.ContentRating == nil:
		return Listing{}, errors.New("contentRating missing")
	case b.Media == nil:
		return Listing{}, errors.New("media missing")
	case b.Stats == nil:
		return Listing{}, errors.New("stats missing")
	}
	l := Listing{URN: urn, Rev: rev, Body: body, App: *b.App, Slug: *b.Slug, Name: *b.Name, Kind: *b.Kind}
	var err error
	if l.ContentRating, err = nullableString(b.ContentRating); err != nil {
		return Listing{}, fmt.Errorf("contentRating: %w", err)
	}
	if l.Category, err = nullableString(b.Category); err != nil {
		return Listing{}, fmt.Errorf("category: %w", err)
	}
	if l.CreatorID, err = creatorID(b.Creator); err != nil {
		return Listing{}, fmt.Errorf("creator: %w", err)
	}
	if l.CreatedAt, err = nullableTime(b.CreatedAt); err != nil {
		return Listing{}, fmt.Errorf("createdAt: %w", err)
	}
	if l.UpdatedAt, err = nullableTime(b.UpdatedAt); err != nil {
		return Listing{}, fmt.Errorf("updatedAt: %w", err)
	}
	s := b.Stats
	for _, f := range []struct {
		name string
		v    *int64
		dst  *int64
	}{
		{"recommendedCount", s.RecommendedCount, &l.Stats.RecommendedCount},
		{"notRecommendedCount", s.NotRecommendedCount, &l.Stats.NotRecommendedCount},
		{"reviewCount", s.ReviewCount, &l.Stats.ReviewCount},
		{"installCount", s.InstallCount, &l.Stats.InstallCount},
	} {
		if f.v == nil || *f.v < 0 {
			return Listing{}, fmt.Errorf("stats.%s missing or negative", f.name)
		}
		*f.dst = *f.v
	}
	if s.OpenCount != nil && string(s.OpenCount) != "null" {
		var n int64
		if err := json.Unmarshal(s.OpenCount, &n); err != nil || n < 0 {
			return Listing{}, errors.New("stats.openCount: not a count or null")
		}
		l.Stats.OpenCount = &n
	}
	l.Media = make([]ListingMedia, 0, len(b.Media))
	for i, raw := range b.Media {
		m, err := mediaFrom(raw)
		if err != nil {
			return Listing{}, fmt.Errorf("media[%d]: %w", i, err)
		}
		m.Position = i
		l.Media = append(l.Media, m)
	}
	return l, nil
}

func mediaFrom(raw json.RawMessage) (ListingMedia, error) {
	var mb mediaBody
	if err := json.Unmarshal(raw, &mb); err != nil {
		return ListingMedia{}, errors.New("not an object")
	}
	switch {
	case mb.Slot == nil || !mediaSlots[*mb.Slot]:
		return ListingMedia{}, errors.New("slot missing or unknown")
	case mb.Host == nil || !mediaHosts[*mb.Host]:
		return ListingMedia{}, errors.New("host missing or unknown")
	case mb.URL == nil || *mb.URL == "":
		return ListingMedia{}, errors.New("url missing")
	case mb.NsfwLevel == nil:
		return ListingMedia{}, errors.New("nsfwLevel missing")
	case mb.Rating == nil || !mediaRatings[*mb.Rating]:
		return ListingMedia{}, errors.New("rating missing or unknown")
	}
	m := ListingMedia{Slot: *mb.Slot, Host: *mb.Host, URL: *mb.URL, NsfwLevel: *mb.NsfwLevel, Rating: *mb.Rating}
	var err error
	if m.Caption, err = nullableString(mb.Caption); err != nil {
		return ListingMedia{}, fmt.Errorf("caption: %w", err)
	}
	if m.CoverURL, err = nullableString(mb.CoverURL); err != nil {
		return ListingMedia{}, fmt.Errorf("coverUrl: %w", err)
	}
	return m, nil
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

// DecodeListing is the upsert change of a store-listing@v1 entity (ListingFromEntity).
func DecodeListing(urn, rev string, body json.RawMessage) (Change, error) {
	l, err := ListingFromEntity(urn, rev, body)
	if err != nil {
		return Change{}, err
	}
	return Change{Kind: ChangeUpsert, Listing: l}, nil
}

// Listings is the listings read model's state: the generations of the store-listing@v1 stream.
// There is no read API yet (slice 3); Get and Count exist for the ingest's checks and tests.
type Listings interface {
	Generations
	// Count is how many listings gen holds. The consumer holds a snapshot that ends with none.
	Count(ctx context.Context, gen int64) (int, error)
	// Get is one listing of gen, with its media in stream order; false when gen does not hold it.
	Get(ctx context.Context, gen int64, urn string) (Listing, bool, error)
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
	if ok {
		l.Body = bytes.Clone(l.Body)
		l.Media = slices.Clone(l.Media)
	}
	return l, ok, nil
}
