package listingread

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Viewer is who a listing request is answered for: the audience the web tier resolved for the
// request it is serving, which this service never decides itself.
//
//   - RedCapable is `isRedCapableHost(host)`: whether the request's host may show mature content.
//   - BrowsingLevel is the viewer's browsing level as the store reads it (viewerBrowsingLevel):
//     the mature ratings it admits on a red-capable host (matureRatingsAllowed) and, on such a
//     host, the levels it adds to the media ceiling (redHostMediaCeiling). 0 is the public floor.
//     Ignored off a red-capable host, as on the site.
//   - Scope is the store visibility scope (resolveStoreVisibilityScope), narrowed (NarrowScope).
//
// The audience floor is not here: only a `public`-floor viewer is answered from the read model
// (LISTINGS-READ-MODEL.md, "Visibility"); the web tier keeps every other floor on the database.
type Viewer struct {
	RedCapable    bool
	BrowsingLevel int64
	Scope         string
}

// ViewerHeader carries the viewer of a listing request: a token the web tier signs with the key
// it shares with this service (APP_INDEX_VIEWER_KEY). The listing routes answer nothing without a
// valid one.
const ViewerHeader = "X-App-Index-Viewer"

// Bounds of a viewer token.
const (
	// MinViewerKeyLen is the shortest key accepted: 32 bytes, the HMAC-SHA256 block of security.
	MinViewerKeyLen = 32
	// MaxViewerTTL is the longest a token may be valid for, from now. The web tier signs one per
	// request, so this only bounds how long a token seen in transit stays usable.
	MaxViewerTTL = 5 * time.Minute
	// viewerSkew is the clock difference tolerated between the two services.
	viewerSkew = 30 * time.Second
	// viewerVersion is the token format's version, its first segment.
	viewerVersion = "v1"
	// maxViewerToken bounds the header before any work is done on it.
	maxViewerToken = 512
	// maxBrowsingLevel bounds the level a token may carry: every NsfwLevel bit (Blocked included,
	// which every gate masks off) and no more.
	maxBrowsingLevel = 63
)

// ErrBadViewer is any viewer token that is missing, malformed, wrongly signed or expired.
var ErrBadViewer = errors.New("listingread: bad viewer token")

// viewerClaims is a token's payload. Every field is required.
type viewerClaims struct {
	Host  *string `json:"host"`  // "main" or "red"
	Level *int64  `json:"level"` // 0..63
	Scope *string `json:"scope"` // a store visibility scope; any other value is `none`
	Exp   *int64  `json:"exp"`   // Unix seconds
}

// SignViewer is the token the web tier sends for v, valid until exp:
//
//	v1.<payload>.<signature>
//
// payload is the unpadded base64url of the JSON object {"host":"main"|"red","level":<int>,
// "scope":"full"|"public-external"|"none","exp":<unix seconds>}, and signature the unpadded
// base64url of HMAC-SHA256(key, "v1." + payload). The signature covers the payload segment as sent,
// so the web tier's signer may order the keys as it likes; viewer_test.go holds a literal vector.
func SignViewer(key []byte, v Viewer, exp time.Time) string {
	host := "main"
	if v.RedCapable {
		host = "red"
	}
	level, scope, e := v.BrowsingLevel, v.Scope, exp.Unix()
	payload, _ := json.Marshal(viewerClaims{Host: &host, Level: &level, Scope: &scope, Exp: &e})
	signed := viewerVersion + "." + base64.RawURLEncoding.EncodeToString(payload)
	return signed + "." + base64.RawURLEncoding.EncodeToString(viewerMAC(key, signed))
}

func viewerMAC(key []byte, signed string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(signed))
	return m.Sum(nil)
}

// ParseViewer checks a viewer token at now and returns its viewer, or ErrBadViewer. The signature
// is checked before the payload is read. A scope this build does not know is `none` (NarrowScope),
// as on the site; an unknown host, a level outside 0..63, an unknown field, a missing field, or an
// expiry in the past or more than MaxViewerTTL ahead (each with viewerSkew) is refused.
func ParseViewer(key []byte, token string, now time.Time) (Viewer, error) {
	if len(key) < MinViewerKeyLen || token == "" || len(token) > maxViewerToken {
		return Viewer{}, ErrBadViewer
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != viewerVersion {
		return Viewer{}, ErrBadViewer
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, viewerMAC(key, parts[0]+"."+parts[1])) {
		return Viewer{}, ErrBadViewer
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Viewer{}, ErrBadViewer
	}
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.DisallowUnknownFields()
	var c viewerClaims
	if dec.Decode(&c) != nil || dec.More() || c.Host == nil || c.Level == nil || c.Scope == nil || c.Exp == nil {
		return Viewer{}, ErrBadViewer
	}
	exp := time.Unix(*c.Exp, 0)
	if now.After(exp.Add(viewerSkew)) || exp.After(now.Add(MaxViewerTTL+viewerSkew)) {
		return Viewer{}, ErrBadViewer
	}
	if *c.Level < 0 || *c.Level > maxBrowsingLevel {
		return Viewer{}, ErrBadViewer
	}
	v := Viewer{BrowsingLevel: *c.Level, Scope: NarrowScope(*c.Scope)}
	switch *c.Host {
	case "main":
	case "red":
		v.RedCapable = true
	default:
		return Viewer{}, ErrBadViewer
	}
	return v, nil
}
