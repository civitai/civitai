// Package api is the service's HTTP surface.
//
//	GET /v1/apps/{slug}/collections/{collection}/records[?major=N][&keyPrefix=P]
//	    Authorization: Bearer <the app's hub access token for the signed-in user>
//
// Every private record of one collection of the app `slug` names that the token's user may read
// through the token's app: the app's own collection when slug is the app itself, or another app's
// collection the user granted this app. Which of the two is never the client's to say: both paths
// name the source by slug and leave the basis to the server (the adapter on the registry path, the
// site on REST). The answer is
//
//	{"source":"registry"|"rest","items":[{"urn"?:…,"key":…,"rev":…,"data":{…}}]}
//
// `keyPrefix` keeps only the records whose storage key starts with it, on both paths (the
// document store's own `keyPrefix` on REST). A registry item carries its key beside its URN, as the
// adapter's private feed sends it; a stream whose records carry none cannot be filtered, and a
// `keyPrefix` read of it goes to REST (`unkeyed`).
//
// `source: registry` items come from the user's stream (named by URN: the record core's
// `urn:apps.civitai.com:<slug>/<collection>/<record_id>`); `source: rest` items from the
// document store's list (named by key). See DESIGN.md, "Depends on site changes", on the two names.
//
// With `X-App-Data-Registry-Only: 1` (RegistryOnlyHeader) a read that the registry cannot answer is
// not read from REST: the answer is `{"source":"none","reason":<the fallback reason>,"items":[]}`.
// The site's shadow caller sends it (DESIGN.md, "P4: the site's shadow read").
//
// Also /healthz, /readyz and /metrics.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/rest"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/urn"
)

// RegistryOnlyHeader, set to "1", asks for the registry's answer only. The site sends it from its
// storage route, which is itself the REST read this service would fall back to: following the
// fallback would read the site again from inside its own read, for an answer it already holds. It
// can only make a read do less, so it needs no trust. Browsers never send it: the preflight does not
// allow it.
const RegistryOnlyHeader = "X-App-Data-Registry-Only"

// Streams answers a read from a per-user stream (session.Manager).
type Streams interface {
	Read(ctx context.Context, token, schema string) ([]registry.Entity, error)
}

// Lister is the REST fallback (rest.Client).
type Lister interface {
	List(ctx context.Context, token, collection, from, keyPrefix string) ([]rest.Doc, error)
}

// Server serves the API.
type Server struct {
	// Streams is nil when the registry path is off: every read is the REST read.
	Streams Streams
	// Exchangeable reports whether a token can reach a stream: the streams' own exchange.Router's
	// Accepts, so the handler and the exchange cannot disagree about which tokens are exchanged. Nil
	// is hub tokens only (exchange.KindHub). Any other token reads REST only
	// (`token_not_exchangeable`) and is never sent to the hub.
	Exchangeable func(token string) bool
	REST         Lister
	Metrics      *metrics.Metrics
	Gatherer     prometheus.Gatherer
	Log          *slog.Logger
	// Deadline bounds one read; LiveWait bounds how long of it a new stream may take to reach Live.
	Deadline, LiveWait time.Duration
	// RESTSlots bounds concurrent REST reads: a read takes one without waiting, or answers 503.
	RESTSlots chan struct{}
	// Ready reports whether the service takes reads (false while it shuts down); nil is always.
	Ready func() bool
}

// Handler routes the API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/apps/{slug}/collections/{collection}/records", s.records)
	mux.HandleFunc("OPTIONS /v1/apps/{slug}/collections/{collection}/records", preflight)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if s.Ready != nil && !s.Ready() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.Gatherer, promhttp.HandlerOpts{}))
	return mux
}

// An app calls this from its sandboxed frame, an opaque origin, with a bearer token and no cookies,
// as it calls the document store itself: any origin may, and the token is the only credential.
func cors(h http.Header) {
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Headers", "Authorization")
	h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	h.Set("Access-Control-Max-Age", "600")
}

