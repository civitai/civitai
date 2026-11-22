package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/listingread"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// The listing routes (LISTINGS-READ-MODEL.md; README, "Listing API"), registered only while the
// listings read model is on (Server.Listings set):
//
//	GET /listings?sort=&kind=&category=&userId=&cursor=&limit=  → {"items":[card…], "nextCursor"?}
//	GET /listings?slugs=a,b,c&kind=&category=                     → {"items":[card…]}
//	GET /listings/{slug}                                            → detail, or 404
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
	Items      []listingread.Card `json:"items"`
	NextCursor string             `json:"nextCursor,omitempty"`
}

// ParseListingsQuery validates the GET /listings parameters. Defaults are the store grid's: kind
// all, sort top-rated, limit 20. `slugs` (comma-separated, at most listingread.MaxSlugs, each at
// most MaxSlugLen bytes) asks for those listings' cards instead of a ranked page: the site keeps its
// own search path (the app index's /search under its viewerNotRoutable rule) and hydrates the
// slugs it found here, as listStoreListingsBySlugs does from the database. It takes the kind and
// category filters and nothing that pages (cursor) or narrows by developer (userId). slugs is nil
// when the parameter is absent; present but empty, it is an empty, non-nil list.
func ParseListingsQuery(v map[string][]string) (listingread.ListQuery, []string, error) {
	get := func(k string) string {
		if xs := v[k]; len(xs) > 0 {
			return xs[len(xs)-1]
		}
		return ""
	}
	q := listingread.ListQuery{Category: get("category"), Sort: get("sort"), Cursor: get("cursor"), Limit: DefaultLimit}
	if _, ok := v["q"]; ok {
		// Refused rather than ignored: a caller that sent it would otherwise get an unfiltered page.
		return q, nil, errors.New("q is not supported: search through /search, then hydrate with slugs")
	}
	switch k := get("kind"); k {
	case "", "all":
	case "onsite", "offsite":
		q.Kind = k
	default:
		return q, nil, errors.New("kind must be all, onsite or offsite")
	}
	switch q.Sort {
	case "":
		q.Sort = listingread.SortTopRated
	case listingread.SortTopRated, listingread.SortPopular, listingread.SortNewest, listingread.SortName:
	default:
		return q, nil, errors.New("sort must be top-rated, popular, newest or name")
	}
	if len(q.Category) > MaxFilterLen {
		return q, nil, errors.New("category is too long")
	}
	if len(q.Cursor) > MaxCursorLen {
		return q, nil, errors.New("cursor is too long")
	}
	if l := get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > MaxLimit {
			return q, nil, errors.New("limit must be 1 to 50")
		}
		q.Limit = n
	}
	if u := get("userId"); u != "" {
		n, err := strconv.ParseInt(u, 10, 64)
		if err != nil || n < 1 {
			return q, nil, errors.New("userId must be a positive integer")
		}
		q.UserID = &n
	}
	if _, ok := v["slugs"]; !ok {
		return q, nil, nil
	}
	if q.Cursor != "" || q.UserID != nil {
		return q, nil, errors.New("slugs takes no cursor and no userId")
	}
	slugs := []string{}
	for _, s := range strings.Split(get("slugs"), ",") {
		if s == "" {
			continue
		}
		if len(s) > MaxSlugLen {
			return q, nil, errors.New("a slug is longer than 64 bytes")
		}
		slugs = append(slugs, s)
	}
	if len(slugs) > listingread.MaxSlugs {
		return q, nil, errors.New("at most 50 slugs")
	}
	return q, slugs, nil
}

// listingRequest runs the steps every listing route shares, then fn: the configuration, the
// viewer, and the serving generation. It counts the outcome fn's answer reports.
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
	q, slugs, err := ParseListingsQuery(r.URL.Query())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "bad_request", Message: err.Error()})
		return "bad_request"
	}
	keys, err := s.keys.keys(ctx, s.Listings, gen, s.SearchTimeout)
	if err != nil {
		return s.fail(w, "listing keys", err)
	}
	var page listingread.Page
	userID := q.UserID
	if slugs != nil {
		page = listingread.BySlugs(keys, slugs, q.Kind, q.Category, v)
		userID = nil
	} else {
		page = listingread.Rank(keys, q, v)
	}
	listings, err := s.Listings.GetMany(ctx, gen.ID, page.URNs)
	if err != nil {
		return s.fail(w, "listing page", err)
	}
	// The gate and the filters again, on the rows that are projected: the consumer keeps writing
	// the serving generation, so a listing ranked above may have been re-rated or re-kinded since.
	// Such a row is left out, and the page is short by it; it is never shown to a viewer the
	// listing no longer admits.
	admitted := listingread.Filter(listings, q.Kind, q.Category, userID, v)
	byURN := make(map[string]store.Listing, len(admitted))
	for _, l := range admitted {
		byURN[l.URN] = l
	}
	res := listingsResponse{Items: []listingread.Card{}, NextCursor: page.NextCursor}
	for _, urn := range page.URNs {
		// A listing deleted between the two reads, or no longer admitted, is left out, as the site's
		// hydration drops an id with no row.
		l, ok := byURN[urn]
		if !ok {
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
