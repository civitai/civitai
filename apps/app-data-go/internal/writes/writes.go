// Package writes is the service's write path (WRITES-DESIGN.md, "The write path"): every storage
// write, and `info`, is checked for shape here and forwarded, signed, to the site's internal storage
// route, which runs the public route's own chain. The store stays the one writer; nothing here holds
// data or decides write access.
//
//	POST   /v1/apps/{slug}/collections/{collection}/records             create
//	PUT    /v1/apps/{slug}/collections/{collection}/records/{key}       put
//	DELETE /v1/apps/{slug}/collections/{collection}/records/{key}       delete  [?ifVersion=N]
//	PATCH  /v1/apps/{slug}/collections/{collection}/records/{key}       one of {$inc}, {$mark}, {$unmark}
//	GET    /v1/apps/{slug}/info                                         the viewer's usage and limits
//
// Each goes to `<site>/api/internal/blocks/storage[/<collection>[/<key>]]?from=<slug>[&ifVersion=N]`.
// Registered only with APP_DATA_WRITES on: off, every one of these paths is the mux's own 404.
//
// NEVER RETRIED. One inbound request is at most one request sent to the site. A forward whose answer
// is lost (a site 5xx other than 501, a transport error, the timeout, a redirect) is `504` with
// `outcome: "unknown"`: it may have been written. `503 not_forwarded` is only ever this service's own
// refusal before anything was sent, and is the one answer safe to resend.
package writes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-data-go/internal/sign"
	"github.com/civitai/civitai/apps/app-data-go/internal/urn"
)

// BodyLimit is the largest request body forwarded: the site's STORAGE_BODY_LIMIT_BYTES
// (doc-store-api.ts: a 64 KiB document plus 16 KiB), so a body the site would refuse as too large
// is refused here, `413 too_large`, without being sent.
const BodyLimit = 64<<10 + 16<<10

// InternalPath is the site's internal storage route, under the site URL's own path.
const InternalPath = "/api/internal/blocks/storage"

// maxAnswerBytes bounds a site answer read: far above any answer the store sends (a record is at
// most 64 KiB). An answer past it cannot be passed on whole, so its outcome is unknown.
const maxAnswerBytes = 4 << 20

// The CORS answer of the write paths. A JSON body is not a simple request, so a browser preflights
// every write and needs Content-Type allowed. Retry-After is exposed: a 429 or 503 names its delay
// there.
const (
	AllowMethods  = "GET, POST, PUT, DELETE, PATCH, OPTIONS"
	AllowHeaders  = "Authorization, Content-Type"
	ExposeHeaders = "Retry-After"
)

var (
	// keyRE is a document key's grammar (the store's, doc-store.types.ts).
	keyRE = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	// ifVersionRE is a non-negative integer of at most 15 digits (below 2^53, so the site's number
	// parse is exact).
	ifVersionRE = regexp.MustCompile(`^[0-9]{1,15}$`)
	// majorRE is a schema major as urn.ts parses one.
	majorRE = regexp.MustCompile(`^[1-9][0-9]{0,8}$`)
)

// Majors is the book of current schema majors (majors.Book).
type Majors interface {
	Current(slug, collection string) (int, bool)
}

// Forwarder serves the write routes.
type Forwarder struct {
	// Site is the site's base URL; InternalPath is appended to its path.
	Site *url.URL
	// Key is the HMAC key shared with the site (sign.Sign).
	Key []byte
	// HTTP is the client; nil is http.DefaultClient. Redirects are never followed.
	HTTP *http.Client
	// Timeout bounds one forward, from the request sent to the answer read. It must exceed the site's
	// permission-hook client timeout (doc-store-hook.ts hookClientTimeoutMs), or a slow but healthy
	// hook would read here as an unknown outcome.
	Timeout time.Duration
	// Verify checks a block token here before it is forwarded (exchange.BlockVerifier.Check). Nil
	// refuses every block token `503 not_forwarded`: a block token is never forwarded unverified.
	Verify func(ctx context.Context, token string) error
	// Majors is the current-major book; nil knows no collection.
	Majors Majors
	// Ready reports whether the service takes requests (false while it shuts down); nil is always.
	Ready   func() bool
	Metrics *metrics.Metrics
	Log     *slog.Logger
	// Now is the clock the signature's timestamp is read from; nil is time.Now.
	Now func() time.Time
}

