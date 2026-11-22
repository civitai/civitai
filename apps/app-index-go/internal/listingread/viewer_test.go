package listingread

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

var testKey = []byte("0123456789abcdef0123456789abcdef")

// vectorToken is the token for {"host":"red","level":15,"scope":"full","exp":1767225600} under
// testKey, computed with Python's hmac module, not with SignViewer, so the web tier's signer can
// be tested against the same literal. A test key, not a credential.
//
//nolint:gosec // G101: a public test vector under testKey
const vectorToken = "v1.eyJob3N0IjoicmVkIiwibGV2ZWwiOjE1LCJzY29wZSI6ImZ1bGwiLCJleHAiOjE3NjcyMjU2MDB9.FZ0CacyygXrG2YSxsuUyC9mbjHhsg5SCVWBUkPQNSds"

var vectorExp = time.Unix(1767225600, 0)

func TestViewerVector(t *testing.T) {
	if got := SignViewer(testKey, Viewer{RedCapable: true, BrowsingLevel: 15, Scope: "full"}, vectorExp); got != vectorToken {
		t.Fatalf("SignViewer\n got %s\nwant %s", got, vectorToken)
	}
	v, err := ParseViewer([][]byte{testKey}, vectorToken, vectorExp.Add(-time.Minute))
	if err != nil || v != (Viewer{RedCapable: true, BrowsingLevel: 15, Scope: "full"}) {
		t.Fatalf("ParseViewer: %+v %v", v, err)
	}
}

// sign is a token over an arbitrary payload, for the refusal cases SignViewer cannot produce.
func sign(key []byte, payload string) string {
	s := "v1." + base64.RawURLEncoding.EncodeToString([]byte(payload))
	m := hmac.New(sha256.New, key)
	m.Write([]byte(s))
	return s + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func TestParseViewer(t *testing.T) {
	now := vectorExp.Add(-time.Minute)
	exp := "1767225600"
	ok := func(name, payload string, want Viewer) {
		t.Helper()
		v, err := ParseViewer([][]byte{testKey}, sign(testKey, payload), now)
		if err != nil || v != want {
			t.Errorf("%s: %+v %v, want %+v", name, v, err, want)
		}
	}
	ok("main host", `{"host":"main","level":31,"scope":"public-external","exp":`+exp+`}`,
		Viewer{BrowsingLevel: 31, Scope: ScopePublicExternal})
	ok("keys in any order", `{"exp":`+exp+`,"scope":"none","level":0,"host":"red"}`,
		Viewer{RedCapable: true, Scope: ScopeNone})
	// An unknown scope is `none`, as narrowStoreScope reads it: never a refusal that a caller could
	// mistake for a transient error, and never a grant.
	ok("unknown scope", `{"host":"main","level":0,"scope":"everything","exp":`+exp+`}`, Viewer{Scope: ScopeNone})
	ok("Blocked bit allowed", `{"host":"red","level":63,"scope":"full","exp":`+exp+`}`,
		Viewer{RedCapable: true, BrowsingLevel: 63, Scope: ScopeFull})

	bad := func(name, token string, at time.Time, key []byte) {
		t.Helper()
		if v, err := ParseViewer([][]byte{key}, token, at); !errors.Is(err, ErrBadViewer) {
			t.Errorf("%s: %+v %v, want ErrBadViewer", name, v, err)
		}
	}
	good := `{"host":"red","level":15,"scope":"full","exp":` + exp + `}`
	bad("empty", "", now, testKey)
	bad("wrong key", sign([]byte("another key of thirty-two bytes!"), good), now, testKey)
	bad("short key", sign(testKey[:31], good), now, testKey[:31])
	bad("tampered payload", vectorToken[:10]+"x"+vectorToken[11:], now, testKey)
	bad("tampered signature", vectorToken[:len(vectorToken)-2]+"AA", now, testKey)
	bad("v2", "v2"+sign(testKey, good)[2:], now, testKey)
	bad("two segments", "v1.abc", now, testKey)
	// Otherwise valid: an unknown scope alone would be read as `none`, so only the length refuses it.
	bad("too long", sign(testKey, `{"host":"red","level":15,"scope":"`+strings.Repeat("a", 600)+`","exp":`+exp+`}`), now, testKey)
	bad("expired", sign(testKey, good), vectorExp.Add(viewerSkew+time.Second), testKey)
	bad("too far ahead", sign(testKey, good), vectorExp.Add(-MaxViewerTTL-viewerSkew-time.Second), testKey)
	bad("unknown host", sign(testKey, `{"host":"blue","level":15,"scope":"full","exp":`+exp+`}`), now, testKey)
	bad("negative level", sign(testKey, `{"host":"red","level":-1,"scope":"full","exp":`+exp+`}`), now, testKey)
	bad("level above 63", sign(testKey, `{"host":"red","level":64,"scope":"full","exp":`+exp+`}`), now, testKey)
	bad("missing level", sign(testKey, `{"host":"red","scope":"full","exp":`+exp+`}`), now, testKey)
	bad("missing exp", sign(testKey, `{"host":"red","level":15,"scope":"full"}`), now, testKey)
	bad("unknown field", sign(testKey, `{"host":"red","level":15,"scope":"full","exp":`+exp+`,"userId":1}`), now, testKey)
	bad("not JSON", sign(testKey, `host=red`), now, testKey)
	bad("trailing data", sign(testKey, good+`{}`), now, testKey)
	// The edges themselves are accepted.
	if _, err := ParseViewer([][]byte{testKey}, sign(testKey, good), vectorExp.Add(viewerSkew)); err != nil {
		t.Errorf("at expiry + skew: %v", err)
	}
	if _, err := ParseViewer([][]byte{testKey}, sign(testKey, good), vectorExp.Add(-MaxViewerTTL-viewerSkew)); err != nil {
		t.Errorf("at the longest lifetime: %v", err)
	}
}
