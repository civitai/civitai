// Package api is the service's HTTP surface.
//
//	GET /v1/apps/{slug}/collections/{collection}/records[?major=N][&keyPrefix=P]
//	    Authorization: Bearer <the app's hub access token for the signed-in user>
//
// `major` names the collection schema major read; a read that names none reads the collection's
// current major when the adapter's streams name it (major.go, THE CURRENT MAJOR), and otherwise the
// major it opened at (1 unless a stream named another).
//
// Every private record of one collection of the app `slug` names that the token's user may read
// through the token's app: the app's own collection when slug is the app itself, or another app's
// collection the user granted this app. Which of the two is never the client's to say: both paths
// name the source by slug and leave the basis to the server (the adapter on the registry path, the
// site on REST). The answer is
//
//	{"source":"registry"|"rest","items":[{"urn"?:…,"key":…,"rev":…,"version"?:N,"data":{…}}]}
//
// `version` is the document's store version, the number a write's `ifVersion` is compared against;
// `rev` is kept beside it, opaque. A registry item carries `version` when the adapter's private feed
// sent it (format k3 on); an item without one omits the field (the SDK then reads version 0, which
// no stored document has, so a write built from it is refused `version_conflict`, never applied).
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
// With APP_DATA_WRITES on, also the write routes and `info` (package writes; WRITES-DESIGN.md), and
// read-your-writes for private collections (WRITES-DESIGN.md, "Read-your-writes"): each write the
// store acknowledged is shown over its token's stream until the stream shows it (session.Ack), and a
// read may name a floor, `?minSeq=S`, the highest `seq` the client was acknowledged for the app. A
// floor the stream does not meet reopens it once per adapter poll; one still not met is
// `503 floor_not_met` with Retry-After, never a REST read (a stream that names no head answers it
// unfloored). Also the keyed get,
//
//	GET /v1/apps/{slug}/collections/{collection}/records/{key}[?major=N][&minSeq=S]
//	→ {"source":"registry","item":{"urn"?:…,"key":…,"rev":…,"version"?:N,"data":{…}}}
//
// answered from the stream (base plus overlay) only: a key the stream does not hold, or a stream
// that holds nothing, is `404 not_found`, and a stream that cannot answer is `401` or `503` with
// its reason as the code (streamRefusal), never a REST read. Writes off, `minSeq` is not read and
// the keyed get is the mux's 404.
//
// CUT OVER. With APP_DATA_WRITES on, a read is a cut-over app's (only an app the site has moved to
// this service calls it; the per-app flag that moves it is the site's to evaluate): it is never read
// from REST. Each reason the registry cannot answer is its answer (streamRefusal), and an empty
// stream is an empty answer (WRITES-DESIGN.md, "The empty stream"). Only the site's shadow, which
// sends RegistryOnlyHeader, still gets its `source: none` answer. Writes off, the REST fallback
// stands, unchanged.
//
// Shared collections and signed-out viewers are package shared's (shared.go here).
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
	"github.com/civitai/civitai/apps/app-data-go/internal/sign"
	"github.com/civitai/civitai/apps/app-data-go/internal/urn"
	"github.com/civitai/civitai/apps/app-data-go/internal/writes"
)

// RegistryOnlyHeader, set to "1", asks for the registry's answer only. The site sends it from its
// storage route, which is itself the REST read this service would fall back to: following the
// fallback would read the site again from inside its own read, for an answer it already holds. It
// can only make a read do less, so it needs no trust. Browsers never send it: the preflight does not
// allow it.
const RegistryOnlyHeader = "X-App-Data-Registry-Only"

// Streams answers a read from a per-user stream (session.Manager), under a floor when minSeq > 0,
// with the stream's latest meta (which names the collection's current major: major.go) and a Lease
// on a stream the read opened.
type Streams interface {
	View(ctx context.Context, token, schema string, minSeq int64) (session.Snapshot, error)
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
	// Writes, when set (APP_DATA_WRITES on), adds the write routes and `info` (writes.Forwarder).
	// Nil registers none of them: each answers 404, as any path the mux does not know.
	Writes Routes
	// Shared, when set (APP_DATA_WRITES on, with the registry path), serves shared collections and
	// signed-out viewers (shared.go). Nil: a collection the private feed does not serve answers as
	// before, and the `@me` routes are the mux's 404.
	Shared SharedReads
	// Anonymous verifies a signed-out viewer's block token (exchange.BlockVerifier.CheckAnonymous).
	// Nil refuses every signed-out read `401 sign_in_required`.
	Anonymous func(ctx context.Context, token string) (exchange.AnonymousClaims, error)

	shared sharedSchemas
	majors majorHints
}

