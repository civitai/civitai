package index

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-index-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-index-go/internal/registry"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

func listingEntity(slug, name string) map[string]any {
	return map[string]any{
		"urn":     "urn:apps.civitai.com:store-listing/" + slug,
		"schemas": []string{ListingSchema},
		"rev":     "rev-" + name,
		"body": map[string]any{
			"app": "urn:apps.civitai.com:app/" + slug, "id": "apl_" + slug, "slug": slug, "name": name, "kind": "onsite", "contentRating": "pg13", "listingContentRating": "pg13",
			"tagline": nil, "category": "generation", "description": nil, "iconUrl": nil,
			"media": []map[string]any{
				{"slot": "icon", "host": "any", "url": "https://img.invalid/" + slug + "/icon", "nsfwLevel": 1, "rating": "pg"},
				{"slot": "screenshot", "host": "any", "url": "https://img.invalid/" + slug + "/s1", "nsfwLevel": 8, "rating": "x",
					"caption": "above the listing's rating", "coverUrl": "https://img.invalid/" + slug + "/s1-cover"},
				{"slot": "cover", "host": "red", "url": "https://img.invalid/" + slug + "/red-cover", "nsfwLevel": 4, "rating": "r"},
			},
			"creator": map[string]any{"id": 7, "username": "maker", "image": nil},
			"isBeta":  false, "isOfficial": false, "hasPage": true,
			"stats": map[string]any{"recommendedCount": 1, "notRecommendedCount": 0, "recommendPct": 1, "reviewCount": 1,
				"openCount": 3, "installCount": 0},
			"createdAt": "2026-01-02T03:04:05Z", "updatedAt": nil,
			"subListings": []map[string]any{
				{"id": "asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A", "title": name + " item", "tagline": nil, "contentRating": nil,
					"cardContentRating": "pg13", "author": map[string]any{"id": 8, "username": "author", "image": nil},
					"sortTime": "2026-01-03T00:00:00Z", "runHref": "/apps/run/" + slug + "/a?sl=asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A",
					"external": false, "image": nil},
			},
		},
	}
}

// listing sends a snapshot upsert (no cursor) of a listing.
func (c *fakeConn) listing(t *testing.T, slug, name string) {
	t.Helper()
	c.send(t, "upsert", map[string]any{"entity": listingEntity(slug, name), "cursor": ""})
}

func (c *fakeConn) delListing(t *testing.T, slug, cursor string) {
	t.Helper()
	c.send(t, "delete", map[string]any{"urn": "urn:apps.civitai.com:store-listing/" + slug, "cursor": cursor})
}

// listingHarness runs the listings consumer (ListingsConsumer, on) against a fake registry that
// serves the listing schema only.
type listingHarness struct {
	st      store.Listings
	reg     *fakeRegistry
	m       *metrics.Stream
	backoff Backoff

	// holds is how many empty-snapshot holds the test expects so far.
	holds float64

	mu     sync.Mutex
	delays []time.Duration
	cancel context.CancelFunc
	done   chan struct{}
}

func startListings(t *testing.T, st store.Listings) *listingHarness {
	t.Helper()
	h := &listingHarness{st: st, reg: newFakeRegistryFor(t, ListingSchema),
		backoff: Backoff{Base: 100 * time.Millisecond, Max: 1600 * time.Millisecond, Jitter: func() float64 { return 0.5 }}}
	base := Consumer{
		Sub:     ClientSubscriber{Client: &registry.Client{BaseURL: h.reg.srv.URL}},
		Log:     slog.New(slog.DiscardHandler),
		Backoff: h.backoff,
		Sleep: func(ctx context.Context, d time.Duration) error {
			h.mu.Lock()
			h.delays = append(h.delays, d)
			h.mu.Unlock()
			return ctx.Err()
		},
	}
	c, err := ListingsConsumer(t.Context(), true, base, prometheus.NewRegistry(),
		func(context.Context) (store.Listings, error) { return st, nil })
	if err != nil || c == nil {
		t.Fatalf("ListingsConsumer on: %v %v", c, err)
	}
	h.m = c.Metrics
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel, h.done = cancel, make(chan struct{})
	go func() {
		defer close(h.done)
		_ = c.Run(ctx)
	}()
	t.Cleanup(func() { cancel(); <-h.done })
	return h
}

