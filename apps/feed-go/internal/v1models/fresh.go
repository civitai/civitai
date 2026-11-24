package v1models

import (
	"net/http"
	"regexp"
)

// Next answers a conditional request to either model route itself: res.json → sendData
// (next/dist/server/api-utils/node/api-resolver.js) sets the ETag, then sendEtagResponse
// (next/dist/server/send-payload.js) answers 304 with an empty body when
// `fresh(req.headers, { etag })` (next/dist/compiled/fresh/index.js, the `fresh` package Next
// bundles; Next 16.4.5) is true. Fresh is that function for the one response header Next passes,
// the ETag: there is no Last-Modified, so any If-Modified-Since makes the request not fresh.
//
// The reads are held to ASCII text in one header line each (ConditionalUnsupported falls back
// otherwise): JS's `\s` and Node's joining of repeated header lines are then not in play.

// conditionalHeaders are the request headers fresh reads.
var conditionalHeaders = []string{"If-None-Match", "If-Modified-Since", "Cache-Control"}

// noCacheRe is fresh's `/(?:^|,)\s*?no-cache\s*?(?:,|$)/` over ASCII text, where JS's `\s` is
// [\t\n\v\f\r ] (Go's `\s` has no \v). Case-sensitive, as fresh's.
var noCacheRe = regexp.MustCompile(`(?:^|,)[\t\n\v\f\r ]*?no-cache[\t\n\v\f\r ]*?(?:,|$)`)

// ConditionalUnsupported reports whether a conditional request (an If-None-Match or
// If-Modified-Since line, empty or not) is one Fresh does not decide as Next does: one of the
// headers fresh reads sent on more than one line (Node joins If-None-Match and Cache-Control lines
// with ", " and keeps the first If-Modified-Since), or holding a byte outside ASCII.
func ConditionalUnsupported(h http.Header) bool {
	if len(h.Values("If-None-Match")) == 0 && len(h.Values("If-Modified-Since")) == 0 {
		return false
	}
	for _, name := range conditionalHeaders {
		vals := h.Values(name)
		if len(vals) > 1 {
			return true
		}
		for _, v := range vals {
			for i := 0; i < len(v); i++ {
				if v[i] >= 0x80 {
					return true
				}
			}
		}
	}
	return false
}

// Fresh is Next's `fresh(req.headers, { etag })`: whether the answer whose ETag is etag is a 304.
//
//   - neither If-Modified-Since nor If-None-Match (an empty value is absent): not fresh;
//   - a Cache-Control naming no-cache: not fresh;
//   - an If-None-Match other than `*`: fresh only if one of its comma-separated tokens equals the
//     ETag, or `W/` + the ETag, or is the ETag with `W/` dropped (weak on either side);
//   - any If-Modified-Since: not fresh (Next passes no Last-Modified), whatever If-None-Match says;
//   - else (a matching or `*` If-None-Match alone): fresh.
func Fresh(h http.Header, etag string) bool {
	ims, inm := h.Get("If-Modified-Since"), h.Get("If-None-Match")
	if ims == "" && inm == "" {
		return false
	}
	if cc := h.Get("Cache-Control"); cc != "" && noCacheRe.MatchString(cc) {
		return false
	}
	if inm != "" && inm != "*" {
		if etag == "" {
			return false
		}
		matched := false
		for _, tok := range parseTokenList(inm) {
			if tok == etag || tok == "W/"+etag || "W/"+tok == etag {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	// `!lastModified || !(parseHttpDate(lastModified) <= parseHttpDate(modifiedSince))`: there is
	// no Last-Modified, so an If-Modified-Since is never satisfied.
	return ims == ""
}

// parseTokenList is fresh's parseTokenList: the comma-separated tokens of s, each with the spaces
// (only 0x20) before and after it dropped; an empty token is kept.
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
