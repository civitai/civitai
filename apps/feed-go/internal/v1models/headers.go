package v1models

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/civitai/civitai/apps/feed-go/internal/apipolicy"
)

// The response headers Node sends with a 200 on `GET /api/v1/models` and `GET /api/v1/models/[id]`
// (DESIGN.md §16.8). They decide how Cloudflare and browsers cache the public API, so a served answer
// must carry exactly Node's, and the shadow compares them (shadow.RESTComparedHeaders). The goldens
// pin the result against the real Node route (testdata/golden/v1-models-headers, configheaders.json).
//
// Not reproduced, so the request falls back instead (internal/server/v1models_serve.go): the list's
// X-Expires (an `etag` query), `[id]`'s block-scope CORS headers (an Origin), and Next's 304 to a
// conditional request.
const (
	corsAllowOrigin  = "*"
	corsAllowHeaders = "Authorization, Content-Type, *"
	corsAllowMethods = "GET"
	// addPublicCacheHeaders at PUBLIC_CACHE_MAX_AGE (300): `stale-while-revalidate` is half of it.
	publicCacheControl = "public, s-maxage=300, stale-while-revalidate=150"
	// The handlers' own value: the body depends on the caller's region.
	noStoreCacheControl = "private, no-store"
	anonymousVary       = "Authorization"
	credentialedVary    = "Authorization, Cookie"
	// JSONContentType is Next's JSON_CONTENT_TYPE_HEADER, which res.json sets.
	JSONContentType = "application/json; charset=utf-8"
)

// sessionCookieNames is SESSION_COOKIE_NAMES (endpoint-helpers.ts): every name a session cookie can
// have, the legacy next-auth one included (hostSessionCookieName(true), sessionCookieName(true|false),
// legacySessionCookieName(true|false) in packages/civitai-auth/src/cookies.ts).
var sessionCookieNames = []string{"__Host-civ-token", "__Secure-civ-token", "civ-token", "__Secure-civitai-token", "civitai-token"}

//go:embed configheaders.json
var configHeadersJSON []byte

// Header is one response header, named as Node names it.
type Header struct{ Name, Value string }

// configHeaders is configheaders.json's list, read at init so a malformed file fails at startup.
var configHeaders = func() []Header {
	var doc struct {
		Headers []struct{ Key, Value string } `json:"headers"`
	}
	if err := json.Unmarshal(configHeadersJSON, &doc); err != nil || len(doc.Headers) == 0 {
		panic("v1models: configheaders.json: no headers")
	}
	out := make([]Header, len(doc.Headers))
	for i, h := range doc.Headers {
		out[i] = Header{Name: h.Key, Value: h.Value}
	}
	return out
}()

// HeaderInput is what the two routes' headers depend on.
type HeaderInput struct {
	// Detail: `GET /api/v1/models/[id]` (PublicEndpoint, Cache-Control set by the handler on every 200).
	Detail bool
	// Credentialed is requestCarriesCallerCredentials (CarriesCallerCredentials).
	Credentialed bool
	// VerifiedCrawler: the request carries the verified-crawler header the API policy decided.
	VerifiedCrawler bool
	// Nsfw is the list's parsed `nsfw` (unused on `[id]`).
	Nsfw bool
}

// ResponseHeaders are the headers Node sends with a 200 whose body is body (the bytes res.json
// writes, NodeBody's output), in the order Node sets them; Content-Type and Content-Length (transport)
// are not included.
func ResponseHeaders(in HeaderInput, body []byte) []Header {
	out := make([]Header, 0, len(configHeaders)+6)
	out = append(out, configHeaders...)
	vary := anonymousVary
	if in.Credentialed {
		vary = credentialedVary
	}
	cc := publicCacheControl
	if in.Credentialed || in.VerifiedCrawler {
		cc = apipolicy.PrivateCacheControl()
	}
	if in.Detail || in.Nsfw {
		cc = noStoreCacheControl
	}
	return append(out,
		Header{"Vary", vary},
		Header{"Access-Control-Allow-Origin", corsAllowOrigin},
		Header{"Access-Control-Allow-Headers", corsAllowHeaders},
		Header{"Access-Control-Allow-Methods", corsAllowMethods},
		Header{"Cache-Control", cc},
		Header{"ETag", ETag(body)},
	)
}