func (h *listingHarness) state(t *testing.T) store.State {
	t.Helper()
	st, err := h.st.State(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return st
}

// servingCursorIs waits until the serving generation stored cursor, failing at once when a
// snapshot the test did not expect to be held was held.
func (h *listingHarness) servingCursorIs(t *testing.T, cursor string) {
	t.Helper()
	eventually(t, "serving cursor "+cursor, func() bool {
		if testutil.ToFloat64(h.m.EmptySnapshots) > h.holds {
			return true
		}
		st, err := h.st.State(context.Background())
		return err == nil && st.Serving != nil && st.Serving.Cursor == cursor
	})
	if got := testutil.ToFloat64(h.m.EmptySnapshots); got > h.holds {
		t.Fatalf("a snapshot with listings was held as empty: empty snapshots = %v, want %v", got, h.holds)
	}
}

func (h *listingHarness) count(t *testing.T, gen int64) int {
	t.Helper()
	n, err := h.st.Count(context.Background(), gen)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func (h *listingHarness) waitDelays() []time.Duration {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]time.Duration(nil), h.delays...)
}

func runListingScenarios(t *testing.T, newStore func(t *testing.T) store.Listings) {
	t.Run("IngestsEveryMediaItem", func(t *testing.T) { testListingIngest(t, newStore(t)) })
	t.Run("EmptySnapshotIsHeld", func(t *testing.T) { testEmptySnapshotIsHeld(t, newStore(t)) })
	t.Run("EmptyFirstSnapshotNeverServes", func(t *testing.T) { testEmptyFirstSnapshotNeverServes(t, newStore(t)) })
	t.Run("UnavailableDeletesNothing", func(t *testing.T) { testUnavailableDeletesNothing(t, newStore(t)) })
	t.Run("DropsKeepTheListing", func(t *testing.T) { testDropsKeepTheListing(t, newStore(t)) })
	t.Run("BodyWithoutSubListingsIsInvalid", func(t *testing.T) { testBodyWithoutSubListingsIsInvalid(t, newStore(t)) })
	t.Run("InvalidWhileServingKeepsTheRow", func(t *testing.T) { testInvalidWhileServingKeepsTheRow(t, newStore(t)) })
	t.Run("InvalidWhileServingFailsClosed", func(t *testing.T) { testInvalidWhileServingFailsClosed(t, newStore(t)) })
	t.Run("OneValidUpsertClearsOnlyItsOwnMark", func(t *testing.T) { testOneValidUpsertClearsOnlyItsOwnMark(t, newStore(t)) })
}

// An adapter rolled back below this layout sends bodies the serving generation cannot use. Each
// such upsert keeps the stored row (the cursor still advances, counted invalid) rather than
// emptying the generation one delete at a time; the row is marked stale, and the API fails closed
// meanwhile (testInvalidWhileServingFailsClosed). A valid upsert and a delete still apply.
func testInvalidWhileServingKeepsTheRow(t *testing.T, st store.Listings) {
	h := startListings(t, st)
	c := h.reg.next(t)
	c.listing(t, "alpha", "Alpha")
	c.listing(t, "beta", "Beta")
	c.live(t, "L1")
	h.servingCursorIs(t, "L1")
	gen := h.state(t).Serving.ID
	for _, slug := range []string{"alpha", "beta"} {
		e := listingEntity(slug, "Renamed")
		delete(e["body"].(map[string]any), "subListings")
		c.send(t, "upsert", map[string]any{"entity": e, "cursor": "c-" + slug})
	}
	h.servingCursorIs(t, "c-beta")
	if n := h.count(t, gen); n != 2 {
		t.Fatalf("count after invalid upserts = %d, want both rows kept", n)
	}
	l, ok, err := st.Get(context.Background(), gen, "urn:apps.civitai.com:store-listing/alpha")
	if err != nil || !ok || l.Name != "Alpha" || len(l.SubListings) != 1 {
		t.Fatalf("alpha after an invalid upsert: %+v %v %v, want the last good row", l, ok, err)
	}
	if got := testutil.ToFloat64(h.m.Applied.WithLabelValues("invalid")); got != 2 {
		t.Fatalf("invalid = %v, want 2", got)
	}
	// Positive control: a valid upsert replaces the row, and a delete removes one.
	e := listingEntity("alpha", "Alpha Two")
	c.send(t, "upsert", map[string]any{"entity": e, "cursor": "c3"})
	c.delListing(t, "beta", "c4")
	h.servingCursorIs(t, "c4")
	l, _, _ = st.Get(context.Background(), gen, "urn:apps.civitai.com:store-listing/alpha")
	if l.Name != "Alpha Two" || h.count(t, gen) != 1 {
		t.Fatalf("after a valid upsert and a delete: %q, %d rows", l.Name, h.count(t, gen))
	}
}

