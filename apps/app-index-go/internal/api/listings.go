package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/listingread"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// The listing routes (LISTINGS-READ-MODEL.md; README, "Listing API"), registered only while the
// listings read model is on (Server.Listings set):
//
//	GET /listings?sort=&kind=&category=&userId=&cursor=&limit=[&subListings=1]
//	                                                → {"items":[card…], "nextCursor"?, "subListings"?}
//	GET /listings?slugs=a,b,c&kind=&category=       → {"items":[card…]}
//	GET /listings?subListingIds=asl_…&kind=&category=&userId=
//	                                                → {"items":[sub-listing card…], "subListings":true}
//	GET /listings/{slug}                            → detail, or 404
//
// With subListings=1 a page mixes the listings' sub-listing cards in (listingread.Rank), and the
// answer says so ("subListings":true), so the web tier can tell it from the answer of a service that
// does not know the parameter and would have ignored it.
//
// Every request carries the viewer the web tier resolved, signed (listingread.ViewerHeader,
// listingread.ParseViewer); without a valid one the answer is 401 and nothing is read. Every
// answer is per viewer, so every response is no-store, and none carries a CORS header: these
// routes are for the web tier, never a browser.

// Bounds of the listing query parameters (listAppListingsSchema).
const (
	MaxCursorLen = 512
	MaxSlugLen   = 64
)

type listingsResponse struct {
	// Items is listingread.Card and, with sub-listings, listingread.SubListingCard values.
	Items      []any  `json:"items"`
	NextCursor string `json:"nextCursor,omitempty"`
	// SubListings is set on every answer that could carry sub-listing cards (subListings=1, or
	// subListingIds).
	SubListings bool `json:"subListings,omitempty"`
	// CappedListings, on a subListingIds answer, is the id of every listing this viewer could find
	// with these filters whose stream left sub-listings out (store.Listing.SubListingsOmitted): an
	// item of one of them that is not found here may only be past the cap.
	CappedListings []string `json:"cappedListings,omitempty"`
}

// listingsParams is a validated GET /listings query: a ranked page (Query), or the hydration of
// Slugs (non-nil when `slugs` was given) or of SubListingIDs (non-nil when `subListingIds` was).
type listingsParams struct {
	Query         listingread.ListQuery
	Slugs         []string
	SubListingIDs []string
}

// ParseListingsQuery validates the GET /listings parameters. Defaults are the store grid's: kind
// all, sort top-rated, limit 20, no sub-listings. `subListings=1` mixes sub-listing cards in, as
// the grid's `includeSubListings` does. `slugs` (comma-separated, at most listingread.MaxSlugs, each
// at most MaxSlugLen bytes) asks for those listings' cards instead of a ranked page: the site keeps
// its own search path (the app index's /search under its viewerNotRoutable rule) and hydrates the
// slugs it found here, as listStoreListingsBySlugs does from the database. It takes the kind and
// category filters and nothing that pages (cursor) or narrows by developer (userId).
// `subListingIds` (at most listingread.MaxSubListingIDs, each at most MaxSlugLen bytes) asks for
// those sub-listings' cards, as listStoreSubListingsByIds does: the kind, category and developer
// filters, no cursor. A list parameter present but empty is an empty, non-nil list.
func ParseListingsQuery(v map[string][]string) (listingsParams, error) {
	get := func(k string) string {
		if xs := v[k]; len(xs) > 0 {
			return xs[len(xs)-1]
		}
		return ""
	}
	q := listingread.ListQuery{Category: get("category"), Sort: get("sort"), Cursor: get("cursor"), Limit: DefaultLimit}
	p := listingsParams{}
	if _, ok := v["q"]; ok {
		// Refused rather than ignored: a caller that sent it would otherwise get an unfiltered page.
		return p, errors.New("q is not supported: search through /search, then hydrate with slugs")
	}
	switch k := get("kind"); k {
	case "", "all":
	case "onsite", "offsite":
		q.Kind = k
	default:
		return p, errors.New("kind must be all, onsite or offsite")
	}
	switch q.Sort {
	case "":
		q.Sort = listingread.SortTopRated
	case listingread.SortTopRated, listingread.SortPopular, listingread.SortNewest, listingread.SortName:
	default:
		return p, errors.New("sort must be top-rated, popular, newest or name")
	}
	if len(q.Category) > MaxFilterLen {
		return p, errors.New("category is too long")
	}
	if len(q.Cursor) > MaxCursorLen {
		return p, errors.New("cursor is too long")
	}
	if l := get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > MaxLimit {
			return p, errors.New("limit must be 1 to 50")
		}
		q.Limit = n
	}
	if u := get("userId"); u != "" {
		n, err := strconv.ParseInt(u, 10, 64)
		if err != nil || n < 1 {
			return p, errors.New("userId must be a positive integer")
		}
		q.UserID = &n
	}
	switch get("subListings") {
	case "":
	case "1":
		q.SubListings = true
	default:
		return p, errors.New("subListings must be 1")
	}
	list := func(name string, max int, what string) ([]string, error) {
		out := []string{}
		for _, s := range strings.Split(get(name), ",") {
			if s == "" {
				continue
			}
			if len(s) > MaxSlugLen {
				return nil, errors.New("a " + what + " is longer than 64 bytes")
			}
			out = append(out, s)
		}
		if len(out) > max {
			return nil, errors.New("at most " + strconv.Itoa(max) + " " + what + "s")
		}
		return out, nil
	}
	_, slugs := v["slugs"]
	_, subIDs := v["subListingIds"]
	p.Query = q
	switch {
	case slugs && subIDs:
		return p, errors.New("slugs and subListingIds are exclusive")
	case slugs:
		if q.Cursor != "" || q.UserID != nil || q.SubListings {
			return p, errors.New("slugs takes no cursor, no userId and no subListings")
		}
		var err error
		if p.Slugs, err = list("slugs", listingread.MaxSlugs, "slug"); err != nil {
			return p, err
		}
	case subIDs:
		if q.Cursor != "" {
			return p, errors.New("subListingIds takes no cursor")
		}
		var err error
		if p.SubListingIDs, err = list("subListingIds", listingread.MaxSubListingIDs, "sub-listing id"); err != nil {
			return p, err
		}
	}
	return p, nil
}