func preflight(w http.ResponseWriter, _ *http.Request) {
	cors(w.Header())
	w.WriteHeader(http.StatusNoContent)
}

type item struct {
	URN  string          `json:"urn,omitempty"`
	Key  string          `json:"key,omitempty"`
	Rev  string          `json:"rev"`
	Data json.RawMessage `json:"data"`
}

type answer struct {
	Source string `json:"source"`
	// Reason is why the registry did not answer, on a registry-only read (source "none") only.
	Reason string `json:"reason,omitempty"`
	Items  []item `json:"items"`
}

func (s *Server) records(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	h := w.Header()
	cors(h)
	// One user's data: never stored by a cache, never served for another token.
	h.Set("Cache-Control", "private, no-store")
	h.Set("Vary", "Authorization")

	slug, collection := r.PathValue("slug"), r.PathValue("collection")
	q := r.URL.Query()
	major := 1
	if raw := q.Get("major"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			s.refuse(w, start, http.StatusBadRequest, "bad_request", "major must be an integer", "bad_request")
			return
		}
		major = n
	}
	keyPrefix := q.Get("keyPrefix")
	if _, given := q["keyPrefix"]; given && !keyPrefixRE.MatchString(keyPrefix) {
		s.refuse(w, start, http.StatusBadRequest, "bad_request", "invalid keyPrefix", "bad_request")
		return
	}
	schema, err := urn.CollectionSchema(slug, collection, major)
	if err != nil {
		s.refuse(w, start, http.StatusBadRequest, "bad_request", "invalid app, collection or major", "bad_request")
		return
	}
	token, ok := bearer(r)
	if !ok {
		h.Set("WWW-Authenticate", `Bearer realm="app-data"`)
		s.refuse(w, start, http.StatusUnauthorized, "unauthenticated", "a bearer token is required", "unauthenticated")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.Deadline)
	defer cancel()

	reason := "registry_off"
	switch {
	case s.Streams == nil:
	case !s.exchangeable(token):
		reason = "token_not_exchangeable"
	default:
		lctx, lcancel := context.WithTimeout(ctx, s.LiveWait)
		ents, err := s.Streams.Read(lctx, token, schema)
		lcancel()
		// An empty answer is not trusted: the origin answers a token it refuses with an empty
		// snapshot, exactly as a user who holds nothing, so only REST can tell the two apart.
		switch {
		case err != nil || len(ents) == 0:
			reason = fallbackReason(err)
		case keyPrefix != "" && !allKeyed(ents):
			reason = "unkeyed"
		default:
			// The stream holds records, so it was not refused: a prefix that keeps none is an empty answer.
			out := answer{Source: "registry", Items: make([]item, 0, len(ents))}
			for _, e := range ents {
				if strings.HasPrefix(e.Key, keyPrefix) {
					out.Items = append(out.Items, item{URN: e.URN, Key: e.Key, Rev: e.Rev, Data: e.Body})
				}
			}
			s.write(w, start, http.StatusOK, out, "registry", "ok")
			return
		}
	}
	if r.Header.Get(RegistryOnlyHeader) == "1" {
		s.write(w, start, http.StatusOK, answer{Source: "none", Reason: reason, Items: []item{}}, "none", "registry_only")
		return
	}
	s.Metrics.Fallbacks.WithLabelValues(reason).Inc()

	select {
	case s.RESTSlots <- struct{}{}:
		defer func() { <-s.RESTSlots }()
	default:
		h.Set("Retry-After", "1")
		s.refuse(w, start, http.StatusServiceUnavailable, "busy", "too many reads in flight; retry", "busy")
		return
	}
	// Always `from=<slug>`: the site then reads the app the request names, whoever the token's app
	// is, so a REST answer can never be another app's data under this slug's name.
	docs, err := s.REST.List(ctx, token, collection, slug, keyPrefix)
	if err != nil {
		s.restError(w, start, err)
		return
	}
	out := answer{Source: "rest", Items: make([]item, 0, len(docs))}
	for _, d := range docs {
		out.Items = append(out.Items, item{Key: d.Key, Rev: strconv.FormatInt(d.Version, 10), Data: d.Data})
	}
	s.write(w, start, http.StatusOK, out, "rest", "ok")
}