// A body without subListings, from an adapter that does not publish them, is not one this layout can
// use: the entity is invalid (applied as a delete), never stored as a listing with no items, whose
// sub-listing cards the grid would then silently lack.
func testBodyWithoutSubListingsIsInvalid(t *testing.T, st store.Listings) {
	h := startListings(t, st)
	c := h.reg.next(t)
	e := listingEntity("alpha", "Alpha")
	delete(e["body"].(map[string]any), "subListings")
	c.send(t, "upsert", map[string]any{"entity": e, "cursor": ""})
	c.listing(t, "beta", "Beta")
	c.live(t, "L1")
	h.servingCursorIs(t, "L1")
	gen := h.state(t).Serving.ID
	if _, ok, err := st.Get(context.Background(), gen, "urn:apps.civitai.com:store-listing/alpha"); ok || err != nil {
		t.Fatalf("alpha without subListings was stored (err %v)", err)
	}
	if _, ok, err := st.Get(context.Background(), gen, "urn:apps.civitai.com:store-listing/beta"); !ok || err != nil {
		t.Fatalf("beta was not stored: %v", err)
	}
	if got := testutil.ToFloat64(h.m.Applied.WithLabelValues("invalid")); got != 1 {
		t.Fatalf("invalid = %v, want 1", got)
	}
}

// A media item with an unknown slot and a stats counter that is not a count are left out, logged
// and counted; the listing itself is kept (not applied as a delete).
func testDropsKeepTheListing(t *testing.T, st store.Listings) {
	h := startListings(t, st)
	c := h.reg.next(t)
	e := listingEntity("alpha", "Alpha")
	body := e["body"].(map[string]any)
	media := body["media"].([]map[string]any)
	media[1]["slot"] = "banner"
	delete(body["stats"].(map[string]any), "installCount")
	c.send(t, "upsert", map[string]any{"entity": e, "cursor": ""})
	c.listing(t, "beta", "Beta")
	c.live(t, "L1")
	h.servingCursorIs(t, "L1")
	gen := h.state(t).Serving.ID
	l, ok, err := st.Get(context.Background(), gen, "urn:apps.civitai.com:store-listing/alpha")
	if err != nil || !ok {
		t.Fatalf("alpha was not kept: ok %v err %v", ok, err)
	}
	if len(l.Media) != 2 || l.Media[0].Slot != "icon" || l.Media[1].Slot != "cover" || l.Media[1].Position != 2 {
		t.Fatalf("kept media %+v, want the icon and the red cover", l.Media)
	}
	if l.Stats.InstallCount != nil || l.Stats.OpenCount == nil || *l.Stats.OpenCount != 3 {
		t.Fatalf("stats %+v, want installCount null and openCount 3", l.Stats)
	}
	if got := testutil.ToFloat64(h.m.Applied.WithLabelValues("invalid")); got != 0 {
		t.Fatalf("invalid = %v, want 0", got)
	}
	if a, b := testutil.ToFloat64(h.m.Dropped.WithLabelValues("media_item")), testutil.ToFloat64(h.m.Dropped.WithLabelValues("stat")); a != 1 || b != 1 {
		t.Fatalf("dropped media_item %v stat %v, want 1 and 1", a, b)
	}
}

