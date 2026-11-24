package listingread

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// A rotation: a token signed with either key verifies, one signed with neither does not, and a
// short key anywhere in the set accepts nothing.
func TestParseViewerTwoKeys(t *testing.T) {
	next := []byte("fedcba9876543210fedcba9876543210")
	third := []byte("another key of thirty-two bytes!")
	now := vectorExp.Add(-time.Minute)
	v := Viewer{RedCapable: true, BrowsingLevel: 15, Scope: ScopeFull}
	both := [][]byte{testKey, next}
	for name, key := range map[string][]byte{"current": testKey, "next": next} {
		if got, err := ParseViewer(both, SignViewer(key, v, vectorExp), now); err != nil || got != v {
			t.Errorf("signed with the %s key: %+v %v", name, got, err)
		}
	}
	if _, err := ParseViewer(both, SignViewer(third, v, vectorExp), now); !errors.Is(err, ErrBadViewer) {
		t.Errorf("signed with neither key: %v", err)
	}
	if _, err := ParseViewer([][]byte{testKey}, SignViewer(next, v, vectorExp), now); !errors.Is(err, ErrBadViewer) {
		t.Errorf("the next key verified while unset: %v", err)
	}
	if _, err := ParseViewer([][]byte{testKey, next[:31]}, SignViewer(testKey, v, vectorExp), now); !errors.Is(err, ErrBadViewer) {
		t.Errorf("a short next key: %v, want nothing accepted", err)
	}
	if _, err := ParseViewer(both, vectorToken[:strings.LastIndex(vectorToken, ".")+1]+"!!", now); !errors.Is(err, ErrBadViewer) {
		t.Errorf("a signature that is not base64url: %v", err)
	}
	if _, err := ParseViewer(nil, vectorToken, now); !errors.Is(err, ErrBadViewer) {
		t.Errorf("no keys: %v", err)
	}
	if KeysUsable([][]byte{testKey, nil}) || !KeysUsable(both) {
		t.Error("KeysUsable: a short key must make the set unusable, two good keys usable")
	}
}
