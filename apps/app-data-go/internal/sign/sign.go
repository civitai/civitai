// Package sign is the signature on every request this service forwards to the site's internal
// storage route (WRITES-DESIGN.md, "The internal route", step 1). The site recomputes it over the
// request it received and refuses a mismatch, or a timestamp more than 60 s from its own clock,
// before anything else runs. The TypeScript side pins the same golden vector as sign_test.go, so the
// two cannot drift apart unseen.
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

// Canonical is what is signed: five lines joined by "\n", with no trailing newline:
//
//  1. the method, uppercase;
//  2. the request path exactly as sent on the wire (escaped, never decoded or normalised);
//  3. the full raw query string exactly as sent, without the leading `?` (empty when none);
//  4. the timestamp, exactly as sent in TimestampHeader;
//  5. the lowercase hex SHA-256 of the raw body bytes (of zero bytes for an empty body).
func Canonical(method, path, rawQuery, timestamp string, body []byte) string {
	sum := sha256.Sum256(body)
	return strings.Join([]string{strings.ToUpper(method), path, rawQuery, timestamp, hex.EncodeToString(sum[:])}, "\n")
}

// Sign is the lowercase hex HMAC-SHA256 of Canonical under key.
func Sign(key []byte, method, path, rawQuery, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(Canonical(method, path, rawQuery, timestamp, body)))
	return hex.EncodeToString(mac.Sum(nil))
}