func TestListingScenariosMemory(t *testing.T) {
	runListingScenarios(t, func(*testing.T) store.Listings { return store.NewListingsMemory() })
}

// The listings consumer follows store-listing@v1 into its own store and keeps every media item as
// the stream sent it: the X screenshot of a PG-13 listing and the red-host override included. The
// ceiling is the read API's, per request.
func testListingIngest(t *testing.T, st store.Listings) {
	h := startListings(t, st)
	c := h.reg.next(t)
	if c.cursor != "" {
		t.Fatalf("first start subscribed with cursor %q", c.cursor)
	}
	c.listing(t, "alpha", "Alpha")
	c.listing(t, "beta", "Beta")
	c.live(t, "L1")
	h.servingCursorIs(t, "L1")
	gen := h.state(t).Serving.ID
	l, ok, err := st.Get(context.Background(), gen, "urn:apps.civitai.com:store-listing/alpha")
	if err != nil || !ok {
		t.Fatalf("alpha not stored: %v", err)
	}
	want := []store.ListingMedia{
		{Position: 0, Slot: "icon", Host: "any", URL: "https://img.invalid/alpha/icon", NsfwLevel: 1, Rating: "pg"},
		{Position: 1, Slot: "screenshot", Host: "any", URL: "https://img.invalid/alpha/s1", NsfwLevel: 8, Rating: "x",
			Caption: "above the listing's rating", CoverURL: "https://img.invalid/alpha/s1-cover"},
		{Position: 2, Slot: "cover", Host: "red", URL: "https://img.invalid/alpha/red-cover", NsfwLevel: 4, Rating: "r"},
	}
	if len(l.Media) != len(want) {
		t.Fatalf("media %+v, want %+v", l.Media, want)
	}
	for i := range want {
		if l.Media[i] != want[i] {
			t.Fatalf("media[%d] = %+v, want %+v", i, l.Media[i], want[i])
		}
	}
	if l.ContentRating != "pg13" || l.App != "urn:apps.civitai.com:app/alpha" || *l.CreatorID != 7 || *l.Stats.OpenCount != 3 {
		t.Fatalf("listing columns %+v", l)
	}
	// Its sub-listing, held whole with the body, and by its key fields in Keys.
	if len(l.SubListings) != 1 || l.SubListings[0].ID != "asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A" || l.SubListings[0].Title != "Alpha item" ||
		l.SubListings[0].CardContentRating != "pg13" || l.SubListings[0].RunHref != "/apps/run/alpha/a?sl=asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A" {
		t.Fatalf("sub-listings %+v", l.SubListings)
	}
	keys, err := st.Keys(context.Background(), gen)
	if err != nil || len(keys) != 2 || len(keys[0].SubListings) != 1 || keys[0].SubListings[0].Title != keys[0].Name+" item" ||
		keys[0].SubListings[0].RunHref != "" {
		t.Fatalf("keys %+v %v, want each listing's one sub-listing by its key fields", keys, err)
	}
	c.delListing(t, "beta", "c2")
	h.servingCursorIs(t, "c2")
	if n := h.count(t, gen); n != 1 {
		t.Fatalf("count after a delete = %d, want 1", n)
	}
	if got := testutil.ToFloat64(h.m.Applied.WithLabelValues("upsert")); got != 2 {
		t.Fatalf("app_index_listings upserts = %v, want 2", got)
	}
}

