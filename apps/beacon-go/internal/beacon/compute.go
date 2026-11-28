// Package beacon computes the Node app's answer to the two browser beacons — POST /api/internal/ping
// (page views) and POST /api/internal/pulse (entity views) — and the tracker write each one makes,
// byte for byte. DESIGN.md is the contract this package implements; every function names the Node
// code it reproduces.
//
// The rule, as in feed-go: answer only what can be answered exactly as the Node handler would, and
// hand everything else back as a fallback (internal/fallback). A fallback is not an error: in serve
// mode the request is proxied to the Node app unchanged, in shadow mode it is counted by reason.
package beacon

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/auth"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// The two beacons, as labels and as the tracker tables they write.
const (
	EndpointPing  = "ping"
	EndpointPulse = "pulse"

	TablePageViews = "pageViews"
	TableViews     = "views"
)

// Write is one tracker insert: the Node Tracker POSTs Body (JSON.stringify of the row) to
// `${CLICKHOUSE_TRACKER_URL}/track/${Table}`.
type Write struct {
	Table string
	Body  []byte
}

// Outcome is the response and the writes for one request.
type Outcome struct {
	Response Response
	Writes   []Write
}

// SessionResolver resolves the viewer (auth.Resolver). A nil user is signed out; an error is always a
// fallback.
type SessionResolver interface {
	Resolve(ctx context.Context, req *http.Request) (*auth.SessionUser, error)
}

// Engine computes beacon outcomes.
type Engine struct {
	Sessions SessionResolver
	// TrackerEnabled is the Tracker's send() precondition: CLICKHOUSE_TRACKER_URL is set and
	// outwardTrafficAllowed(). When false the handlers write nothing and never resolve the session.
	TrackerEnabled bool
	// HubOrigin is AUTH_JWT_ISSUER (maybeRollHubCookie's HUB_ORIGIN): without it nothing rolls.
	HubOrigin string
	// UpdateAgeMs is UPDATE_AGE_MS: (Number(AUTH_SESSION_UPDATE_AGE) || 86400) * 1000.
	UpdateAgeMs float64
	// ModeFor gives the cookie mode (host | shared) and whether the shared slot is read, for a request host:
	// AUTH_SESSION_COOKIE_MODE_BY_SITE, else AUTH_SESSION_COOKIE_MODE and AUTH_LEGACY_READ.
	ModeFor func(host string) (mode string, legacyRead bool)
	Now     func() time.Time
}

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

// Compute dispatches on the endpoint label.
func (e *Engine) Compute(ctx context.Context, endpoint string, r *Request) (Outcome, error) {
	switch endpoint {
	case EndpointPing:
		return e.Ping(ctx, r)
	case EndpointPulse:
		return e.Pulse(ctx, r)
	}
	return Outcome{}, fallback.New("unknown-endpoint")
}

// prologue is what runs before either handler body: the rare request shapes left to the Node app (a
// query string, an OPTIONS preflight, a conditional request), Next's body parser (whose ApiErrors
// Next answers itself) and PublicEndpoint's headers. done reports a finished outcome.
func prologue(r *Request) (pb parsedBody, resp Response, out Outcome, done bool, err error) {
	if r.HasQuery {
		return pb, resp, out, true, fallback.New("query-string")
	}
	if r.Method == "OPTIONS" {
		// PublicEndpoint answers a preflight itself; browsers never send one for these beacons.
		return pb, resp, out, true, fallback.New("preflight")
	}
	// A conditional request can turn a 400 into Next's 304 (sendData's `fresh` check); beacons never
	// send one.
	ims, _ := r.Header("if-modified-since")
	inm, _ := r.Header("if-none-match")
	if ims != "" || inm != "" {
		return pb, resp, out, true, fallback.New("conditional-request")
	}
	pb, nerr, err := parseBody(r)
	if err != nil {
		return pb, resp, out, true, err
	}
	if nerr != nil {
		return pb, resp, Outcome{Response: Response{Status: nerr.status, Body: nerr.body}}, true, nil
	}
	return pb, wrapperHeaders(r), out, false, nil
}

