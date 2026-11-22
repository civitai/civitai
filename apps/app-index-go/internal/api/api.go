// Package api is the service's HTTP surface:
//
//	GET /search?q=&kind=&category=&mature=&limit=
//	    → {"results":[{urn, slug, name, tagline, kind, category, rating, iconUrl, creator}]}
//	GET /healthz  the process is up
//	GET /readyz   200 once a generation is serving (the first Live), 503 before
//	GET /metrics  Prometheus
//	GET /listings, GET /listings/{slug}  the listing API, only while the listings read model is on
//	    (listings.go)
//
// `mature` is the mature content ratings the caller's viewer may see, a comma-separated list of
// r, x and xxx (ParseQuery). Absent or empty, a search answers only apps rated g, pg or pg13: what
// the anonymous registry audience reads. The caller is trusted to send its viewer's own set; the
// parameter is part of the URL, so a shared cache keys on it.
//
// Results are in relevance order (store.Query), at most `limit` of them. There is one page: no
// other sort and no paging, since no caller reads either.
//
// Every /search response, success or error, allows any origin (CORS), so an app in a sandboxed
// iframe can call it straight from the browser: it answers only public listings, takes no
// credentials and sets no cookies. `OPTIONS /search` answers a CORS preflight. The other routes
// send no CORS header: they are for probes and monitoring, not for browsers.
//
// A 200 from /search is cacheable for SearchCacheControl's 30 s, so a shared cache in front of
// the service can absorb repeated searches. Every other response, errors included, is no-store.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/civitai/civitai/apps/app-index-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// Bounds of the query parameters.
const (
	MaxQueryLen  = 200
	MaxFilterLen = 64
	DefaultLimit = 20
	MaxLimit     = 50
)

// Response headers.
const (
	// SearchCacheControl is the Cache-Control of a 200 from /search: a shared cache may hold an
	// answer for 30 s (s-maxage), so repeated searches never reach the store, while browsers
	// revalidate every time (max-age=0).
	SearchCacheControl = "public, max-age=0, s-maxage=30"
	// NoStore is the Cache-Control of every other response.
	NoStore = "no-store"
	// PreflightMaxAge is how long, in seconds, a browser may reuse a /search preflight answer.
	PreflightMaxAge = "86400"
)

// Server answers the HTTP API from a store.
type Server struct {
	Store    store.Store
	Metrics  *metrics.Metrics
	Gatherer prometheus.Gatherer
	Log      *slog.Logger
	// SearchTimeout bounds one search's store query, and one listing request's store reads.
	SearchTimeout time.Duration

	// Listings is the listings read model, nil while APP_INDEX_LISTINGS is off: the listing routes
	// (listings.go) are then not registered at all, so they answer 404.
	Listings store.Listings
	// ViewerKey verifies the viewer token of a listing request (APP_INDEX_VIEWER_KEY), and
	// ViewerKeyNext, when set, too (APP_INDEX_VIEWER_KEY_NEXT, for a rotation with no 401 window).
	// The current key shorter than listingread.MinViewerKeyLen (unset included), or a next key set
	// but short, makes every listing request answer 503 `unconfigured` and read nothing.
	ViewerKey     []byte
	ViewerKeyNext []byte
	// ListingsLayout is the row layout the listings consumer builds (index.ListingsLayoutVersion).
	// A serving generation of another layout is answered 503 `not_ready` until the rebuild beside
	// it switches over: its rows may lack what the gates read. 0 checks nothing.
	ListingsLayout int
	// ListingReads counts listing requests (metrics.NewListingReads); nil counts nothing.
	ListingReads *prometheus.CounterVec
	// Now is the clock viewer tokens are checked against; nil is time.Now.
	Now func() time.Time

	// keys memoises the serving generation's listing keys per (generation, cursor)
	// (listings_keys_memo.go). Its zero value is empty.
	keys keysMemo
}