// A rebuild whose snapshot reaches Live with no listing is never switched to: the serving
// generation keeps every row, the hold is counted, and the snapshot is taken again from an empty
// cursor after the longest backoff. A later snapshot with listings switches as usual.
func testEmptySnapshotIsHeld(t *testing.T, st store.Listings) {
	h := startListings(t, st)
	c := h.reg.next(t)
	c.listing(t, "alpha", "Alpha")
	c.listing(t, "beta", "Beta")
	c.live(t, "L1")
	h.servingCursorIs(t, "L1")
	serving := h.state(t).Serving.ID
	c.errorEvent(t, "cursor_expired")

	c = h.reg.next(t)
	if c.cursor != "" {
		t.Fatalf("rebuild subscribed with %q, want none", c.cursor)
	}
	c.live(t, "L2") // a snapshot of zero listings
	eventually(t, "the empty snapshot's Live to be handled", func() bool {
		s := h.state(t)
		return testutil.ToFloat64(h.m.EmptySnapshots) > 0 || s.Serving == nil || s.Serving.ID != serving
	})
	if s := h.state(t); s.Serving == nil || s.Serving.ID != serving {
		t.Fatalf("an empty snapshot replaced the serving generation: serving %+v, want generation %d", s.Serving, serving)
	}

	c = h.reg.next(t)
	if c.cursor != "" {
		t.Fatalf("after a held snapshot subscribed with %q, want none (take it again)", c.cursor)
	}
	if got := testutil.ToFloat64(h.m.EmptySnapshots); got != 1 {
		t.Fatalf("empty snapshots = %v, want 1", got)
	}
	if got := testutil.ToFloat64(h.m.Reconnects.WithLabelValues("empty_snapshot")); got != 1 {
		t.Fatalf("empty_snapshot reconnects = %v, want 1", got)
	}
	st1 := h.state(t)
	if st1.Serving == nil || st1.Serving.ID != serving || st1.Serving.Cursor != "L1" {
		t.Fatalf("serving after a held snapshot = %+v, want generation %d at L1", st1.Serving, serving)
	}
	if n := h.count(t, serving); n != 2 {
		t.Fatalf("serving rows after a held snapshot = %d, want 2", n)
	}
	if d := h.waitDelays(); len(d) != 2 || d[1] < h.backoff.Max/2 {
		t.Fatalf("delays %v: a held snapshot must wait at least %v", d, h.backoff.Max/2)
	}

	h.holds = 1
	c.listing(t, "gamma", "Gamma")
	c.live(t, "L3")
	h.servingCursorIs(t, "L3")
	st2 := h.state(t)
	if st2.Serving.ID == serving || st2.Building != nil {
		t.Fatalf("after a good snapshot: serving %+v building %+v", st2.Serving, st2.Building)
	}
	if n := h.count(t, st2.Serving.ID); n != 1 {
		t.Fatalf("serving rows after the good snapshot = %d, want 1", n)
	}
}

// With nothing serving yet, an empty snapshot is held too: the read model never becomes ready on an
// empty catalog read.
func testEmptyFirstSnapshotNeverServes(t *testing.T, st store.Listings) {
	h := startListings(t, st)
	c := h.reg.next(t)
	c.live(t, "L1")
	eventually(t, "the empty snapshot's Live to be handled", func() bool {
		return testutil.ToFloat64(h.m.EmptySnapshots) > 0 || h.state(t).Serving != nil
	})
	if s := h.state(t); s.Serving != nil {
		t.Fatalf("an empty first snapshot is serving: %+v", s.Serving)
	}
	c = h.reg.next(t)
	if c.cursor != "" {
		t.Fatalf("retake subscribed with %q, want none", c.cursor)
	}
	if got := testutil.ToFloat64(h.m.Ready); got != 0 {
		t.Fatalf("ready = %v after an empty snapshot", got)
	}
	if got := testutil.ToFloat64(h.m.EmptySnapshots); got != 1 {
		t.Fatalf("empty snapshots = %v, want 1", got)
	}
}

