package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/listingread"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// countingListings counts Keys loads and State reads, and holds every Keys load until release is
// closed (nil: no hold).
type countingListings struct {
	*store.ListingsMemory
	loads   *atomic.Int32
	states  *atomic.Int32
	release chan struct{}
}

func newCounting(ls *store.ListingsMemory, hold bool) countingListings {
	c := countingListings{ListingsMemory: ls, loads: new(atomic.Int32), states: new(atomic.Int32)}
	if hold {
		c.release = make(chan struct{})
	}
	return c
}

func (c countingListings) State(ctx context.Context) (store.State, error) {
	c.states.Add(1)
	return c.ListingsMemory.State(ctx)
}

func (c countingListings) Keys(ctx context.Context, gen int64) ([]store.Listing, error) {
	c.loads.Add(1)
	if c.release != nil {
		select {
		case <-c.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return c.ListingsMemory.Keys(ctx, gen)
}

// upsert applies body to gen with cursor, as the consumer does for one stream event.
func upsert(t *testing.T, ls *store.ListingsMemory, gen int64, slug, body, cursor string) {
	t.Helper()
	c, err := store.DecodeListing("urn:apps.civitai.com:store-listing/"+slug, "r-"+cursor, json.RawMessage(body))
	if err != nil {
		t.Fatal(err)
	}
	c.Cursor = cursor
	if err := ls.Apply(t.Context(), gen, c); err != nil {
		t.Fatal(err)
	}
}

func servingGen(t *testing.T, ls *store.ListingsMemory) int64 {
	t.Helper()
	st, err := ls.State(t.Context())
	if err != nil || st.Serving == nil {
		t.Fatalf("no serving generation: %v", err)
	}
	return st.Serving.ID
}

// Concurrent list requests at one generation and cursor share one Keys load, and later ones read
// the memo: a page costs no scan of every listing.
func TestListingKeysOneLoadForConcurrentRequests(t *testing.T) {
	const n = 8
	c := newCounting(readyListings(t, paintBody, linksBody), true)
	srv := newListingServer(t, readyStore(t), c, viewerKey)
	var wg sync.WaitGroup
	codes := make([]int, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i], _, _ = getAs(t, srv.URL+"/listings", &sfwViewer)
		}()
	}
	// Every request has read State (so is in, or about to join, the one load) before it is let go.
	deadline := time.Now().Add(5 * time.Second)
	for c.states.Load() < n {
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d requests reached the store", c.states.Load(), n)
		}
		time.Sleep(time.Millisecond)
	}
	close(c.release)
	wg.Wait()
	for i, code := range codes {
		if code != http.StatusOK {
			t.Errorf("request %d: %d", i, code)
		}
	}
	if got := c.loads.Load(); got != 1 {
		t.Errorf("%d concurrent requests loaded the keys %d times, want 1", n, got)
	}
	for range 3 {
		if code, _, b := getAs(t, srv.URL+"/listings?sort=name", &sfwViewer); code != http.StatusOK {
			t.Fatalf("a later request: %d %s", code, b)
		}
	}
	if got := c.loads.Load(); got != 1 {
		t.Errorf("after 3 more requests at the same cursor: %d loads, want 1", got)
	}
}

