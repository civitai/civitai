// Package sign is the signature on every request this service forwards to the site's internal
// storage route (WRITES-DESIGN.md, "The internal route", step 1). The site recomputes it over the
// request it received and refuses a mismatch, or a timestamp more than 60 s from its own clock,
// before anything else runs. Both sides check themselves against the same golden vectors,
// testdata/vectors.json, kept byte-identical at the same path in the site's tests, so the two cannot
// drift apart unseen.
package sign

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// The two headers the signature travels in.
const (
	// TimestampHeader carries the unix time in seconds, in decimal, that the signature covers.
	TimestampHeader = "x-app-data-ts"
	// SignatureHeader carries the lowercase hex HMAC-SHA256 of Canonical under the shared key.
	SignatureHeader = "x-app-data-sig"
)

// RegionHeaders are the edge's region headers, in the order the region line names them. The forward
// carries those the viewer's request carried, and the signature covers them, so the site can apply
// its region rules to values only this service could have sent.
var RegionHeaders = []string{"cf-ipcountry", "cf-region-code", "x-isuk"}

// RegionLine is the canonical string's sixth line: the values of RegionHeaders, in that order, joined
// by ",", each empty when absent; the empty string when all are absent. values is indexed as
// RegionHeaders.
func RegionLine(values [3]string) string {
	if values == [3]string{} {
		return ""
	}
	return strings.Join(values[:], ",")
}

// Canonical is what is signed: six lines joined by "\n", with no trailing newline:
//
//  1. the method, uppercase;
//  2. the request path exactly as sent on the wire (escaped, never decoded or normalised);
//  3. the full raw query string exactly as sent, without the leading `?` (empty when none);
//  4. the timestamp, exactly as sent in TimestampHeader;
//  5. the lowercase hex SHA-256 of the raw body bytes (of zero bytes for an empty body);
//  6. the region line (RegionLine).
func Canonical(method, path, rawQuery, timestamp string, body []byte, regionLine string) string {
	sum := sha256.Sum256(body)
	return strings.Join([]string{strings.ToUpper(method), path, rawQuery, timestamp, hex.EncodeToString(sum[:]), regionLine}, "\n")
}

// Sign is the lowercase hex HMAC-SHA256 of Canonical under key.
func Sign(key []byte, method, path, rawQuery, timestamp string, body []byte, regionLine string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(Canonical(method, path, rawQuery, timestamp, body, regionLine)))
	return hex.EncodeToString(mac.Sum(nil))
}