// `unavailable` (the adapter's answer when its listing read failed) deletes nothing: the stream is
// opened again from the stored cursor, and every row and the cursor are kept, mid-stream or before
// the stream starts.
func testUnavailableDeletesNothing(t *testing.T, st store.Listings) {
	h := startListings(t, st)
	c := h.reg.next(t)
	c.listing(t, "alpha", "Alpha")
	c.listing(t, "beta", "Beta")
	c.live(t, "L1")
	h.servingCursorIs(t, "L1")
	serving := h.state(t).Serving.ID
	c.errorEvent(t, "unavailable")
	c = h.reg.next(t)
	if c.cursor != "L1" {
		t.Fatalf("after unavailable subscribed with %q, want L1", c.cursor)
	}
	c.fail(http.StatusServiceUnavailable, "unavailable")
	c = h.reg.next(t)
	if c.cursor != "L1" {
		t.Fatalf("after a refused subscribe subscribed with %q, want L1", c.cursor)
	}
	s := h.state(t)
	if s.Serving == nil || s.Serving.ID != serving || s.Serving.Cursor != "L1" || s.Building != nil {
		t.Fatalf("state after unavailable: serving %+v building %+v", s.Serving, s.Building)
	}
	if n := h.count(t, serving); n != 2 {
		t.Fatalf("rows after unavailable = %d, want 2", n)
	}
	if got := testutil.ToFloat64(h.m.Reconnects.WithLabelValues("unavailable")); got != 2 {
		t.Fatalf("unavailable reconnects = %v, want 2", got)
	}
	if got := testutil.ToFloat64(h.m.Rebuilds.WithLabelValues("cursor_expired")); got != 0 {
		t.Fatalf("unavailable started a rebuild: %v", got)
	}
}

// Off (APP_INDEX_LISTINGS unset), there is no listings consumer: its store is never opened (no
// table is created or written), no app_index_listings_* series exists, and nothing subscribes to
// the listing schema. On is the positive control: each of those moves.
func TestListingsConsumerOnlyWhenOn(t *testing.T) {
	reg := newFakeRegistryFor(t, ListingSchema)
	base := Consumer{Sub: ClientSubscriber{Client: &registry.Client{BaseURL: reg.srv.URL}}, Log: slog.New(slog.DiscardHandler),
		Backoff: Backoff{Base: time.Millisecond, Max: time.Millisecond}}
	for _, on := range []bool{false, true} {
		opened := 0
		pr := prometheus.NewRegistry()
		c, err := ListingsConsumer(t.Context(), on, base, pr, func(context.Context) (store.Listings, error) {
			opened++
			return store.NewListingsMemory(), nil
		})
		if err != nil {
			t.Fatal(err)
		}
		families, err := pr.Gather()
		if err != nil {
			t.Fatal(err)
		}
		series := 0
		for _, f := range families {
			if strings.HasPrefix(f.GetName(), "app_index_listings_") {
				series++
			}
		}
		if !on {
			if c != nil || opened != 0 || series != 0 || reg.subscribed(ListingSchema) != 0 {
				t.Fatalf("off: consumer %v, store opened %d times, %d listing series, %d subscriptions; want none",
					c, opened, series, reg.subscribed(ListingSchema))
			}
			continue
		}
		// 10: the stream's 7, empty snapshots, dropped, and stale rows.
		if c == nil || opened != 1 || series != 10 {
			t.Fatalf("on: consumer %v, store opened %d times, %d listing series; want one, 1, 10", c, opened, series)
		}
		if c.Schema != "urn:schema:apps.civitai.com:store-listing@v1" || c.Layout != 4 || c.Count == nil || c.Decode == nil ||
			c.StaleCount == nil || !c.KeepInvalidWhileServing {
			t.Fatalf("on: schema %q layout %d count %v decode %v stale count %v keep invalid %v", c.Schema, c.Layout,
				c.Count != nil, c.Decode != nil, c.StaleCount != nil, c.KeepInvalidWhileServing)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { defer close(done); _ = c.Run(ctx) }()
		reg.next(t).drop()
		cancel()
		<-done
	}
	if n := reg.subscribed(ListingSchema); n < 1 {
		t.Fatalf("listing subscriptions = %d, want at least 1 (the on case)", n)
	}
}

// A store that cannot be opened fails the start, rather than running without the listings it was
// asked for.
func TestListingsConsumerStoreError(t *testing.T) {
	boom := errors.New("boom")
	_, err := ListingsConsumer(t.Context(), true, Consumer{}, prometheus.NewRegistry(),
		func(context.Context) (store.Listings, error) { return nil, boom })
	if !errors.Is(err, boom) {
		t.Fatalf("err %v, want boom", err)
	}
}