// Ping is src/pages/api/internal/ping.ts.
func (e *Engine) Ping(ctx context.Context, r *Request) (Outcome, error) {
	pb, resp, out, done, err := prologue(r)
	if done {
		return out, err
	}
	invalid := func() Outcome { return Outcome{Response: send400(resp, "invalid request")} }

	// `req.headers.referer ? new URL(req.headers.referer) : undefined`; a throw is a 400.
	referer, _ := r.Header("referer")
	var urlHostStr string
	haveURL := false
	if referer != "" {
		h, res := urlHostOf(referer)
		switch res {
		case urlUncertain:
			return Outcome{}, fallback.New("url")
		case urlThrows:
			return invalid(), nil
		}
		urlHostStr, haveURL = h, true
	}
	host, hostOK := r.Header("host")
	if !haveURL || !hostOK || urlHostStr != host {
		return invalid(), nil
	}

	// JSON.parse(req.body): a string body is parsed; an object (a JSON body) is
	// String()-ed to "[object Object]" and throws; a number, boolean or null re-parses to itself and
	// fails the schema. Either way a 400. An array String()s to its joined elements: not reproduced.
	var text string
	switch pb.kind {
	case bodyText:
		text = pb.text
	case bodyJSON:
		switch pb.json.Kind {
		case jsvalue.String:
			text = pb.json.S
		case jsvalue.Array:
			return Outcome{}, fallback.New("array-body")
		default:
			return invalid(), nil
		}
	}
	parsed, err := jsvalue.Parse(text)
	if errors.Is(err, jsvalue.ErrTooDeep) {
		return Outcome{}, fallback.New("json-depth")
	}
	if err != nil {
		return invalid(), nil
	}
	body, ok := parsePageView(parsed)
	if !ok {
		return invalid(), nil
	}
	country := "undefined"
	if c, ok := r.Header("cf-ipcountry"); ok {
		country = c
	}
	match := matchingPathname(body.path)
	if match == "" {
		return Outcome{Response: end200(resp)}, nil
	}
	if !e.TrackerEnabled {
		return Outcome{Response: end200(resp)}, nil
	}
	ip, err := resolveClientIP(r)
	if err != nil {
		return Outcome{}, err
	}
	user, err := e.Sessions.Resolve(ctx, r.HTTP)
	if err != nil {
		return Outcome{}, err
	}
	// The session is resolved (awaited) before the response here, so a rolling refresh would add a
	// Set-Cookie to this response: left to the Node app, which can mint it.
	if user != nil && e.rollDue(user, r.HTTP.Host) {
		return Outcome{}, fallback.New("session-roll-due")
	}
	row := jsvalue.NewObject()
	userID, memberType := 0.0, "undefined"
	if user != nil {
		userID = float64(user.ID)
		if user.TierSet {
			memberType = user.Tier
		}
	}
	row.Set("userId", jsvalue.NumberValue(userID))
	row.Set("memberType", jsvalue.StringValue(memberType))
	row.Set("ip", jsvalue.StringValue(ip))
	row.Set("pageId", jsvalue.StringValue(match))
	row.Set("path", jsvalue.StringValue(body.path))
	row.Set("host", jsvalue.StringValue(host))
	row.Set("country", jsvalue.StringValue(country))
	row.Set("ads", jsvalue.BoolValue(body.ads))
	row.Set("duration", jsvalue.NumberValue(clampToColumn(math.Floor(body.duration), uint32Max)))
	row.Set("windowWidth", jsvalue.NumberValue(clampToColumn(body.windowWidth, int16Max)))
	row.Set("windowHeight", jsvalue.NumberValue(clampToColumn(body.windowHeight, int16Max)))
	return Outcome{
		Response: end200(resp),
		Writes:   []Write{{Table: TablePageViews, Body: jsvalue.Stringify(jsvalue.ObjectValue(row))}},
	}, nil
}

