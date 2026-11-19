// Package api is the service's HTTP surface:
//
//	GET /search?q=&kind=&category=&sort=(relevance|newest|name)&limit=&cursor=
//	    → {"results":[{urn, slug, name, tagline, kind, category, rating, iconUrl, creator}], "next"}
//	GET /healthz  the process is up
//	GET /readyz   200 once a generation is serving (the first Live), 503 before
//	GET /metrics  Prometheus
//
// `next` is an opaque keyset cursor for the next page, null on the last. It has nothing to do with
// registry cursors. A cursor is bound to the sort and filters it was issued for; presented with
// others it is a 400.
package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
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
	MaxQueryLen    = 200
	MaxFilterLen   = 64
	DefaultLimit   = 20
	MaxLimit       = 50
	maxCursorBytes = 1024
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
	Next    *string        `json:"next"`
}

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	outcome := "ok"
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
	if page.Next != nil {
		c := EncodeCursor(q, *page.Next)
		res.Next = &c
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
	switch s := store.Sort(get("sort")); s {
	case "":
		q.Sort = store.SortRelevance
		if strings.TrimSpace(q.Text) == "" {
			q.Sort = store.SortName
		}
	case store.SortRelevance, store.SortNewest, store.SortName:
		q.Sort = s
	default:
		return store.Query{}, errors.New("sort must be relevance, newest or name")
	}
	if l := get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > MaxLimit {
			return store.Query{}, errors.New("limit must be 1 to 50")
		}
		q.Limit = n
	}
	if c := get("cursor"); c != "" {
		k, err := DecodeCursor(q, c)
		if err != nil {
			return store.Query{}, err
		}
		q.After = &k
	}
	return q, nil
}

type cursorJSON struct {
	F string `json:"f"` // the query the cursor belongs to (queryTag)
	store.Key
}

// queryTag ties a cursor to its sort and filters: a short hash, so the cursor does not echo the
// query text.
func queryTag(q store.Query) string {
	h := sha256.New()
	for _, part := range []string{string(q.Sort), strings.Join(store.Tokens(q.Text), " "), q.Kind, q.Category} {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(part))) //nolint:gosec // bounded by the parameter limits
		h.Write(n[:])
		h.Write([]byte(part))
	}
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil)[:9])
}

// EncodeCursor is the opaque `next` of a page.
func EncodeCursor(q store.Query, k store.Key) string {
	b, _ := json.Marshal(cursorJSON{F: queryTag(q), Key: k})
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeCursor reads a `cursor` parameter issued for q.
func DecodeCursor(q store.Query, c string) (store.Key, error) {
	if len(c) > maxCursorBytes {
		return store.Key{}, errors.New("cursor is invalid")
	}
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return store.Key{}, errors.New("cursor is invalid")
	}
	var cj cursorJSON
	if err := json.Unmarshal(raw, &cj); err != nil || cj.URN == "" {
		return store.Key{}, errors.New("cursor is invalid")
	}
	if cj.F != queryTag(q) {
		return store.Key{}, errors.New("cursor belongs to another query")
	}
	return cj.Key, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
