package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// switchingListings switches to a new generation right after the request's first read (Keys), so
// the reads after it hit a generation that no longer exists: what a rebuild landing mid-request
// does.
type switchingListings struct {
	*store.ListingsMemory
	t *testing.T
}

func (s switchingListings) Keys(ctx context.Context, gen int64) ([]store.Listing, error) {
	keys, err := s.ListingsMemory.Keys(ctx, gen)
	g, berr := s.NewBuilding(ctx, "s", 1)
	if berr != nil {
		s.t.Fatal(berr)
	}
	c, derr := store.DecodeListing("urn:apps.civitai.com:store-listing/links", "r2", json.RawMessage(linksBody))
	if derr != nil {
		s.t.Fatal(derr)
	}
	if aerr := s.Apply(ctx, g.ID, c); aerr != nil {
		s.t.Fatal(aerr)
	}
	if _, lerr := s.Live(ctx, g.ID, "L2"); lerr != nil {
		s.t.Fatal(lerr)
	}
	return keys, err
}

// A read that races a generation switch is a 503, never a 200 with an empty or short page.
func TestListingGenerationSwitchMidRequest(t *testing.T) {
	ls := switchingListings{readyListings(t, paintBody), t}
	srv := newListingServer(t, readyStore(t), ls, viewerKey)
	if code, _, b := getAs(t, srv.URL+"/listings", &sfwViewer); code != http.StatusServiceUnavailable {
		t.Fatalf("a page read across a switch: %d %s, want 503", code, b)
	}
	if v := testutilCount(t, srv, "list", "not_ready"); v != 1 {
		t.Errorf("not_ready count %v", v)
	}
	// The next request reads the new generation whole.
	srv2 := newListingServer(t, readyStore(t), ls.ListingsMemory, viewerKey)
	if code, _, b := getAs(t, srv2.URL+"/listings?slugs=links", &sfwViewer); code != http.StatusOK {
		t.Fatalf("after the switch: %d %s", code, b)
	}
}

// A serving generation built with another row layout is not answered from until the rebuild
// beside it switches over: its rows may lack what the gates read.
func TestListingOtherLayoutNotServed(t *testing.T) {
	ls := readyListings(t, paintBody) // built with layout 1
	for _, c := range []struct {
		layout int
		want   int
	}{{2, http.StatusServiceUnavailable}, {1, http.StatusOK}, {0, http.StatusOK}} {
		srv := newListingServer(t, readyStore(t), ls, viewerKey)
		srv.setLayout(c.layout)
		if code, _, b := getAs(t, srv.URL+"/listings/paint", &sfwViewer); code != c.want {
			t.Errorf("serving layout 1, expected %d: %d %s, want %d", c.layout, code, b, c.want)
		}
	}
}