// route is one write route's fixed facts.
type route struct {
	method string // sent to the site, whatever the inbound method's spelling
	op     string // the metric op; a PATCH's is set from its operator
	key    bool   // the path names a record key
	coll   bool   // the path names a collection
	body   bool   // a JSON object body is required (POST, PUT, PATCH); otherwise none is allowed
	params map[string]bool
}

var (
	createRoute = route{method: http.MethodPost, op: "create", coll: true, body: true, params: map[string]bool{"major": true}}
	putRoute    = route{method: http.MethodPut, op: "put", coll: true, key: true, body: true, params: map[string]bool{"major": true}}
	deleteRoute = route{method: http.MethodDelete, op: "delete", coll: true, key: true, params: map[string]bool{"major": true, "ifVersion": true}}
	patchRoute  = route{method: http.MethodPatch, op: "patch", coll: true, key: true, body: true, params: map[string]bool{"major": true}}
	infoRoute   = route{method: http.MethodGet, op: "info", params: map[string]bool{}}
)

// Register adds the write routes and their preflights to mux. The collection path's preflight
// (shared with the read route) is the caller's: it must answer with AllowMethods and AllowHeaders.
func (f *Forwarder) Register(mux *http.ServeMux) {
	const records = "/v1/apps/{slug}/collections/{collection}/records"
	mux.HandleFunc("POST "+records, f.serve(createRoute))
	mux.HandleFunc("PUT "+records+"/{key}", f.serve(putRoute))
	mux.HandleFunc("DELETE "+records+"/{key}", f.serve(deleteRoute))
	mux.HandleFunc("PATCH "+records+"/{key}", f.serve(patchRoute))
	mux.HandleFunc("OPTIONS "+records+"/{key}", Preflight)
	mux.HandleFunc("GET /v1/apps/{slug}/info", f.serve(infoRoute))
	mux.HandleFunc("OPTIONS /v1/apps/{slug}/info", Preflight)
}

// CORS sets the write paths' CORS headers on h. As for reads, any origin may call: the bearer token
// is the only credential, and no cookie is read.
func CORS(h http.Header) {
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Headers", AllowHeaders)
	h.Set("Access-Control-Allow-Methods", AllowMethods)
	h.Set("Access-Control-Expose-Headers", ExposeHeaders)
	h.Set("Access-Control-Max-Age", "600")
}

// Preflight answers a write path's OPTIONS.
func Preflight(w http.ResponseWriter, _ *http.Request) {
	CORS(w.Header())
	w.WriteHeader(http.StatusNoContent)
}

// refusal is an answer made here, never the site's.
type refusal struct {
	status  int
	code    string
	msg     string
	details map[string]any
	outcome string
	// retryAfter, when set, is sent as Retry-After.
	retryAfter string
}

func refused(status int, code, msg string) *refusal {
	return &refusal{status: status, code: code, msg: msg, outcome: "refused_here"}
}

// notForwarded is `503 not_forwarded`: refused here before anything was sent, so safe to resend.
func notForwarded(msg string) *refusal {
	return &refusal{status: http.StatusServiceUnavailable, code: "not_forwarded", msg: msg, outcome: "unavailable", retryAfter: "1"}
}

// outbound is one request to the site, built entirely here: nothing of the inbound request reaches
// it but the Authorization header and the body bytes.
type outbound struct {
	op     string
	method string
	path   string // under the site's path
	query  string // raw, as sent and signed
	auth   string
	body   []byte
}

func (f *Forwarder) serve(rt route) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		CORS(h)
		// One user's data: never stored by a cache, never served for another token.
		h.Set("Cache-Control", "private, no-store")
		h.Set("Vary", "Authorization")
		ob, ref := f.prepare(r, rt)
		if ref != nil {
			f.refuse(w, ob.op, ref)
			return
		}
		f.forward(w, r, ob)
	}
}

