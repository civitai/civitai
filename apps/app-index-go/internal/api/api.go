// Package api is the service's HTTP surface:
//
//	GET /search?q=&kind=&category=&limit=
//	    → {"results":[{urn, slug, name, tagline, kind, category, rating, iconUrl, creator}]}
//	GET /healthz  the process is up
//	GET /readyz   200 once a generation is serving (the first Live), 503 before
//	GET /metrics  Prometheus
//
// Results are in relevance order (store.Query), at most `limit` of them. There is one page: no
// other sort and no paging, since no caller reads either.
//
// Every /search response, success or error, allows any origin (CORS), so an app in a sandboxed
// iframe can call it straight from the browser: it answers only public listings, takes no
// credentials and sets no cookies. The other routes send no CORS header: they are for probes
// and monitoring, not for browsers.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
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

// Server answers the HTTP API from a store.
type Server struct {
	Store    store.Store
	Metrics  *metrics.Metrics
	Gatherer prometheus.Gatherer
	Log      *slog.Logger
	// SearchTimeout bounds one search's store query.
	SearchTimeout time.Duration
}

// Handler is the routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /readyz", s.readyz)
	mux.HandleFunc("GET /search", s.search)
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.Gatherer, promhttp.HandlerOpts{}))
	return mux
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
	writeJSON(w, http.StatusOK, res)
}

// ParseQuery validates the search parameters.
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
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
