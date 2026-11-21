package listingread

import (
	"encoding/json"
	"fmt"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// Media is a listing's media as one request may see them: what projectListingMedia
// (listing-media-audience.ts) returns for a public view.
type Media struct {
	IconURL     *string
	CoverURL    *string
	Screenshots []Screenshot
}

// Screenshot is one gallery entry (ListingGalleryScreenshot).
type Screenshot struct {
	URL     string  `json:"url"`
	Caption *string `json:"caption"`
}

// ProjectMedia mirrors projectListingMedia for a public view of l's stored media items (every
// item the adapter published, each with its own level; store.ListingMedia):
//
//   - the ceiling is listingMediaCeiling(viewer, contentRating);
//   - the civitai.red overrides (Host "red") exist only on a red-capable host, each gated by the
//     same ceiling and preferred over the own image of its slot;
//   - the icon is the red icon if visible, else the own icon if visible, else nil;
//   - the cover is the red cover, else the own cover, else the first visible screenshot at cover
//     width (its CoverURL), else nil (gatedListingCoverUrl);
//   - the gallery is the visible screenshots in stream order (gatedListingScreenshots), and only
//     with gallery, as the card asks for none.
//
// The URLs are the stream's own: the adapter built each with the same builder the store uses for
// that slot (registryListingMedia), so nothing is rebuilt here.
func ProjectMedia(l store.Listing, v Viewer, gallery bool) Media {
	// The listing's own rating, as projectListingMedia reads row.contentRating (the listing
	// column), never the app entity's, which falls back to the block's.
	ceiling := listingMediaCeiling(v, l.ListingContentRating)
	var ownIcon, ownCover, redIcon, redCover *store.ListingMedia
	var shots []store.ListingMedia
	first := func(p **store.ListingMedia, m store.ListingMedia) {
		if *p == nil {
			*p = &m
		}
	}
	for _, m := range l.Media {
		switch {
		case m.Host == "any" && m.Slot == "icon":
			first(&ownIcon, m)
		case m.Host == "any" && m.Slot == "cover":
			first(&ownCover, m)
		case m.Host == "any" && m.Slot == "screenshot":
			shots = append(shots, m)
		case m.Host == "red" && m.Slot == "icon":
			first(&redIcon, m)
		case m.Host == "red" && m.Slot == "cover":
			first(&redCover, m)
		}
	}
	if !v.RedCapable {
		redIcon, redCover = nil, nil
	}
	visible := func(m *store.ListingMedia) bool { return m != nil && visibleAt(m.NsfwLevel, ceiling) }
	var out Media
	for _, m := range []*store.ListingMedia{redIcon, ownIcon} {
		if visible(m) {
			out.IconURL = &m.URL
			break
		}
	}
	for _, m := range []*store.ListingMedia{redCover, ownCover} {
		if visible(m) {
			out.CoverURL = &m.URL
			break
		}
	}
	if out.CoverURL == nil {
		for i := range shots {
			if visible(&shots[i]) && shots[i].CoverURL != "" {
				out.CoverURL = &shots[i].CoverURL
				break
			}
		}
	}
	if gallery {
		out.Screenshots = []Screenshot{}
		for i := range shots {
			if !visible(&shots[i]) {
				continue
			}
			s := Screenshot{URL: shots[i].URL}
			if shots[i].Caption != "" {
				c := shots[i].Caption
				s.Caption = &c
			}
			out.Screenshots = append(out.Screenshots, s)
		}
	}
	return out
}

// Admits is the store's per-listing viewer gate as the read model applies it: the scope's kind
// rule (storeVisibleListingRowGate / listingPublicVisibilityFilter), then the mature rating rule
// (matureRatingAllowed with matureRatingsAllowed) over the listing's own rating, as
// listingMatureFilter reads al.content_rating: a null or unknown rating is not mature, so it is
// admitted, and its media ceiling is PG (nsfwLevelFromContentRating). Everything else the database gate checks (the
// status and level, a shadow revision, the deploy gate, a banned or deleted owner) is applied
// upstream: such a listing is not in the stream.
func Admits(l store.Listing, v Viewer) bool {
	return scopeAdmitsKind(NarrowScope(v.Scope), l.Kind) &&
		matureRatingAllowed(l.ListingContentRating, matureRatingsAllowed(v.RedCapable, v.BrowsingLevel))
}

// Creator is the creator chip (ListingCreatorChip).
type Creator struct {
	ID       int64   `json:"id"`
	Username *string `json:"username"`
	Image    *string `json:"image"`
}

// Recommend is the recommend rollup (ListingRecommendRollup).
type Recommend struct {
	RecommendedCount    int64    `json:"recommendedCount"`
	NotRecommendedCount int64    `json:"notRecommendedCount"`
	RecommendPct        *float64 `json:"recommendPct"`
}

// OnsiteKindData is ListingCardKindData's on-site arm.
type OnsiteKindData struct {
	Kind       string  `json:"kind"`
	AppBlockID *string `json:"appBlockId"`
	HasPage    bool    `json:"hasPage"`
	LiveURL    *string `json:"liveUrl,omitempty"`
}

// OffsiteKindData is ListingCardKindData's off-site arm. The detail's `connectClientId` is never
// in the stream (LISTINGS-READ-MODEL.md, "Never in the stream").
type OffsiteKindData struct {
	Kind        string  `json:"kind"`
	ExternalURL *string `json:"externalUrl"`
}

// Card is ListingCard. `restrictedAudience` is always null: the stream holds only public listings,
// and a public listing has no restricted audience to show any viewer.
type Card struct {
	ID                 string    `json:"id"`
	Slug               string    `json:"slug"`
	Kind               string    `json:"kind"`
	Name               string    `json:"name"`
	Tagline            *string   `json:"tagline"`
	Category           *string   `json:"category"`
	ContentRating      *string   `json:"contentRating"`
	IconURL            *string   `json:"iconUrl"`
	CoverURL           *string   `json:"coverUrl"`
	Creator            *Creator  `json:"creator"`
	Recommend          Recommend `json:"recommend"`
	ReviewCount        int64     `json:"reviewCount"`
	IsBeta             bool      `json:"isBeta"`
	IsOfficial         bool      `json:"isOfficial"`
	OpenCount          *int64    `json:"openCount"`
	UpdatedAt          *string   `json:"updatedAt,omitempty"`
	RestrictedAudience *string   `json:"restrictedAudience"`
	KindData           any       `json:"kindData"`
}

// Detail is ListingDetail: the card's fields, the description, the install count, the gallery and
// the public detail fields (store.ListingDetail). Not here: the off-site `kindData.connectClientId`,
// which the stream does not carry (LISTINGS-READ-MODEL.md, "Never in the stream").
type Detail struct {
	Card
	Description      *string                 `json:"description"`
	InstallCount     int64                   `json:"installCount"`
	Screenshots      []Screenshot            `json:"screenshots"`
	SerialID         *int64                  `json:"serialId"`
	Collaborators    []store.ListingChip     `json:"collaborators"`
	SourceRepoURL    *string                 `json:"sourceRepoUrl"`
	IssueTrackerURL  *string                 `json:"issueTrackerUrl"`
	ActionsRunSource *store.ListingRunSource `json:"actionsRunSource"`
	Scopes           []string                `json:"scopes"`
	ConnectScopes    []string                `json:"connectScopes"`
	BetaMessage      *string                 `json:"betaMessage"`
	Forkable         bool                    `json:"forkable"`
	ForkOf           *ForkOf                 `json:"forkOf"`
}

// ForkOf is ListingForkOf: the parent's slug and name only when the viewer may see the parent.
type ForkOf struct {
	Visible bool    `json:"visible"`
	Slug    *string `json:"slug,omitempty"`
	Name    *string `json:"name,omitempty"`
}

// ForkParentSlug is the slug of the listing l's fork parent the read API must look up for
// ProjectDetail, or "" when there is none to look up (not a fork, or a parent the stream does not
// name).
func ForkParentSlug(l store.Listing) string {
	if f := l.Detail.ForkOf; f != nil && f.Slug != nil {
		return *f.Slug
	}
	return ""
}

// cardBody is the part of a store-listing@v1 body the card and detail read beyond the columns.
type cardBody struct {
	Tagline     *string `json:"tagline"`
	Description *string `json:"description"`
	Creator     *struct {
		ID       *int64  `json:"id"`
		Username *string `json:"username"`
		Image    *string `json:"image"`
	} `json:"creator"`
	IsBeta      bool    `json:"isBeta"`
	IsOfficial  bool    `json:"isOfficial"`
	HasPage     bool    `json:"hasPage"`
	LiveURL     *string `json:"liveUrl"`
	ExternalURL *string `json:"externalUrl"`
	Stats       struct {
		RecommendPct *float64 `json:"recommendPct"`
	} `json:"stats"`
	UpdatedAt *string `json:"updatedAt"`
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func orZero(n *int64) int64 {
	if n == nil {
		return 0
	}
	return *n
}

// ProjectCard is l's card for v (projectListingCard). l must carry its body and media
// (store.Listings GetMany / BySlug). The values are the stream's, which the adapter took from the
// store's own card read (catalog-source.ts storeCardFields), so each is passed through with the
// card's own null rules: the play count is a number on-site (0 when absent, cardOpenCount) and
// null off-site; the review counts are 0 when absent.
func ProjectCard(l store.Listing, v Viewer) (Card, error) {
	c, _, err := project(l, v, false)
	return c.Card, err
}

// ProjectDetail is l's detail for v (getListingDetail): the card, the description, the install
// count (0 when absent), the gallery and the detail fields, each list [] when absent. parent is the
// listing ForkParentSlug names, or nil when there is none or the generation holds none: as
// resolveForkAttribution does, a fork's parent is named only when v may see it (Admits), and a
// hidden parent reads exactly like a missing one, {visible: false}.
func ProjectDetail(l store.Listing, v Viewer, parent *store.Listing) (Detail, error) {
	c, b, err := project(l, v, true)
	if err != nil {
		return Detail{}, err
	}
	d := l.Detail
	out := Detail{Card: c.Card, Description: b.Description, InstallCount: orZero(l.Stats.InstallCount),
		Screenshots: c.screenshots, SerialID: d.SerialID, Collaborators: orEmpty(d.Collaborators),
		SourceRepoURL: d.SourceRepoURL, IssueTrackerURL: d.IssueTrackerURL, ActionsRunSource: d.ActionsRunSource,
		Scopes: orEmpty(d.Scopes), ConnectScopes: orEmpty(d.ConnectScopes), BetaMessage: d.BetaMessage,
		Forkable: d.Forkable}
	if d.ForkOf != nil {
		out.ForkOf = &ForkOf{}
		if parent != nil && ForkParentSlug(l) == parent.Slug && Admits(*parent, v) {
			out.ForkOf = &ForkOf{Visible: true, Slug: &parent.Slug, Name: &parent.Name}
		}
	}
	return out, nil
}

func orEmpty[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}

type projected struct {
	Card
	screenshots []Screenshot
}

func project(l store.Listing, v Viewer, gallery bool) (projected, cardBody, error) {
	var b cardBody
	if err := json.Unmarshal(l.Body, &b); err != nil {
		return projected{}, cardBody{}, fmt.Errorf("listing %s: %w", l.URN, err)
	}
	media := ProjectMedia(l, v, gallery)
	c := Card{
		ID: l.ID, Slug: l.Slug, Kind: l.Kind, Name: l.Name,
		Tagline: b.Tagline, Category: nullable(l.Category), ContentRating: nullable(l.ListingContentRating),
		IconURL: media.IconURL, CoverURL: media.CoverURL,
		Recommend: Recommend{
			RecommendedCount:    orZero(l.Stats.RecommendedCount),
			NotRecommendedCount: orZero(l.Stats.NotRecommendedCount),
			RecommendPct:        b.Stats.RecommendPct,
		},
		ReviewCount: orZero(l.Stats.ReviewCount),
		IsBeta:      b.IsBeta, IsOfficial: b.IsOfficial,
		UpdatedAt: b.UpdatedAt,
	}
	if b.Creator != nil && b.Creator.ID != nil {
		c.Creator = &Creator{ID: *b.Creator.ID, Username: b.Creator.Username, Image: b.Creator.Image}
	}
	if l.Kind == "onsite" {
		n := orZero(l.Stats.OpenCount)
		c.OpenCount = &n
		c.KindData = OnsiteKindData{Kind: "onsite", AppBlockID: l.Detail.AppBlockID, HasPage: b.HasPage, LiveURL: b.LiveURL}
	} else {
		c.KindData = OffsiteKindData{Kind: l.Kind, ExternalURL: b.ExternalURL}
	}
	return projected{Card: c, screenshots: media.Screenshots}, b, nil
}
