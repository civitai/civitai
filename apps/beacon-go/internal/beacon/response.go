package beacon

import (
	"regexp"
	"strings"

	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// Header is one response header.
type Header struct {
	Name  string // lowercase
	Value string
}

// Response is what the Node app answers: status, the headers this service compares and writes
// (ComparedHeaders), and the body.
type Response struct {
	Status  int
	Headers []Header
	Body    string
}

// Get returns a header's value.
func (r *Response) Get(name string) (string, bool) {
	for _, h := range r.Headers {
		if h.Name == name {
			return h.Value, true
		}
	}
	return "", false
}

func (r *Response) set(name, value string) {
	for i := range r.Headers {
		if r.Headers[i].Name == name {
			r.Headers[i].Value = value
			return
		}
	}
	r.Headers = append(r.Headers, Header{Name: name, Value: value})
}

// ComparedHeaders are the response headers the handlers (PublicEndpoint and Next's res.send) decide.
// The shadow sampler reports these and only these; the rest (Date, Connection, Content-Length, ...)
// belong to the HTTP server, not to the endpoint.
var ComparedHeaders = []string{
	"access-control-allow-origin",
	"access-control-allow-headers",
	"access-control-allow-methods",
	"access-control-allow-credentials",
	"access-control-max-age",
	"vary",
	"cache-control",
	"etag",
	"content-type",
	"set-cookie",
}

// PublicEndpoint's constants (src/server/utils/endpoint-helpers.ts).
const (
	anonymousVary       = "Authorization"
	credentialedVary    = "Authorization, Cookie"
	corsAllowHeaders    = "Authorization, Content-Type, *"
	corsMaxAge          = "7200"
	privateCacheControl = "max-age=0, private, no-cache"
	// addPublicCacheHeaders with the default PUBLIC_CACHE_MAX_AGE (300): swr = floor(300 / 2).
	publicCacheControl = "public, s-maxage=300, stale-while-revalidate=150"
	// Both beacons are PublicEndpoint(handler, ['POST']).
	allowedMethods = "POST"
)

// sessionCookieNames is SESSION_COOKIE_NAMES in endpoint-helpers.ts: every spelling of the session
// cookies, independent of this deployment's cookie mode.
var sessionCookieNames = map[string]bool{
	"__Host-civ-token":       true,
	"__Secure-civ-token":     true,
	"civ-token":              true,
	"__Secure-civitai-token": true,
	"civitai-token":          true,
}

// carriesCallerCredentials is requestCarriesCallerCredentials for a request without a query string
// (one with a query falls back before this is asked): an Authorization header, or a cookie pair whose
// name is a session cookie name. The raw-header scan is a superset of the parsed `req.cookies` check
// (a name with an empty value, or with no `=`, counts), so it alone decides.
func carriesCallerCredentials(r *Request) bool {
	if v, _ := r.Header("authorization"); v != "" {
		return true
	}
	raw, _ := r.Header("cookie")
	if raw == "" {
		return false
	}
	for _, pair := range strings.Split(raw, ";") {
		name := pair
		if eq := strings.IndexByte(pair, '='); eq != -1 {
			name = pair[:eq]
		}
		// JS trim; a session cookie name is ASCII, so a non-ASCII-whitespace-trimmed name cannot match.
		if name = jsvalue.Trim(name); name != "" && sessionCookieNames[name] {
			return true
		}
	}
	return false
}

// verifiedCrawler is requestVerifiedCrawler: the verified-bot header is googlebot or bingbot.
func verifiedCrawler(r *Request) bool {
	v, _ := r.Header("x-civitai-verified-bot")
	return v == "googlebot" || v == "bingbot"
}

// wrapperHeaders are the headers PublicEndpoint sets before its handler runs, in its order: Vary,
// then CORS (addCorsHeaders without credentials), then — unless the request is a preflight — the
// cache directive. preflight reports an OPTIONS request, which PublicEndpoint answers itself.
func wrapperHeaders(r *Request) (resp Response, preflight bool) {
	credentialed := carriesCallerCredentials(r)
	if credentialed {
		resp.set("vary", credentialedVary)
	} else {
		resp.set("vary", anonymousVary)
	}
	resp.set("access-control-allow-origin", "*")
	resp.set("access-control-allow-headers", corsAllowHeaders)
	resp.set("access-control-allow-methods", allowedMethods)
	if r.Method == "OPTIONS" {
		resp.set("access-control-max-age", corsMaxAge)
		resp.Status = 200
		return resp, true
	}
	if credentialed || verifiedCrawler(r) {
		resp.set("cache-control", privateCacheControl)
	} else {
		resp.set("cache-control", publicCacheControl)
	}
	return resp, false
}

// sendETags are the ETags Next's res.send writes for the handlers' three string bodies: generateETag(body)
// (next/dist/server/lib/etag.js, fnv1a52 in base 36 plus the length in base 36), computed with Next
// 16.4.5's own function.
var sendETags = map[string]string{
	"invalid request": `"weftv9g98bf"`,
	"invalid body":    `"eueval305xc"`,
	"invalid input":   `"17fa7f31cyhd"`,
}

// jsSpace is JS's \s: WhiteSpace and LineTerminator (RE2's \s is ASCII only).
const jsSpace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// noCacheRe is fresh's CACHE_CONTROL_NO_CACHE_REGEXP, /(?:^|,)\s*?no-cache\s*?(?:,|$)/.
var noCacheRe = regexp.MustCompile(`(?:^|,)` + jsSpace + `*?no-cache` + jsSpace + `*?(?:,|$)`)

// fresh is the `fresh` package (next/dist/compiled/fresh) for a response with this ETag and no
// Last-Modified: true sends a 304 instead of the body.
func fresh(r *Request, etag string) bool {
	ims, _ := r.Header("if-modified-since")
	inm, _ := r.Header("if-none-match")
	if ims == "" && inm == "" {
		return false
	}
	if cc, _ := r.Header("cache-control"); cc != "" && noCacheRe.MatchString(cc) {
		return false
	}
	if inm != "" && inm != "*" {
		stale := true
		for _, m := range parseTokenList(inm) {
			if m == etag || m == "W/"+etag || "W/"+m == etag {
				stale = false
				break
			}
		}
		if stale {
			return false
		}
	}
	// No Last-Modified is ever set, so an If-Modified-Since is always stale.
	return ims == ""
}

// parseTokenList is fresh's parseTokenList: split on commas, dropping spaces around each token.
func parseTokenList(s string) []string {
	var list []string
	start, end := 0, 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case ' ':
			if start == end {
				start, end = i+1, i+1
			}
		case ',':
			list = append(list, s[start:end])
			start, end = i+1, i+1
		default:
			end = i + 1
		}
	}
	return append(list, s[start:end])
}

// send400 is Next's res.status(400).send(body) for a string body (sendData): an ETag, then 304 with
// no body when the request is fresh for it, else the body with no Content-Type.
func send400(r *Request, resp Response, body string) Response {
	resp.Headers = append([]Header(nil), resp.Headers...)
	etag := sendETags[body]
	resp.set("etag", etag)
	if fresh(r, etag) {
		resp.Status = 304
		return resp
	}
	resp.Status = 400
	resp.Body = body
	return resp
}

// end200 is res.status(200).end(): no body, no ETag.
func end200(resp Response) Response {
	resp.Headers = append([]Header(nil), resp.Headers...)
	resp.Status = 200
	return resp
}