// Routes registers a set of routes on the API's mux.
type Routes interface {
	Register(mux *http.ServeMux)
}

// Handler routes the API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/apps/{slug}/collections/{collection}/records", s.records)
	if s.Writes == nil {
		mux.HandleFunc("OPTIONS /v1/apps/{slug}/collections/{collection}/records", preflight)
		// Writes off: a POST (the create) to the read's path is the mux's own 404, as every other write
		// path is, not the 405 the mux would answer for a path it serves under another method.
		mux.HandleFunc("/v1/apps/{slug}/collections/{collection}/records", http.NotFound)
	} else {
		// The collection path also takes the create (POST): its preflight is the write paths'.
		mux.HandleFunc("OPTIONS /v1/apps/{slug}/collections/{collection}/records", writes.Preflight)
		// The key path's preflight (writes.Preflight, registered with the writes) allows GET too.
		mux.HandleFunc("GET /v1/apps/{slug}/collections/{collection}/records/{key}", s.record)
		if s.Shared != nil {
			mux.HandleFunc("GET /v1/apps/{slug}/collections/{collection}/records/@me", s.mine)
			mux.HandleFunc("GET /v1/apps/{slug}/collections/{collection}/records/@me/{parent}", s.mine)
		}
		// One rule for the major a request that names none uses, reads and writes alike (major.go): a
		// write's acknowledgement is held at the major the next no-major read of it opens.
		if w, ok := s.Writes.(impliedMajorUser); ok {
			w.UseImpliedMajor(s.majors.guess)
		}
		s.Writes.Register(mux)
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if s.Ready != nil && !s.Ready() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.Gatherer, promhttp.HandlerOpts{}))
	return withEdge(mux)
}

// withEdge puts what the edge named about the viewer in each request's context:
//   - their address (exchange.ClientIPHeader): the user exchange charges a token it has not seen
//     exchanged to it (exchange.Guard) and forwards it to the hub. A request without the header
//     carries none;
//   - their region (sign.ReadRegion): a stream a read opens for them carries it to the adapter
//     (session.WithRegion) when its manager forwards regions (session.Options.Region, on with
//     APP_DATA_FORWARD_REGION); otherwise it is read and never sent. A request with none, or with a
//     malformed one, carries none, and the adapter holds it to SFW, as before.
func withEdge(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if ip := exchange.ClientIPFrom(r.Header); ip != "" {
			ctx = exchange.WithClientIP(ctx, ip)
		}
		if region, bad := sign.ReadRegion(r.Header); bad == "" {
			ctx = session.WithRegion(ctx, region)
		}
		h.ServeHTTP(w, r.WithContext(ctx))
	})
}

// An app calls this from its sandboxed frame, an opaque origin, with a bearer token and no cookies,
// as it calls the document store itself: any origin may, and the token is the only credential.
func cors(h http.Header) {
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Headers", "Authorization")
	h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	h.Set("Access-Control-Max-Age", "600")
	// A passed-on 429 names its delay; the frame reading it can see the header only if exposed.
	h.Set("Access-Control-Expose-Headers", "Retry-After")
}

func preflight(w http.ResponseWriter, _ *http.Request) {
	cors(w.Header())
	w.WriteHeader(http.StatusNoContent)
}

type item struct {
	URN string `json:"urn,omitempty"`
	Key string `json:"key,omitempty"`
	Rev string `json:"rev"`
	// Version is the document's store version (see the package comment); omitted when unknown (0).
	Version int64           `json:"version,omitempty"`
	Data    json.RawMessage `json:"data"`
}

// entityItem is a private stream record as a read answers it.
func entityItem(e registry.Entity) item {
	return item{URN: e.URN, Key: e.Key, Rev: e.Rev, Version: e.Version, Data: e.Body}
}

type answer struct {
	Source string `json:"source"`
	// Reason is why the registry did not answer, on a registry-only read (source "none") only.
	Reason string `json:"reason,omitempty"`
	Items  []item `json:"items"`
}

type keyed struct {
	Source string `json:"source"`
	Item   item   `json:"item"`
}

// minSeqRE is a floor: a non-negative integer of at most 15 digits (below 2^53, as the site's seqs).
var minSeqRE = regexp.MustCompile(`^[0-9]{1,15}$`)