// prepare runs every check made here, in order: the path, the query, the body, the token, the
// schema major, and whether this process still takes writes. Nothing is sent before all pass.
func (f *Forwarder) prepare(r *http.Request, rt route) (outbound, *refusal) {
	ob := outbound{op: rt.op, method: rt.method}
	slug, collection, key := r.PathValue("slug"), r.PathValue("collection"), r.PathValue("key")
	switch {
	case !urn.ValidSlug(slug):
		return ob, refused(http.StatusBadRequest, "invalid_request", "invalid app slug")
	case rt.coll && !urn.ValidCollection(collection):
		return ob, refused(http.StatusBadRequest, "invalid_request", "invalid collection name")
	case rt.key && !keyRE.MatchString(key):
		return ob, refused(http.StatusBadRequest, "invalid_request", "invalid record key")
	}

	// The query sent is built here, never the client's: `from` first, then `ifVersion`. `major` is
	// read here and never sent on.
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return ob, refused(http.StatusBadRequest, "invalid_request", "invalid query string")
	}
	for name, vals := range q {
		if !rt.params[name] || len(vals) != 1 {
			return ob, refused(http.StatusBadRequest, "invalid_request", "unsupported query parameter")
		}
	}
	major := 0
	if raw, given := q["major"]; given {
		if !majorRE.MatchString(raw[0]) {
			return ob, refused(http.StatusBadRequest, "invalid_request", "major must be a positive integer")
		}
		major, _ = strconv.Atoi(raw[0])
	}
	// The slug's grammar needs no escaping: it is sent as it is.
	ob.query = "from=" + slug
	if raw, given := q["ifVersion"]; given {
		if !ifVersionRE.MatchString(raw[0]) {
			return ob, refused(http.StatusBadRequest, "invalid_request", "ifVersion must be a non-negative integer of at most 15 digits")
		}
		n, _ := strconv.ParseInt(raw[0], 10, 64)
		ob.query += "&ifVersion=" + strconv.FormatInt(n, 10)
	}
	ob.path = InternalPath
	if rt.coll {
		ob.path += "/" + collection
	}
	if rt.key {
		ob.path += "/" + key
	}

	body, ref := readBody(r)
	if ref != nil {
		return ob, ref
	}
	switch {
	case !rt.body && len(body) > 0:
		return ob, refused(http.StatusBadRequest, "invalid_request", "this request takes no body")
	case rt.body && !jsonObject(body):
		return ob, refused(http.StatusBadRequest, "invalid_request", "the body must be a JSON object")
	case rt.op == "patch":
		op, ok := patchOp(body)
		if !ok {
			return ob, refused(http.StatusBadRequest, "invalid_request", "the body must be exactly one of $inc, $mark or $unmark")
		}
		ob.op = op
	}
	ob.body = body

	auth := r.Header.Get("Authorization")
	token, ok := bearer(auth)
	if !ok {
		return ob, refused(http.StatusUnauthorized, "unauthenticated", "a bearer token is required")
	}
	if ref := f.checkToken(r.Context(), token); ref != nil {
		return ob, ref
	}
	ob.auth = auth

	// A major named but not the current one is refused. One named for a collection the book does not
	// know is sent: the site stamps its own current major on every write (withSchemaMajor), so a
	// stale or empty book here can only refuse a write, never mis-stamp one.
	if major != 0 && f.Majors != nil {
		if current, known := f.Majors.Current(slug, collection); known && current != major {
			ref := refused(http.StatusConflict, "stale_major", "the collection's current schema major is another")
			ref.details = map[string]any{"currentMajor": current}
			return ob, ref
		}
	}

	if f.Ready != nil && !f.Ready() {
		return ob, notForwarded("this replica is shutting down; resend")
	}
	return ob, nil
}