// Pulse is src/pages/api/internal/pulse.ts.
func (e *Engine) Pulse(ctx context.Context, r *Request) (Outcome, error) {
	pb, resp, out, done, err := prologue(r)
	if done {
		return out, err
	}
	// `req.headers.origin ?? req.headers.referer`: an Origin that was sent, even empty, wins.
	source, ok := r.Header("origin")
	if !ok {
		source, _ = r.Header("referer")
	}
	sourceHost := ""
	if source != "" {
		h, res := urlHostOf(source)
		switch res {
		case urlUncertain:
			return Outcome{}, fallback.New("url")
		case urlHost:
			sourceHost = h
		}
	}
	host, hostOK := r.Header("host")
	if sourceHost == "" || !hostOK || sourceHost != host {
		return Outcome{Response: send400(resp, "invalid request")}, nil
	}

	invalidBody := func() Outcome { return Outcome{Response: send400(resp, "invalid body")} }
	var parsed jsvalue.Value
	switch pb.kind {
	case bodyText:
		v, err := jsvalue.Parse(pb.text)
		if errors.Is(err, jsvalue.ErrTooDeep) {
			return Outcome{}, fallback.New("json-depth")
		}
		if err != nil {
			return invalidBody(), nil
		}
		parsed = v
	case bodyJSON:
		parsed = pb.json
		if parsed.Kind == jsvalue.String {
			v, err := jsvalue.Parse(parsed.S)
			if errors.Is(err, jsvalue.ErrTooDeep) {
				return Outcome{}, fallback.New("json-depth")
			}
			if err != nil {
				return invalidBody(), nil
			}
			parsed = v
		}
	}
	values, ok := parseAddView(parsed)
	if !ok {
		return Outcome{Response: send400(resp, "invalid input")}, nil
	}
	if !e.TrackerEnabled {
		return Outcome{Response: end200(resp)}, nil
	}
	ip, err := resolveClientIP(r)
	if err != nil {
		return Outcome{}, err
	}
	// The Node handler does not await the view, so its session (and any rolling refresh, which then
	// fails to set its cookie on the already-sent response) resolves after the 200: no Set-Cookie
	// can reach this response, and none is attempted here.
	user, err := e.Sessions.Resolve(ctx, r.HTTP)
	if err != nil {
		return Outcome{}, err
	}
	userAgent := "unknown"
	if ua, ok := r.Header("user-agent"); ok {
		userAgent = ua
	}
	row := jsvalue.NewObject()
	userID := 0.0
	if user != nil {
		userID = float64(user.ID)
	}
	row.Set("userId", jsvalue.NumberValue(userID))
	row.Set("ip", jsvalue.StringValue(ip))
	row.Set("userAgent", jsvalue.StringValue(userAgent))
	for _, k := range values.Keys() {
		v, _ := values.Get(k)
		row.Set(k, v)
	}
	return Outcome{
		Response: end200(resp),
		Writes:   []Write{{Table: TableViews, Body: jsvalue.Stringify(jsvalue.ObjectValue(row))}},
	}, nil
}

// The pageViews column bounds (tracker.ts UINT32_MAX / INT16_MAX).
const (
	uint32Max = 4_294_967_295
	int16Max  = 32_767
)

// clampToColumn is tracker.ts clampToColumn: non-finite is 0, then truncate, negatives are 0, and
// anything past max is max.
func clampToColumn(v, limit float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	t := math.Trunc(v)
	if t < 0 {
		return 0
	}
	if t > limit {
		return limit
	}
	return t
}

// rollDue is whether getServerAuthSession would call maybeRollHubCookie and it would ask the hub for
// a fresh token: the read slot rolls (rollSlot), the hub origin is set, and the token's numeric,
// non-zero `iat` is at least UPDATE_AGE_MS old.
func (e *Engine) rollDue(u *auth.SessionUser, host string) bool {
	if e.HubOrigin == "" || u.Claims == nil {
		return false
	}
	if !e.rollSlot(u.CookieName, host) {
		return false
	}
	iat, ok := u.Claims.IssuedAt()
	if !ok || iat == 0 {
		return false
	}
	age := float64(e.now().UnixMilli()) - iat*1000
	return age >= e.UpdateAgeMs
}

// rollSlot is whether the cookie the session was read from rolls, in the request host's mode: a
// host-slot read rolls in either mode, a shared-slot read only in shared mode. Without the secure
// prefixes both slots are named `civ-token`, and the slot is the one CookieNames lists first.
func (e *Engine) rollSlot(cookie, host string) bool {
	var mode string
	var legacyRead bool
	if e.ModeFor != nil {
		mode, legacyRead = e.ModeFor(host)
	}
	hostMode := mode == "host"
	var slot string
	switch {
	case strings.HasPrefix(cookie, "__Host-"):
		slot = "host"
	case strings.HasPrefix(cookie, "__Secure-"):
		slot = "shared"
	case hostMode || !legacyRead:
		slot = "host"
	default:
		slot = "shared"
	}
	return slot == "host" || !hostMode
}