// listingRequest runs the steps every listing route shares, then fn: the configuration, the
// viewer, the serving generation, and that it holds no stale row. It counts the outcome fn's
// answer reports.
func (s *Server) listingRequest(route string, fn func(ctx context.Context, w http.ResponseWriter, r *http.Request,
	v listingread.Viewer, gen store.Generation) string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		outcome := "ok"
		defer func() {
			if s.ListingReads != nil {
				s.ListingReads.WithLabelValues(route, outcome).Inc()
			}
		}()
		keys := s.viewerKeys()
		if !listingread.KeysUsable(keys) {
			outcome = "unconfigured"
			writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "unconfigured"})
			return
		}
		now := time.Now
		if s.Now != nil {
			now = s.Now
		}
		v, err := listingread.ParseViewer(keys, r.Header.Get(listingread.ViewerHeader), now())
		if err != nil {
			outcome = "bad_viewer"
			writeJSON(w, http.StatusUnauthorized, apiError{Error: "bad_viewer"})
			return
		}
		ctx := r.Context()
		if s.SearchTimeout > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, s.SearchTimeout)
			defer cancel()
		}
		st, err := s.Listings.State(ctx)
		if err != nil {
			outcome = "error"
			s.Log.Warn("listings state", "err", err)
			writeJSON(w, http.StatusInternalServerError, apiError{Error: "internal"})
			return
		}
		if st.Serving == nil || (s.ListingsLayout != 0 && st.Serving.Layout != s.ListingsLayout) {
			outcome = "not_ready"
			writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "not_ready"})
			return
		}
		// A stale row (store.ChangeStale) may lack a change its unusable upsert carried, a stricter
		// gate included, so while the serving generation holds one nothing is answered from it: the
		// same 503 not_ready as before Live, which the web tier reads the database on.
		stale, err := s.Listings.StaleCount(ctx, st.Serving.ID)
		if err != nil {
			outcome = s.fail(w, "listings stale rows", err)
			return
		}
		if stale > 0 {
			outcome = "stale"
			writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "not_ready"})
			return
		}
		outcome = fn(ctx, w, r, v, *st.Serving)
	}
}

// viewerKeys is the keys a viewer token may be signed with: the current one, and the next one
// when it is set (an empty next key is unset, never a key).
func (s *Server) viewerKeys() [][]byte {
	keys := [][]byte{s.ViewerKey}
	if len(s.ViewerKeyNext) > 0 {
		keys = append(keys, s.ViewerKeyNext)
	}
	return keys
}