// A committed change moves the cursor, and the next request reads the keys again: a listing added,
// re-rated or removed is ranked from its new row, never from the memo.
func TestListingKeysInvalidatedByCursorAdvance(t *testing.T) {
	ls := readyListings(t, paintBody)
	c := newCounting(ls, false)
	srv := newListingServer(t, readyStore(t), c, viewerKey)
	page := func() string {
		t.Helper()
		code, _, b := getAs(t, srv.URL+"/listings?sort=name", &sfwViewer)
		if code != http.StatusOK {
			t.Fatalf("list: %d %s", code, b)
		}
		return string(b)
	}
	if b := page(); !strings.Contains(b, `"slug":"paint"`) || strings.Contains(b, `"slug":"links"`) {
		t.Fatalf("first page: %s", b)
	}
	gen := servingGen(t, ls)
	upsert(t, ls, gen, "links", linksBody, "C2")
	if b := page(); !strings.Contains(b, `"slug":"links"`) {
		t.Errorf("after an upsert at a new cursor the page lacks it: %s", b)
	}
	if got := c.loads.Load(); got != 2 {
		t.Errorf("loads after one cursor advance: %d, want 2", got)
	}
	// A re-rating the viewer may not see: ranked from the memo, paint would be on the page (and
	// then left out at projection); either way it must not be ranked from the stale key.
	xxx := strings.Replace(paintBody, `"contentRating":"pg","listingContentRating":"pg"`,
		`"contentRating":"xxx","listingContentRating":"xxx"`, 1)
	upsert(t, ls, gen, "paint", xxx, "C3")
	if b := page(); strings.Contains(b, `"slug":"paint"`) {
		t.Errorf("a listing re-rated above the viewer is still listed: %s", b)
	}
	if got := c.loads.Load(); got != 3 {
		t.Errorf("loads after two cursor advances: %d, want 3", got)
	}
}

// A generation switch (a rebuild going live) invalidates the memo, even if the new generation's
// cursor were the old one's.
func TestListingKeysInvalidatedByGenerationSwitch(t *testing.T) {
	ls := readyListings(t, paintBody)
	c := newCounting(ls, false)
	srv := newListingServer(t, readyStore(t), c, viewerKey)
	if code, _, b := getAs(t, srv.URL+"/listings", &sfwViewer); code != http.StatusOK || !strings.Contains(string(b), `"slug":"paint"`) {
		t.Fatalf("before: %d %s", code, b)
	}
	ctx := t.Context()
	g, err := ls.NewBuilding(ctx, "s", 1)
	if err != nil {
		t.Fatal(err)
	}
	upsert(t, ls, g.ID, "links", linksBody, "L")
	// The same cursor as the generation it replaces ("L", readyListings): only the id differs.
	if _, err := ls.Live(ctx, g.ID, "L"); err != nil {
		t.Fatal(err)
	}
	code, _, b := getAs(t, srv.URL+"/listings", &sfwViewer)
	if code != http.StatusOK || strings.Contains(string(b), `"slug":"paint"`) || !strings.Contains(string(b), `"slug":"links"`) {
		t.Errorf("after the switch: %d %s, want links only", code, b)
	}
	if got := c.loads.Load(); got != 2 {
		t.Errorf("loads across a generation switch: %d, want 2", got)
	}
}

// A load the first caller started is not failed by that caller giving up: a request waiting on
// the same load still gets the keys, from that one load.
func TestListingKeysLoadOutlivesItsCaller(t *testing.T) {
	c := newCounting(readyListings(t, paintBody), true)
	srv := newListingServer(t, readyStore(t), c, viewerKey)
	ctx, cancel := context.WithCancel(t.Context())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/listings", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(listingread.ViewerHeader, listingread.SignViewer(viewerKey, sfwViewer, testNow.Add(time.Minute)))
	first := make(chan struct{})
	go func() {
		defer close(first)
		if res, err := http.DefaultClient.Do(req); err == nil {
			_ = res.Body.Close()
		}
	}()
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatal(what)
			}
			time.Sleep(time.Millisecond)
		}
	}
	waitFor("the first request never started a load", func() bool { return c.loads.Load() == 1 })
	type answer struct {
		code int
		body []byte
	}
	second := make(chan answer, 1)
	go func() {
		code, _, b := getAs(t, srv.URL+"/listings", &sfwViewer)
		second <- answer{code, b}
	}()
	waitFor("the second request never reached the store", func() bool { return c.states.Load() == 2 })
	time.Sleep(20 * time.Millisecond) // past State, into the wait on the shared load
	cancel()
	<-first
	close(c.release)
	a := <-second
	if a.code != http.StatusOK || !strings.Contains(string(a.body), `"slug":"paint"`) {
		t.Errorf("the request still waiting after the first left: %d %s", a.code, a.body)
	}
	if got := c.loads.Load(); got != 1 {
		t.Errorf("loads: %d, want 1 (the first caller's, finished for the second)", got)
	}
}