// HeaderMap is hs keyed by lowercased name, as the Node sampler sends them.
func HeaderMap(hs []Header) map[string]string {
	m := make(map[string]string, len(hs))
	for _, h := range hs {
		m[strings.ToLower(h.Name)] = h.Value
	}
	return m
}

// CarriesCallerCredentials is requestCarriesCallerCredentials (endpoint-helpers.ts), the header-only
// read both wrappers branch on: an Authorization header, a cookie under a session cookie name (any
// value, an empty one included: the raw-header arm checks the name only), or a non-empty `token`
// query value. Several Cookie lines are read as Node joins them.
func CarriesCallerCredentials(h http.Header, rawQuery string) bool {
	for _, v := range h.Values("Authorization") {
		if v != "" {
			return true
		}
	}
	if HasSessionCookie(h) {
		return true
	}
	q, _ := url.ParseQuery(rawQuery)
	for _, v := range q["token"] {
		if v != "" {
			return true
		}
	}
	return false
}

// HasSessionCookie reports whether a Cookie header names a session cookie (sessionCookieNames),
// whatever its value: the raw-header arm of requestCarriesCallerCredentials.
func HasSessionCookie(h http.Header) bool {
	for _, line := range h.Values("Cookie") {
		for _, pair := range strings.Split(line, ";") {
			name := pair
			if eq := strings.IndexByte(pair, '='); eq >= 0 {
				name = pair[:eq]
			}
			if name = strings.TrimSpace(name); name != "" && slices.Contains(sessionCookieNames, name) {
				return true
			}
		}
	}
	return false
}

// NodeBody is body (superjson.Plain's bytes) as JSON.stringify writes the same value: the plain
// writer escapes U+2028 and U+2029 where JSON.stringify writes them raw, so those escapes are written
// raw here. ok is false when the body holds an escaped U+FFFD, which the writer emits only for an
// invalid UTF-8 byte: JSON.stringify's text for that value is not known here. The bytes matter on a
// served answer and to its ETag, which Next computes over the string res.json writes.
func NodeBody(body []byte) (out []byte, ok bool) {
	out = body
	copied := false
	start := 0
	for i := 0; i < len(body); i++ {
		if body[i] != '\\' {
			continue
		}
		// A backslash appears only inside a string, always opening an escape.
		if i+1 >= len(body) || body[i+1] != 'u' || i+5 >= len(body) {
			i++
			continue
		}
		switch string(body[i+2 : i+6]) {
		case "fffd":
			return nil, false
		case "2028", "2029":
			if !copied {
				out = make([]byte, 0, len(body))
				copied = true
			}
			out = append(out, body[start:i]...)
			r := '\u2028'
			if body[i+5] == '9' {
				r = '\u2029'
			}
			out = utf8.AppendRune(out, r)
			start = i + 6
		}
		i += 5
	}
	if copied {
		out = append(out, body[start:]...)
	}
	return out, true
}

// ETag is Next's generateETag (next/dist/server/lib/etag.js) over body, the UTF-8 bytes of the string
// res.json sends: FNV-1a 52 over the string's UTF-16 code units in base 36, then its UTF-16 length in
// base 36, in double quotes. Not weak.
func ETag(body []byte) string {
	var v0, v1, v2, v3 uint64 = 0x2325, 0x8422, 0x9ce4, 0xcbf2
	n := 0
	unit := func(c uint64) {
		n++
		v0 ^= c
		t0 := v0 * 435
		t1 := v1 * 435
		t2 := v2 * 435
		t3 := v3 * 435
		t2 += v0 << 8
		t3 += v1 << 8
		t1 += t0 >> 16
		v0 = t0 & 65535
		t2 += t1 >> 16
		v1 = t1 & 65535
		v3 = (t3 + (t2 >> 16)) & 65535
		v2 = t2 & 65535
	}
	var pair [2]uint16
	for _, r := range string(body) {
		// A rune past U+FFFF is a surrogate pair: two code units, as String#charCodeAt reads it.
		for _, u := range utf16.AppendRune(pair[:0], r) {
			unit(uint64(u))
		}
	}
	h := (v3&15)*281474976710656 + v2*4294967296 + v1*65536 + (v0 ^ (v3 >> 4))
	return `"` + strconv.FormatUint(h, 36) + strconv.FormatInt(int64(n), 36) + `"`
}