// Handler is the routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("GET /search", s.search)
	mux.HandleFunc("OPTIONS /search", preflight)
	if s.Listings != nil {
		mux.HandleFunc("GET /listings", s.listingRequest("list", s.listListings))
		mux.HandleFunc("GET /listings/{slug}", s.listingRequest("detail", s.listingDetail))
	}
	metricsHandler := promhttp.HandlerFor(s.Gatherer, promhttp.HandlerOpts{})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", NoStore)
		metricsHandler.ServeHTTP(w, r)
	})
	return mux
}

// preflight answers a CORS preflight for /search: 204, no body.
func preflight(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET")
	h.Set("Access-Control-Max-Age", PreflightMaxAge)
	h.Set("Cache-Control", NoStore)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	st, err := s.Store.State(r.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ready": false, "error": "store"})
		return
	}
	if st.Serving == nil {
		s.Metrics.Ready.Set(0)
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ready": false})
		return
	}
	s.Metrics.Ready.Set(1)
	writeJSON(w, http.StatusOK, map[string]any{"ready": true, "generation": st.Serving.ID})
}

type response struct {
	Results []store.Result `json:"results"`
}

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	outcome := "ok"
	// Before any write, so every status (200, 400, 500, 503) carries it.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	defer func() {
		s.Metrics.Searches.WithLabelValues(outcome).Inc()
		s.Metrics.SearchTime.Observe(time.Since(start).Seconds())
	}()
	q, err := ParseQuery(r.URL.Query())
	if err != nil {
		outcome = "bad_request"
		writeJSON(w, http.StatusBadRequest, apiError{Error: "bad_request", Message: err.Error()})
		return
	}
	ctx := r.Context()
	if s.SearchTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.SearchTimeout)
		defer cancel()
	}
	page, err := s.Store.Search(ctx, q)
	switch {
	case errors.Is(err, store.ErrNotReady):
		outcome = "not_ready"
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "not_ready"})
		return
	case err != nil:
		outcome = "error"
		s.Log.Warn("search", "err", err)
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "internal"})
		return
	}
	res := response{Results: page.Results}
	if res.Results == nil {
		res.Results = []store.Result{}
	}
	writeJSONCache(w, http.StatusOK, res, SearchCacheControl)
}

// ParseQuery validates the search parameters. `mature` names the mature ratings the viewer may
// see (store.Mature): each comma-separated element must be exactly r, x or xxx (repeats are
// harmless); absent or empty is none, the SFW audience.
func ParseQuery(v map[string][]string) (store.Query, error) {
	get := func(k string) string {
		if xs := v[k]; len(xs) > 0 {
			return xs[len(xs)-1]
		}
		return ""
	}
	q := store.Query{Text: get("q"), Kind: get("kind"), Category: get("category"), Limit: DefaultLimit}
	if utf8.RuneCountInString(q.Text) > MaxQueryLen || !utf8.ValidString(q.Text) {
		return store.Query{}, errors.New("q is too long or not UTF-8")
	}
	switch q.Kind {
	case "", "onsite", "offsite":
	default:
		return store.Query{}, errors.New("kind must be onsite or offsite")
	}
	if len(q.Category) > MaxFilterLen {
		return store.Query{}, errors.New("category is too long")
	}
	if m := get("mature"); m != "" {
		for _, r := range strings.Split(m, ",") {
			switch r {
			case "r":
				q.Mature.R = true
			case "x":
				q.Mature.X = true
			case "xxx":
				q.Mature.XXX = true
			default:
				return store.Query{}, errors.New("mature must be a comma-separated list of r, x and xxx")
			}
		}
	}
	if l := get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > MaxLimit {
			return store.Query{}, errors.New("limit must be 1 to 50")
		}
		q.Limit = n
	}
	return q, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	writeJSONCache(w, status, v, NoStore)
}

func writeJSONCache(w http.ResponseWriter, status int, v any, cacheControl string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", cacheControl)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