// checkToken routes by token shape as reads do (exchange.KindOf). A hub token is sent as it is: the
// site verifies it. A block token is verified here first, so a forged or expired one is never sent.
func (f *Forwarder) checkToken(ctx context.Context, token string) *refusal {
	switch exchange.KindOf(token) {
	case exchange.KindHub:
		return nil
	case exchange.KindBlock:
	default:
		return refused(http.StatusUnauthorized, "unauthenticated", "the bearer token is not an app token")
	}
	if f.Verify == nil {
		return notForwarded("block tokens cannot be verified here")
	}
	err := f.Verify(ctx, token)
	var re *exchange.RefusedError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &re) && re.Reason == "anonymous":
		// A signed-out viewer's token: writes need a signed-in viewer, as the site's requireViewer says.
		return refused(http.StatusUnauthorized, "sign_in_required", "sign in required")
	case errors.As(err, &re):
		ref := refused(http.StatusUnauthorized, "unauthenticated", "the block token was refused")
		// The verifier's code (`local`) and which of its checks refused: fixed strings, never a claim.
		ref.details = map[string]any{"refusal": re.Code, "reason": re.Reason}
		return ref
	default:
		// The key set is unavailable (exchange.ErrBlockUnverifiable): nothing was sent.
		return notForwarded("the block token cannot be verified now; resend")
	}
}

// readBody reads the whole body, once, up to BodyLimit.
func readBody(r *http.Request) ([]byte, *refusal) {
	tooLarge := refused(http.StatusRequestEntityTooLarge, "too_large", "the request body exceeds "+strconv.Itoa(BodyLimit)+" bytes")
	tooLarge.details = map[string]any{"limit": BodyLimit}
	if r.ContentLength > BodyLimit {
		return nil, tooLarge
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, BodyLimit+1))
	switch {
	case err != nil:
		return nil, refused(http.StatusBadRequest, "invalid_request", "the request body could not be read")
	case len(body) > BodyLimit:
		return nil, tooLarge
	}
	return body, nil
}

// jsonObject reports whether body is exactly one JSON value, and an object.
func jsonObject(body []byte) bool {
	t := bytes.TrimLeft(body, " \t\r\n")
	return len(t) > 0 && t[0] == '{' && json.Valid(body)
}

// patchOp is the op of a PATCH body that is exactly one operator, $inc, $mark or $unmark, named once:
// the shape only, the site checks the rest. A key named twice counts twice.
func patchOp(body []byte) (string, bool) {
	// The body is one valid JSON object (jsonObject), so no step below can fail; a decoder that did
	// would stop at More, never loop.
	dec := json.NewDecoder(bytes.NewReader(body))
	_, _ = dec.Token() // the '{'
	var names []string
	for dec.More() {
		tok, _ := dec.Token()
		name, _ := tok.(string)
		names = append(names, name)
		var skip json.RawMessage
		_ = dec.Decode(&skip)
	}
	if len(names) != 1 {
		return "", false
	}
	switch names[0] {
	case "$inc":
		return "increment", true
	case "$mark":
		return "mark", true
	case "$unmark":
		return "unmark", true
	}
	return "", false
}

func bearer(header string) (string, bool) {
	scheme, tok, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	tok = strings.TrimSpace(tok)
	return tok, tok != ""
}