// fail answers a store error: a generation dropped under the request (a switch-over) is 503, so the
// web tier never takes a partial read for a real answer; anything else is 500.
func (s *Server) fail(w http.ResponseWriter, what string, err error) string {
	if errors.Is(err, store.ErrNoGeneration) {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "not_ready"})
		return "not_ready"
	}
	s.Log.Warn(what, "err", err)
	writeJSON(w, http.StatusInternalServerError, apiError{Error: "internal"})
	return "error"
}

func (s *Server) listListings(ctx context.Context, w http.ResponseWriter, r *http.Request, v listingread.Viewer, gen store.Generation) string {
	p, err := ParseListingsQuery(r.URL.Query())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "bad_request", Message: err.Error()})
		return "bad_request"
	}
	q := p.Query
	keys, err := s.keys.keys(ctx, s.Listings, gen, s.SearchTimeout)
	if err != nil {
		return s.fail(w, "listing keys", err)
	}
	var page listingread.Page
	var capped []string
	userID := q.UserID
	switch {
	case p.Slugs != nil:
		page = listingread.BySlugs(keys, p.Slugs, q.Kind, q.Category, v)
		userID = nil
	case p.SubListingIDs != nil:
		page = listingread.BySubListingIDs(keys, p.SubListingIDs, q.Kind, q.Category, q.UserID, v)
		for _, l := range listingread.Filter(keys, q.Kind, q.Category, q.UserID, v) {
			if l.SubListingsOmitted > 0 {
				capped = append(capped, l.ID)
			}
		}
		slices.Sort(capped)
	default:
		page = listingread.Rank(keys, q, v)
	}
	listings, err := s.Listings.GetMany(ctx, gen.ID, page.URNs)
	if err != nil {
		return s.fail(w, "listing page", err)
	}
	// The gate and the filters again, on the rows that are projected: the consumer keeps writing
	// the serving generation, so a listing ranked above may have been re-rated or re-kinded since,
	// or its sub-listing re-rated or gone. Such a row is left out, and the page is short by it; it
	// is never shown to a viewer the listing no longer admits.
	admitted := listingread.Filter(listings, q.Kind, q.Category, userID, v)
	byURN := make(map[string]store.Listing, len(admitted))
	for _, l := range admitted {
		byURN[l.URN] = l
	}
	res := listingsResponse{Items: []any{}, NextCursor: page.NextCursor,
		SubListings: q.SubListings || p.SubListingIDs != nil, CappedListings: capped}
	for i, urn := range page.URNs {
		// A listing deleted between the two reads, or no longer admitted, is left out, as the site's
		// hydration drops an id with no row.
		l, ok := byURN[urn]
		if !ok {
			continue
		}
		if id := page.SubListings[i]; id != "" {
			sub, ok := listingread.SubListingOf(l, id)
			if !ok || !listingread.SubListingAdmits(sub, v) {
				continue
			}
			res.Items = append(res.Items, listingread.ProjectSubListingCard(l, sub, v))
			continue
		}
		c, err := listingread.ProjectCard(l, v)
		if err != nil {
			return s.fail(w, "listing card", err)
		}
		res.Items = append(res.Items, c)
	}
	writeJSON(w, http.StatusOK, res)
	return "ok"
}

func (s *Server) listingDetail(ctx context.Context, w http.ResponseWriter, r *http.Request, v listingread.Viewer, gen store.Generation) string {
	slug := r.PathValue("slug")
	if slug == "" || len(slug) > MaxSlugLen {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "bad_request", Message: "slug must be 1 to 64 bytes"})
		return "bad_request"
	}
	l, ok, err := s.Listings.BySlug(ctx, gen.ID, slug)
	if err != nil {
		return s.fail(w, "listing detail", err)
	}
	// A listing this viewer may not see is answered exactly like a missing one.
	if !ok || !listingread.Admits(l, v) {
		writeJSON(w, http.StatusNotFound, apiError{Error: "not_found"})
		return "not_found"
	}
	// A fork's parent, from the same generation: ProjectDetail names it only if this viewer may see it.
	var parent *store.Listing
	if ps := listingread.ForkParentSlug(l); ps != "" {
		p, ok, err := s.Listings.BySlug(ctx, gen.ID, ps)
		if err != nil {
			return s.fail(w, "listing fork parent", err)
		}
		if ok {
			parent = &p
		}
	}
	d, err := listingread.ProjectDetail(l, v, parent)
	if err != nil {
		return s.fail(w, "listing detail", err)
	}
	writeJSON(w, http.StatusOK, d)
	return "ok"
}
