package index

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-index-go/internal/api"
	"github.com/civitai/civitai/apps/app-index-go/internal/listingread"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

var staleViewerKey = []byte("0123456789abcdef0123456789abcdef")

// listingsStatus is what GET /listings answers over st: a listing API of its own, as another
// process (or this one after a restart) would serve it from the same store.
func listingsStatus(t *testing.T, st store.Listings) (int, string) {
	t.Helper()
	reg := prometheus.NewRegistry()
	s := &api.Server{Listings: st, ViewerKey: staleViewerKey, Gatherer: reg, Log: slog.New(slog.DiscardHandler)}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+"/listings", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(listingread.ViewerHeader, listingread.SignViewer(staleViewerKey,
		listingread.Viewer{Scope: listingread.ScopeFull}, time.Now().Add(time.Minute)))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// staleGaugeIs waits until the consumer's stale row gauge reads want: it is set after the change's
// commit, so the stored cursor can be seen before it.
func (h *listingHarness) staleGaugeIs(t *testing.T, want float64) {
	t.Helper()
	eventually(t, fmt.Sprintf("app_index_listings_stale_rows %v", want), func() bool {
		return testutil.ToFloat64(h.m.Stale) == want
	})
}

func wantListingsStatus(t *testing.T, st store.Listings, what string, want int) {
	t.Helper()
	if code, body := listingsStatus(t, st); code != want {
		t.Fatalf("GET /listings %s: %d %s, want %d", what, code, body, want)
	}
}

// invalidListing sends an upsert of slug whose body this layout cannot use (no subListings).
func (c *fakeConn) invalidListing(t *testing.T, slug, cursor string) {
	t.Helper()
	e := listingEntity(slug, "Renamed")
	delete(e["body"].(map[string]any), "subListings")
	c.send(t, "upsert", map[string]any{"entity": e, "cursor": cursor})
}

// An upsert the serving generation cannot use keeps its last good row, but that row may be the
// very change the upsert carried (re-rated, a sub-listing rejected, the author banned), so the read
// API fails closed: 503 not_ready, the answer the web tier reads from the database on, while the
// serving generation holds any such row. A valid upsert or a delete of that URN ends it. An unusable
// upsert of a URN the generation does not hold keeps nothing, so nothing is stale.
func testInvalidWhileServingFailsClosed(t *testing.T, st store.Listings) {
	h := startListings(t, st)
	c := h.reg.next(t)
	c.listing(t, "alpha", "Alpha")
	c.listing(t, "beta", "Beta")
	c.live(t, "L1")
	h.servingCursorIs(t, "L1")
	gen := h.state(t).Serving.ID
	wantListingsStatus(t, st, "while serving", http.StatusOK)

	c.invalidListing(t, "alpha", "c1")
	h.servingCursorIs(t, "c1")
	if code, body := listingsStatus(t, st); code != http.StatusServiceUnavailable || body != "{\"error\":\"not_ready\"}\n" {
		t.Fatalf("GET /listings with a stale row: %d %q, want 503 not_ready", code, body)
	}
	if l, ok, err := st.Get(t.Context(), gen, "urn:apps.civitai.com:store-listing/alpha"); err != nil || !ok || l.Name != "Alpha" {
		t.Fatalf("alpha after an invalid upsert: %+v %v %v, want the last good row kept", l, ok, err)
	}
	if n, err := st.StaleCount(t.Context(), gen); err != nil || n != 1 {
		t.Fatalf("stale count = %d %v, want 1", n, err)
	}
	h.staleGaugeIs(t, 1)

	c.send(t, "upsert", map[string]any{"entity": listingEntity("alpha", "Alpha Two"), "cursor": "c2"})
	h.servingCursorIs(t, "c2")
	wantListingsStatus(t, st, "after a valid upsert of the stale listing", http.StatusOK)
	h.staleGaugeIs(t, 0)

	c.invalidListing(t, "beta", "c3")
	h.servingCursorIs(t, "c3")
	wantListingsStatus(t, st, "with beta stale", http.StatusServiceUnavailable)
	h.staleGaugeIs(t, 1)
	c.delListing(t, "beta", "c4")
	h.servingCursorIs(t, "c4")
	wantListingsStatus(t, st, "after a delete of the stale listing", http.StatusOK)
	h.staleGaugeIs(t, 0)
	if n := h.count(t, gen); n != 1 {
		t.Fatalf("count = %d, want alpha only", n)
	}

	c.invalidListing(t, "gamma", "c5")
	h.servingCursorIs(t, "c5")
	wantListingsStatus(t, st, "after an invalid upsert of a listing never held", http.StatusOK)
}

// Two stale rows: a valid upsert of one ends only its own mark, so the API still answers 503 with
// one left; a valid upsert of the second brings it back.
func testOneValidUpsertClearsOnlyItsOwnMark(t *testing.T, st store.Listings) {
	h := startListings(t, st)
	c := h.reg.next(t)
	c.listing(t, "alpha", "Alpha")
	c.listing(t, "beta", "Beta")
	c.live(t, "L1")
	h.servingCursorIs(t, "L1")
	gen := h.state(t).Serving.ID
	c.invalidListing(t, "alpha", "c1")
	c.invalidListing(t, "beta", "c2")
	h.servingCursorIs(t, "c2")
	h.staleGaugeIs(t, 2)

	c.send(t, "upsert", map[string]any{"entity": listingEntity("alpha", "Alpha Two"), "cursor": "c3"})
	h.servingCursorIs(t, "c3")
	if n, err := st.StaleCount(t.Context(), gen); err != nil || n != 1 {
		t.Fatalf("stale count after a valid upsert of one of two = %d %v, want 1", n, err)
	}
	h.staleGaugeIs(t, 1)
	wantListingsStatus(t, st, "with one of two stale rows cleared", http.StatusServiceUnavailable)

	c.send(t, "upsert", map[string]any{"entity": listingEntity("beta", "Beta Two"), "cursor": "c4"})
	h.servingCursorIs(t, "c4")
	h.staleGaugeIs(t, 0)
	wantListingsStatus(t, st, "with both stale rows cleared", http.StatusOK)
}
