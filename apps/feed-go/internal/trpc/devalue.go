package trpc

import (
	"context"
	"net/http"
	"strconv"
	"strings"
)

// WriteDevalueEnv is the master switch the main app reads (WRITE_DEVALUE in
// src/shared/utils/trpc-union-transformer.ts), read here under the same name so one deployment
// variable turns both on and off.
const WriteDevalueEnv = "TRPC_WRITE_DEVALUE"

// WriteDevalueOn is the app's reading of that variable: `process.env.TRPC_WRITE_DEVALUE === 'true'`,
// exactly "true" (not "1", not "TRUE"). Unset is off: every answer is superjson, as before.
func WriteDevalueOn(v string) bool { return v == "true" }

// 5.0.2080 is PHASE1_CLIENT_VERSION (src/server/utils/client-version-saturation.ts): the first web
// bundle version certain to carry the union deserializer, so to read a devalue answer.
const (
	phase1Major = 5
	phase1Minor = 0
	phase1Patch = 2080
)

// CanDecodeDevalueResponse is canDecodeDevalueResponse (client-version-saturation.ts): the request
// comes from the civitai.com web bundle (`x-client: web`) at a version of at least 5.0.2080. API
// keys, apps, SDKs, CLIs and older bundles read only the superjson shape.
//
// The headers are read as the app reads them: Node's HTTP parser joins a repeated header with ", ",
// so a repeated `x-client` is not "web" and a repeated version is not a valid semver.
func CanDecodeDevalueResponse(h http.Header) bool {
	client, ok := nodeHeader(h, "x-client")
	if !ok || client != "web" {
		return false
	}
	version, ok := nodeHeader(h, "x-client-version")
	return ok && phase1CapableVersion(version)
}

// nodeHeader is req.headers[name] in Node: the values joined with ", ", absent when never sent.
func nodeHeader(h http.Header, name string) (string, bool) {
	vs := h.Values(name)
	if len(vs) == 0 {
		return "", false
	}
	return strings.Join(vs, ", "), true
}

// semverMaxLength and maxSafeInteger are node-semver's MAX_LENGTH and Number.MAX_SAFE_INTEGER
// (node_modules/semver/internal/constants.js).
const (
	semverMaxLength = 256
	maxSafeInteger  = 1<<53 - 1
)

// phase1CapableVersion is isPhase1CapableClientVersion: `semver.valid(version)` (node-semver 7, strict
// parsing) and then `semver.gte(valid, '5.0.2080')`. Empty and unparseable versions are not capable.
func phase1CapableVersion(version string) bool {
	if version == "" || len(version) > semverMaxLength {
		return false
	}
	major, minor, patch, pre, ok := parseSemver(trimJS(version))
	if !ok {
		return false
	}
	if major != phase1Major {
		return major > phase1Major
	}
	if minor != phase1Minor {
		return minor > phase1Minor
	}
	if patch != phase1Patch {
		return patch > phase1Patch
	}
	// The same version: a prerelease of it is lower (5.0.2080-x < 5.0.2080).
	return !pre
}

// parseSemver matches node-semver's FULL regexp: `v?` then MAJOR.MINOR.PATCH (each `0` or a digit
// run without a leading zero, at most Number.MAX_SAFE_INTEGER), an optional `-` prerelease
// (dot-separated identifiers: numeric without a leading zero, or alphanumeric with at least one
// letter or `-`) and an optional `+` build (dot-separated non-empty [0-9A-Za-z-] runs). pre reports a
// prerelease.
func parseSemver(s string) (major, minor, patch uint64, pre, ok bool) {
	s = strings.TrimPrefix(s, "v")
	var rest string
	var good bool
	if major, rest, good = numericPart(s); !good || !strings.HasPrefix(rest, ".") {
		return 0, 0, 0, false, false
	}
	if minor, rest, good = numericPart(rest[1:]); !good || !strings.HasPrefix(rest, ".") {
		return 0, 0, 0, false, false
	}
	if patch, rest, good = numericPart(rest[1:]); !good {
		return 0, 0, 0, false, false
	}
	if strings.HasPrefix(rest, "-") {
		pre = true
		end := strings.IndexByte(rest, '+')
		if end < 0 {
			end = len(rest)
		}
		for _, id := range strings.Split(rest[1:end], ".") {
			if !prereleaseIdentifier(id) {
				return 0, 0, 0, false, false
			}
		}
		rest = rest[end:]
	}
	if strings.HasPrefix(rest, "+") {
		for _, id := range strings.Split(rest[1:], ".") {
			if id == "" || !allLetterDashNumber(id) {
				return 0, 0, 0, false, false
			}
		}
		rest = ""
	}
	if rest != "" {
		return 0, 0, 0, false, false
	}
	return major, minor, patch, pre, true
}

// numericPart reads NUMERICIDENTIFIER (`0|[1-9]\d*`) from the front of s.
func numericPart(s string) (uint64, string, bool) {
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '9' {
		n++
	}
	if n == 0 || (n > 1 && s[0] == '0') {
		return 0, s, false
	}
	v, err := strconv.ParseUint(s[:n], 10, 64)
	if err != nil || v > maxSafeInteger {
		// `+m[1] > MAX_SAFE_INTEGER` throws "Invalid major version", so the version is not valid.
		return 0, s, false
	}
	return v, s[n:], true
}

// prereleaseIdentifier is PRERELEASEIDENTIFIER: a numeric identifier (no leading zero) or
// NONNUMERICIDENTIFIER (`\d*[a-zA-Z-][a-zA-Z0-9-]*`).
func prereleaseIdentifier(id string) bool {
	if id == "" || !allLetterDashNumber(id) {
		return false
	}
	for i := 0; i < len(id); i++ {
		if id[i] < '0' || id[i] > '9' {
			return true // has a letter or '-': non-numeric
		}
	}
	return len(id) == 1 || id[0] != '0'
}

func allLetterDashNumber(s string) bool {
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '-':
		default:
			return false
		}
	}
	return true
}

// trimJS is String.prototype.trim: it strips ECMAScript WhiteSpace and LineTerminator characters,
// which are not Go's unicode.IsSpace set (JS strips U+FEFF and keeps U+0085).
func trimJS(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
			return true
		}
		return r >= '\u2000' && r <= '\u200a'
	})
}

// EdgeCached is willEdgeCache (src/server/trpc/edge-cache-headers.ts) for an answer this service
// writes: it carries a positive edge TTL, so the CDN keeps it and serves it to whoever asks next.
func EdgeCached(ttl *CacheTTL) bool {
	return ttl != nil && ttl.Edge > 0
}

type devalueKey struct{}

// WithDevalueWrite marks ctx as a request whose answer may be written as devalue: the switch is on
// and the client can read it (CanDecodeDevalueResponse). runWithResponseWriteFormat in
// src/server/trpc/response-write-format.ts.
func WithDevalueWrite(ctx context.Context) context.Context {
	return context.WithValue(ctx, devalueKey{}, true)
}

// DevalueWrite reports whether the answer to ctx's request, with cache policy ttl, is written as
// devalue: the request is marked (WithDevalueWrite) and the answer is not edge-cacheable. A cached
// body is served by URL to whatever client asks next, and the CDN ignores Vary on these answers, so
// a cacheable answer is always superjson, the format every client reads
// (pinResponseWriteToSuperjson). No mark, as on every shadow sample and probe, is superjson.
func DevalueWrite(ctx context.Context, ttl *CacheTTL) bool {
	on, _ := ctx.Value(devalueKey{}).(bool)
	return on && !EdgeCached(ttl)
}