// keyPrefixRE is a document key's grammar (the store's `[A-Za-z0-9._:-]{1,128}`): a prefix of one.
var keyPrefixRE = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// allKeyed reports whether every entity carries its storage key.
func allKeyed(ents []registry.Entity) bool {
	for _, e := range ents {
		if e.Key == "" {
			return false
		}
	}
	return true
}

func (s *Server) exchangeable(token string) bool {
	if s.Exchangeable == nil {
		return exchange.KindOf(token) == exchange.KindHub
	}
	return s.Exchangeable(token)
}

func fallbackReason(err error) string {
	switch {
	case err == nil:
		return "empty"
	case errors.Is(err, session.ErrCapacity):
		return "capacity"
	case errors.Is(err, session.ErrTokenCapacity):
		return "token_capacity"
	case errors.Is(err, session.ErrNotLive):
		return "not_live"
	case errors.Is(err, session.ErrStalled):
		return "stalled"
	case errors.Is(err, session.ErrCoolingDown):
		return "cooling_down"
	case errors.Is(err, session.ErrInvalidToken):
		return "invalid_token"
	case errors.Is(err, session.ErrRefused):
		return "exchange_refused"
	case errors.Is(err, session.ErrNotPrivate):
		return "not_private"
	case errors.Is(err, session.ErrTooLarge):
		return "too_large"
	case errors.Is(err, session.ErrEnded):
		return "ended"
	case errors.Is(err, session.ErrClosed):
		return "closed"
	case errors.Is(err, session.ErrBlockSpent):
		return "block_spent"
	case errors.Is(err, session.ErrBlockFull):
		return "block_cache_full"
	default:
		return "failed"
	}
}

func (s *Server) restError(w http.ResponseWriter, start time.Time, err error) {
	var re *rest.Error
	switch {
	case errors.As(err, &re) && re.Status >= 400 && re.Status < 500:
		// The site's own refusal (401, 403, 404, 429…), passed on as it sent it.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(re.Status)
		body := re.Body
		if body == nil {
			body = []byte(`{"error":"refused"}`)
		}
		_, _ = w.Write(body)
		s.count(start, "rest", "refused")
	case errors.Is(err, context.DeadlineExceeded):
		s.write(w, start, http.StatusGatewayTimeout, errBody("deadline", "the read did not finish in time"), "rest", "error")
	case errors.Is(err, rest.ErrTooMany):
		s.write(w, start, http.StatusBadGateway, errBody("too_large", "the collection holds more records than this service returns"), "rest", "error")
	default:
		s.write(w, start, http.StatusBadGateway, errBody("unavailable", "the document store could not be read"), "rest", "error")
	}
}

func errBody(code, msg string) map[string]string {
	return map[string]string{"error": code, "message": msg}
}

func bearer(r *http.Request) (string, bool) {
	scheme, tok, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	tok = strings.TrimSpace(tok)
	return tok, tok != ""
}

func (s *Server) refuse(w http.ResponseWriter, start time.Time, status int, code, msg, outcome string) {
	s.write(w, start, status, errBody(code, msg), "none", outcome)
}

func (s *Server) write(w http.ResponseWriter, start time.Time, status int, body any, source, outcome string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil && s.Log != nil {
		s.Log.Debug("write failed", "err", err)
	}
	s.count(start, source, outcome)
}

func (s *Server) count(start time.Time, source, outcome string) {
	s.Metrics.Reads.WithLabelValues(source, outcome).Inc()
	s.Metrics.ReadTime.WithLabelValues(source).Observe(time.Since(start).Seconds())
}
