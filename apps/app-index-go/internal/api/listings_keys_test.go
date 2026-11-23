package api

import (
	"net/http"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/listingread"
)

// Key rotation through the API: with a next key set, a token signed with either key is answered;
// one signed with neither is 401; a next key that is set but short refuses every request (503),
// as a short current key does, rather than being ignored.
func TestListingKeyRotation(t *testing.T) {
	next := []byte("fedcba9876543210fedcba9876543210")
	ls := readyListings(t, paintBody)
	srv := newListingServer(t, readyStore(t), ls, viewerKey)
	srv.s.ViewerKeyNext = next
	sign := func(key []byte) string { return listingread.SignViewer(key, sfwViewer, testNow.Add(time.Minute)) }
	for name, c := range map[string]struct {
		token string
		want  int
	}{
		"current": {sign(viewerKey), http.StatusOK},
		"next":    {sign(next), http.StatusOK},
		"neither": {sign([]byte("another key of thirty-two bytes!")), http.StatusUnauthorized},
	} {
		if code, _, b := getWith(t, srv.URL+"/listings/paint", c.token); code != c.want {
			t.Errorf("signed with %s: %d %s, want %d", name, code, b, c.want)
		}
	}
	srv.s.ViewerKeyNext = next[:31]
	if code, _, b := getWith(t, srv.URL+"/listings/paint", sign(viewerKey)); code != http.StatusServiceUnavailable {
		t.Errorf("a short next key: %d %s, want 503 unconfigured", code, b)
	}
	if v := testutilCount(t, srv, "detail", "unconfigured"); v != 1 {
		t.Errorf("unconfigured count %v", v)
	}
	// Without a next key, a token signed with the would-be next key is refused.
	srv.s.ViewerKeyNext = nil
	if code, _, _ := getWith(t, srv.URL+"/listings/paint", sign(next)); code != http.StatusUnauthorized {
		t.Errorf("next key unset: %d, want 401", code)
	}
}
