package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// rewritingListings applies one upsert to the serving generation between the ranking read (Keys)
// and the page read (GetMany): what the live consumer does when a listing is re-rated or
// re-kinded while a request is in flight.
type rewritingListings struct {
	*store.ListingsMemory
	t    *testing.T
	body string
}

func (r rewritingListings) GetMany(ctx context.Context, gen int64, urns []string) ([]store.Listing, error) {
	c, err := store.DecodeListing("urn:apps.civitai.com:store-listing/paint", "r2", json.RawMessage(r.body))
	if err != nil {
		r.t.Fatal(err)
	}
	if err := r.Apply(ctx, gen, c); err != nil {
		r.t.Fatal(err)
	}
	return r.ListingsMemory.GetMany(ctx, gen, urns)
}

// The gate is applied to the row that is projected, not only to the row that was ranked: a listing
// re-rated above the viewer, or re-kinded out of the requested kind, between the two reads is left
// out of the page (which may then be short), on the list and on the slug path alike.
func TestListingRegatedAtProjection(t *testing.T) {
	xxx := strings.Replace(paintBody, `"contentRating":"pg","listingContentRating":"pg"`,
		`"contentRating":"xxx","listingContentRating":"xxx"`, 1)
	offsite := strings.Replace(paintBody, `"kind":"onsite"`, `"kind":"offsite"`, 1)
	if xxx == paintBody || offsite == paintBody {
		t.Fatal("the fixture did not change")
	}
	for _, c := range []struct {
		name, body, query string
	}{
		{"re-rated xxx, list", xxx, "/listings"},
		{"re-rated xxx, slugs", xxx, "/listings?slugs=paint"},
		{"re-kinded off-site, list filtered to on-site", offsite, "/listings?kind=onsite"},
		{"re-kinded off-site, slugs filtered to on-site", offsite, "/listings?slugs=paint&kind=onsite"},
	} {
		ls := rewritingListings{readyListings(t, paintBody), t, c.body}
		srv := newListingServer(t, readyStore(t), ls, viewerKey)
		code, _, b := getAs(t, srv.URL+c.query, &sfwViewer)
		if code != http.StatusOK || strings.Contains(string(b), `"slug":"paint"`) {
			t.Errorf("%s: %d %s, want 200 without paint", c.name, code, b)
		}
	}
	// Positive control: a rewrite that changes nothing the gate reads keeps the listing.
	same := strings.Replace(paintBody, `"name":"Paint"`, `"name":"Paint Two"`, 1)
	ls := rewritingListings{readyListings(t, paintBody), t, same}
	srv := newListingServer(t, readyStore(t), ls, viewerKey)
	if code, _, b := getAs(t, srv.URL+"/listings?kind=onsite", &sfwViewer); code != http.StatusOK || !strings.Contains(string(b), `"name":"Paint Two"`) {
		t.Errorf("an ungated rewrite: %d %s, want the listing with its new name", code, b)
	}
}