// forward sends ob once and passes the answer on.
func (f *Forwarder) forward(w http.ResponseWriter, r *http.Request, ob outbound) {
	u := *f.Site
	u.Path = strings.TrimRight(f.Site.Path, "/") + ob.path
	u.RawPath = ""
	u.RawQuery = ob.query
	// The forward is not cut short by the client going away: once sent, the site finishes it either
	// way, and an aborted request would only make its outcome unknown to the site's logs too.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), f.Timeout)
	defer cancel()
	var body io.Reader = http.NoBody
	if len(ob.body) > 0 {
		body = bytes.NewReader(ob.body)
	}
	req, err := http.NewRequestWithContext(ctx, ob.method, u.String(), body)
	if err != nil {
		f.refuse(w, ob.op, notForwarded("the request could not be built"))
		return
	}
	// Built from nothing: no client X-Forwarded-For, Forwarded, region header or cookie is ever sent.
	ts := strconv.FormatInt(f.now().Unix(), 10)
	req.Header.Set("Authorization", ob.auth)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "app-data-go")
	if len(ob.body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	// Signed over the path and query exactly as they go on the wire (the request line is
	// EscapedPath + "?" + RawQuery).
	req.Header.Set(sign.TimestampHeader, ts)
	req.Header.Set(sign.SignatureHeader, sign.Sign(f.Key, req.Method, req.URL.EscapedPath(), req.URL.RawQuery, ts, ob.body))

	// One Do, never repeated. (Go's transport itself re-sends a request only when none of it reached
	// the wire, or, for the idempotent GET of `info`, on a pooled connection the site had already
	// closed; never a write the site may have read.)
	start := time.Now()
	res, err := exchange.NoRedirects(f.HTTP).Do(req)
	if err != nil {
		f.Metrics.WriteForward.WithLabelValues(ob.op).Observe(time.Since(start).Seconds())
		f.unknown(w, ob.op, "the site's answer was lost", err)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxAnswerBytes+1))
	_ = res.Body.Close()
	f.Metrics.WriteForward.WithLabelValues(ob.op).Observe(time.Since(start).Seconds())
	switch {
	case err != nil:
		f.unknown(w, ob.op, "the site's answer was cut short", err)
		return
	case len(raw) > maxAnswerBytes:
		f.unknown(w, ob.op, "the site's answer was too large to pass on", nil)
		return
	}
	outcome := ""
	switch s := res.StatusCode; {
	case s >= 200 && s < 300:
		outcome = "2xx"
	case s >= 400 && s < 500:
		outcome = "4xx"
	case s == http.StatusNotImplemented:
		// `501 not_supported_here`: the internal route's import refusal, raised before any write, so it
		// is a known outcome, passed on as the site sent it, not an unknown one.
		outcome = "501"
	default:
		// Any other 5xx (a 503 included: the site's own unavailable codes are not ours to call safe), or
		// a 3xx: a redirect is never followed (it would re-send the write) nor passed on (a browser
		// would follow it), and whether the site acted first is not known.
		f.unknown(w, ob.op, "the site answered "+strconv.Itoa(s), nil)
		return
	}
	for _, name := range []string{"Content-Type", "Retry-After"} {
		if v := res.Header.Get(name); v != "" {
			w.Header().Set(name, v)
		}
	}
	w.WriteHeader(res.StatusCode)
	_, _ = w.Write(raw)
	f.Metrics.Writes.WithLabelValues(ob.op, outcome).Inc()
}

// unknown answers `504 outcome_unknown`: the request was sent and its outcome is not known.
func (f *Forwarder) unknown(w http.ResponseWriter, op, msg string, err error) {
	if f.Log != nil {
		// The op and why only: never the token, the body, the app or the key.
		attrs := []any{"op", op, "why", msg}
		if err != nil {
			attrs = append(attrs, "timeout", errors.Is(err, context.DeadlineExceeded))
		}
		f.Log.Warn("write outcome unknown", attrs...)
	}
	f.respond(w, http.StatusGatewayTimeout, map[string]any{
		"code": "outcome_unknown", "outcome": "unknown", "message": msg + "; the write may or may not have happened",
		"error": msg + "; the write may or may not have happened",
	})
	f.Metrics.Writes.WithLabelValues(op, "unknown").Inc()
}

// refuse answers a refusal made here, in the store's envelope (`code`, `message`, `error`,
// `details`), so a client reads it as it reads the site's.
func (f *Forwarder) refuse(w http.ResponseWriter, op string, ref *refusal) {
	body := map[string]any{"code": ref.code, "message": ref.msg, "error": ref.msg}
	if ref.details != nil {
		body["details"] = ref.details
	}
	if ref.status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="app-data"`)
	}
	if ref.retryAfter != "" {
		w.Header().Set("Retry-After", ref.retryAfter)
	}
	f.respond(w, ref.status, body)
	f.Metrics.Writes.WithLabelValues(op, ref.outcome).Inc()
}

func (f *Forwarder) respond(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil && f.Log != nil {
		f.Log.Debug("write failed", "err", err)
	}
}

func (f *Forwarder) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}