type readParams struct {
	schema           string
	slug, collection string
	major            int
	// implied: the read named no major, so it reads the collection's current one (major.go), and
	// major is the guess it opens first.
	implied bool
	minSeq  int64
	token   string
}

// params reads the schema, the floor (writes on only) and the token, or answers the refusal and
// reports false.
func (s *Server) params(w http.ResponseWriter, r *http.Request, start time.Time) (readParams, bool) {
	var p readParams
	q := r.URL.Query()
	// No major: the current one (major.go), opened at the last one the streams named.
	major, implied := s.majors.guess(r.PathValue("slug"), r.PathValue("collection")), true
	if raw := q.Get("major"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			s.refuse(w, start, http.StatusBadRequest, "bad_request", "major must be an integer", "bad_request")
			return p, false
		}
		major, implied = n, false
	}
	if raw, given := q["minSeq"]; given && s.Writes != nil {
		if len(raw) != 1 || !minSeqRE.MatchString(raw[0]) {
			s.refuse(w, start, http.StatusBadRequest, "bad_request", "minSeq must be a non-negative integer of at most 15 digits", "bad_request")
			return p, false
		}
		p.minSeq, _ = strconv.ParseInt(raw[0], 10, 64)
	}
	schema, err := urn.CollectionSchema(r.PathValue("slug"), r.PathValue("collection"), major)
	if err != nil {
		s.refuse(w, start, http.StatusBadRequest, "bad_request", "invalid app, collection or major", "bad_request")
		return p, false
	}
	p.schema, p.slug, p.collection, p.major, p.implied = schema, r.PathValue("slug"), r.PathValue("collection"), major, implied
	token, ok := bearer(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="app-data"`)
		s.refuse(w, start, http.StatusUnauthorized, "unauthenticated", "a bearer token is required", "unauthenticated")
		return p, false
	}
	p.token = token
	return p, true
}

func (s *Server) record(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	h := w.Header()
	cors(h)
	h.Set("Cache-Control", "private, no-store")
	h.Set("Vary", "Authorization")
	k := r.PathValue("key")
	if !keyPrefixRE.MatchString(k) {
		s.refuse(w, start, http.StatusBadRequest, "bad_request", "invalid record key", "bad_request")
		return
	}
	p, ok := s.params(w, r, start)
	if !ok {
		return
	}
	switch {
	case s.sharedPath(p):
		s.sharedGet(w, r, start, p, k)
		return
	case s.Streams == nil:
		s.streamRefusal(w, start, "registry_off")
		return
	case !s.exchangeable(p.token):
		s.streamRefusal(w, start, "token_not_exchangeable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.LiveWait)
	defer cancel()
	ents, err := s.view(ctx, &p)
	switch {
	case errors.Is(err, session.ErrNotPrivate) && s.Shared != nil:
		s.shared.mark(p.schema, time.Now())
		s.sharedGet(w, r, start, p, k)
		return
	case errors.Is(err, session.ErrFloorNotMet):
		s.streamRefusal(w, start, "floor_not_met")
		return
	case err != nil:
		s.streamRefusal(w, start, fallbackReason(err))
		return
	case !allKeyed(ents):
		s.streamRefusal(w, start, "unkeyed")
		return
	}
	// Two records of one key are the old and new rows of a re-created key, both briefly held: the
	// newer write wins.
	var found *registry.Entity
	for i := range ents {
		if e := &ents[i]; e.Key == k && (found == nil || e.Seq > found.Seq) {
			found = e
		}
	}
	if found == nil {
		// An empty stream is an empty answer (WRITES-DESIGN.md, "The empty stream").
		s.write(w, start, http.StatusNotFound, errBody("not_found", "document not found"), "registry", "not_found")
		return
	}
	s.write(w, start, http.StatusOK, keyed{Source: "registry", Item: entityItem(*found)}, "registry", "ok")
}

// refusedReasons are the stream reasons the keyed get answers 401 (WRITES-DESIGN.md, the
// fallback-reason table): the token, not the stream. Each is sent as its code, but a spent block
// token's, which is `block_token_spent` (the SDK gets a fresh block token on it).
var refusedReasons = map[string]string{
	"token_not_exchangeable": "token_not_exchangeable", "invalid_token": "invalid_token",
	"exchange_refused": "exchange_refused", "block_spent": "block_token_spent",
}

// streamRefusal answers a read the stream could not answer, by reason, with no REST read: 401 for the
// token's own refusals, 501 for a collection the private feed does not serve (shared collections are
// not served here yet), and 503 with Retry-After for the rest, the reason as the code.
func (s *Server) streamRefusal(w http.ResponseWriter, start time.Time, reason string) {
	if code, ok := refusedReasons[reason]; ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="app-data"`)
		s.write(w, start, http.StatusUnauthorized, errBody(code, "the token cannot read this stream"), "registry", "refused")
		return
	}
	if reason == "not_private" {
		s.write(w, start, http.StatusNotImplemented, errBody(reason, "this collection is not served here"), "registry", "refused")
		return
	}
	outcome := "unavailable"
	if reason == "floor_not_met" {
		outcome = reason
	}
	w.Header().Set("Retry-After", "1")
	s.write(w, start, http.StatusServiceUnavailable, errBody(reason, "the stream cannot answer this read now; retry"), "registry", outcome)
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
	keyPrefix := q.Get("keyPrefix")
	if _, given := q["keyPrefix"]; given && !keyPrefixRE.MatchString(keyPrefix) {
		s.refuse(w, start, http.StatusBadRequest, "bad_request", "invalid keyPrefix", "bad_request")
		return
	}
	p, ok := s.params(w, r, start)
	if !ok {
		return
	}
	token := p.token
	if s.sharedPath(p) {
		s.sharedList(w, r, start, p)
		return
	}
	// Never REST for a cut-over app's read (see CUT OVER); the shadow keeps its registry-only answer.
	cutover := s.Writes != nil && r.Header.Get(RegistryOnlyHeader) != "1"

	ctx, cancel := context.WithTimeout(r.Context(), s.Deadline)
	defer cancel()

	reason := "registry_off"
	switch {
	case s.Streams == nil:
	case !s.exchangeable(token):
		reason = "token_not_exchangeable"
	default:
		lctx, lcancel := context.WithTimeout(ctx, s.LiveWait)
		ents, err := s.view(lctx, &p)
		lcancel()
		// An empty answer is not trusted: the origin answers a token it refuses with an empty
		// snapshot, exactly as a user who holds nothing, so only REST can tell the two apart.
		switch {
		case errors.Is(err, session.ErrNotPrivate) && s.Shared != nil:
			s.shared.mark(p.schema, time.Now())
			s.sharedList(w, r, start, p)
			return
		case errors.Is(err, session.ErrFloorNotMet):
			// Never REST: a client that sent a floor retries this service.
			s.streamRefusal(w, start, "floor_not_met")
			return
		case cutover && err != nil:
			s.streamRefusal(w, start, fallbackReason(err))
			return
		case cutover && keyPrefix != "" && !allKeyed(ents):
			s.streamRefusal(w, start, "unkeyed")
			return
		case cutover:
			// The empty stream is accepted for v1: an empty answer, never a REST read.
			s.write(w, start, http.StatusOK, registryAnswer(ents, keyPrefix), "registry", "ok")
			return
		case err != nil || len(ents) == 0:
			reason = fallbackReason(err)
		case keyPrefix != "" && !allKeyed(ents):
			reason = "unkeyed"
		default:
			// The stream holds records, so it was not refused: a prefix that keeps none is an empty answer.
			s.write(w, start, http.StatusOK, registryAnswer(ents, keyPrefix), "registry", "ok")
			return
		}
	}
	if cutover {
		s.streamRefusal(w, start, reason)
		return
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
		out.Items = append(out.Items, item{Key: d.Key, Rev: strconv.FormatInt(d.Version, 10), Version: d.Version, Data: d.Data})
	}
	s.write(w, start, http.StatusOK, out, "rest", "ok")
}

// registryAnswer is a private stream's records under keyPrefix.
func registryAnswer(ents []registry.Entity, keyPrefix string) answer {
	out := answer{Source: "registry", Items: make([]item, 0, len(ents))}
	for _, e := range ents {
		if strings.HasPrefix(e.Key, keyPrefix) {
			out.Items = append(out.Items, entityItem(e))
		}
	}
	return out
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
	case errors.Is(err, session.ErrCursorExpired):
		return "cursor_expired"
	default:
		return "failed"
	}
}

func (s *Server) restError(w http.ResponseWriter, start time.Time, err error) {
	var re *rest.Error
	switch {
	case errors.As(err, &re) && re.Status >= 400 && re.Status < 500:
		// The site's own refusal (401, 403, 404, 429…), passed on as it sent it: its body (a 429's
		// carries the `rateLimit` meta) and its Retry-After.
		w.Header().Set("Content-Type", "application/json")
		if re.RetryAfter != "" {
			w.Header().Set("Retry-After", re.RetryAfter)
		}
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
