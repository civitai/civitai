package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-index-go/internal/listingread"
	"github.com/civitai/civitai/apps/app-index-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

var viewerKey = []byte("0123456789abcdef0123456789abcdef")

// listingBody is a store-listing@v1 body as the adapter sends it (entities.ts listingBody).
const paintBody = `{"app":"urn:apps.civitai.com:app/paint","slug":"paint","name":"Paint","kind":"onsite","contentRating":"pg",
"tagline":"Paint things","category":"generation","description":"Long text","iconUrl":"https://img.invalid/paint/icon",
"media":[
 {"slot":"icon","host":"any","url":"https://img.invalid/paint/icon","nsfwLevel":1,"rating":"pg"},
 {"slot":"cover","host":"any","url":"https://img.invalid/paint/cover","nsfwLevel":2,"rating":"pg13"},
 {"slot":"screenshot","host":"any","url":"https://img.invalid/paint/s1","nsfwLevel":1,"rating":"pg","caption":"One","coverUrl":"https://img.invalid/paint/s1-cover"},
 {"slot":"cover","host":"red","url":"https://img.invalid/paint/red-cover","nsfwLevel":2,"rating":"pg13"}],
"creator":{"id":42,"username":"maker","image":null},"isBeta":true,"isOfficial":false,"hasPage":true,
"liveUrl":"https://paint.apps.invalid",
"stats":{"recommendedCount":7,"notRecommendedCount":3,"recommendPct":0.7,"reviewCount":10,"openCount":120,"installCount":4},
"createdAt":"2026-03-04T05:06:07.123Z","updatedAt":"2026-03-05T00:00:00.000Z"}`

const linksBody = `{"app":"urn:apps.civitai.com:app/links","slug":"links","name":"Links","kind":"offsite","contentRating":null,
"tagline":null,"category":"tools","description":null,"iconUrl":null,"media":[],"creator":null,"isBeta":false,"isOfficial":true,
"externalUrl":"https://example.invalid/app",
"stats":{"recommendedCount":0,"notRecommendedCount":0,"recommendPct":null,"reviewCount":0,"openCount":null,"installCount":9},
"createdAt":"2026-03-01T00:00:00.000Z","updatedAt":null}`

const nightBody = `{"app":"urn:apps.civitai.com:app/night","slug":"night","name":"Night","kind":"onsite","contentRating":"r",
"tagline":"After dark","category":"generation","description":"d","iconUrl":null,
"media":[{"slot":"icon","host":"any","url":"https://img.invalid/night/icon","nsfwLevel":4,"rating":"r"}],
"creator":{"id":7,"username":"owl","image":"https://img.invalid/owl"},"isBeta":false,"isOfficial":false,"hasPage":false,
"liveUrl":"https://night.apps.invalid",
"stats":{"recommendedCount":1,"notRecommendedCount":0,"recommendPct":null,"reviewCount":1,"openCount":3,"installCount":0},
"createdAt":"2026-03-02T00:00:00.000Z","updatedAt":"2026-03-02T00:00:00.000Z"}`

func readyListings(t *testing.T, bodies ...string) *store.ListingsMemory {
	t.Helper()
	ctx := t.Context()
	ls := store.NewListingsMemory()
	g, err := ls.NewBuilding(ctx, "s", 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range bodies {
		var id struct{ Slug string }
		_ = json.Unmarshal([]byte(b), &id)
		c, err := store.DecodeListing("urn:apps.civitai.com:store-listing/"+id.Slug, "r", json.RawMessage(b))
		if err != nil {
			t.Fatal(err)
		}
		if err := ls.Apply(ctx, g.ID, c); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := ls.Live(ctx, g.ID, "L"); err != nil {
		t.Fatal(err)
	}
	return ls
}

var testNow = time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

type listingServer struct {
	*httptest.Server
	reads *prometheus.CounterVec
}

func newListingServer(t *testing.T, apps store.Store, ls store.Listings, key []byte) listingServer {
	t.Helper()
	reg := prometheus.NewRegistry()
	s := &Server{Store: apps, Metrics: metrics.New(reg), Gatherer: reg, Log: slog.New(slog.DiscardHandler),
		Listings: ls, ViewerKey: key, Now: func() time.Time { return testNow }}
	if ls != nil {
		s.ListingReads = metrics.NewListingReads(reg)
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return listingServer{srv, s.ListingReads}
}

var (
	sfwViewer  = listingread.Viewer{Scope: listingread.ScopeFull}
	redXViewer = listingread.Viewer{RedCapable: true, BrowsingLevel: 15, Scope: listingread.ScopeFull}
)

// getAs is a GET of u as the viewer v (no viewer header when nil): the status, headers and body.
func getAs(t *testing.T, u string, v *listingread.Viewer) (int, http.Header, []byte) {
	t.Helper()
	token := ""
	if v != nil {
		token = listingread.SignViewer(viewerKey, *v, testNow.Add(time.Minute))
	}
	return getWith(t, u, token)
}

// getWith is a GET of u with the viewer token token (none when empty).
func getWith(t *testing.T, u, token string) (int, http.Header, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, u, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set(listingread.ViewerHeader, token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header, b
}

func sameJSON(t *testing.T, name string, got []byte, want string) {
	t.Helper()
	var a, b any
	if err := json.Unmarshal(got, &a); err != nil {
		t.Fatalf("%s: %v in %s", name, err, got)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatalf("%s: bad want: %v", name, err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Errorf("%s\n got %s\nwant %s", name, got, want)
	}
}

// While the listings read model is off the routes do not exist, and /search is unchanged.
func TestListingRoutesOnlyWhenListingsOn(t *testing.T) {
	srv := newListingServer(t, readyStore(t, app("a", "Apple", "onsite", "generation")), nil, viewerKey)
	for _, p := range []string{"/listings", "/listings/paint"} {
		if code, _, _ := getAs(t, srv.URL+p, &sfwViewer); code != http.StatusNotFound {
			t.Errorf("%s with listings off: %d, want 404", p, code)
		}
	}
	if code, _ := get(t, srv.URL+"/search?q=apple"); code != http.StatusOK {
		t.Errorf("/search: %d", code)
	}
}

func TestListingGatesBeforeAnyRead(t *testing.T) {
	ls := readyListings(t, paintBody)
	// Unconfigured: a short key answers 503 whatever the token.
	short := newListingServer(t, readyStore(t), ls, viewerKey[:31])
	if code, _, b := getAs(t, short.URL+"/listings", &sfwViewer); code != http.StatusServiceUnavailable || !strings.Contains(string(b), "unconfigured") {
		t.Errorf("short key: %d %s", code, b)
	}
	srv := newListingServer(t, readyStore(t), ls, viewerKey)
	for _, p := range []string{"/listings", "/listings/paint"} {
		code, _, b := getAs(t, srv.URL+p, nil)
		if code != http.StatusUnauthorized || !strings.Contains(string(b), "bad_viewer") {
			t.Errorf("%s without a viewer: %d %s", p, code, b)
		}
	}
	other := listingread.SignViewer([]byte("another key of thirty-two bytes!"), redXViewer, testNow.Add(time.Minute))
	if code, _, _ := getWith(t, srv.URL+"/listings", other); code != http.StatusUnauthorized {
		t.Errorf("a token signed with another key: %d", code)
	}
	if v := testutil.ToFloat64(srv.reads.WithLabelValues("list", "bad_viewer")); v != 2 {
		t.Errorf("bad_viewer count %v, want 2", v)
	}
	// Not ready: nothing serving yet.
	notReady := newListingServer(t, readyStore(t), store.NewListingsMemory(), viewerKey)
	if code, _, _ := getAs(t, notReady.URL+"/listings", &sfwViewer); code != http.StatusServiceUnavailable {
		t.Errorf("no serving generation: %d", code)
	}
}

func TestListingCardsAndDetail(t *testing.T) {
	srv := newListingServer(t, readyStore(t), readyListings(t, paintBody, linksBody, nightBody), viewerKey)

	code, hdr, b := getAs(t, srv.URL+"/listings?sort=name", &sfwViewer)
	if code != http.StatusOK || hdr.Get("Cache-Control") != NoStore || hdr.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("list: %d %v", code, hdr)
	}
	// The SFW host: the R listing is not there; the PG listing's PG-13 cover is above its rating,
	// so the cover is its first screenshot's cover rendition.
	sameJSON(t, "SFW grid", b, `{"items":[
 {"slug":"links","kind":"offsite","name":"Links","tagline":null,"category":"tools","contentRating":null,"iconUrl":null,
  "coverUrl":null,"creator":null,"recommend":{"recommendedCount":0,"notRecommendedCount":0,"recommendPct":null},
  "reviewCount":0,"isBeta":false,"isOfficial":true,"openCount":null,"restrictedAudience":null,
  "kindData":{"kind":"offsite","externalUrl":"https://example.invalid/app"}},
 {"slug":"paint","kind":"onsite","name":"Paint","tagline":"Paint things","category":"generation","contentRating":"pg",
  "iconUrl":"https://img.invalid/paint/icon","coverUrl":"https://img.invalid/paint/s1-cover",
  "creator":{"id":42,"username":"maker","image":null},
  "recommend":{"recommendedCount":7,"notRecommendedCount":3,"recommendPct":0.7},"reviewCount":10,
  "isBeta":true,"isOfficial":false,"openCount":120,"updatedAt":"2026-03-05T00:00:00.000Z","restrictedAudience":null,
  "kindData":{"kind":"onsite","hasPage":true,"liveUrl":"https://paint.apps.invalid"}}]}`)

	// A red-host X viewer: the R listing is there too.
	_, _, b = getAs(t, srv.URL+"/listings?sort=name&limit=2", &redXViewer)
	var page struct {
		Items      []struct{ Slug string }
		NextCursor string
	}
	if err := json.Unmarshal(b, &page); err != nil || len(page.Items) != 2 || page.Items[1].Slug != "night" || page.NextCursor == "" {
		t.Fatalf("red page 1: %s", b)
	}
	_, _, b = getAs(t, srv.URL+"/listings?sort=name&limit=2&cursor="+page.NextCursor, &redXViewer)
	page.Items, page.NextCursor = nil, ""
	if err := json.Unmarshal(b, &page); err != nil || len(page.Items) != 1 || page.Items[0].Slug != "paint" || page.NextCursor != "" {
		t.Fatalf("red page 2: %s", b)
	}

	// Detail on the red host: the red cover override (PG-13, within an X viewer's ceiling) wins.
	code, _, b = getAs(t, srv.URL+"/listings/paint", &redXViewer)
	if code != http.StatusOK {
		t.Fatalf("detail: %d %s", code, b)
	}
	sameJSON(t, "red detail", b, `{"slug":"paint","kind":"onsite","name":"Paint","tagline":"Paint things","category":"generation",
  "contentRating":"pg","iconUrl":"https://img.invalid/paint/icon","coverUrl":"https://img.invalid/paint/red-cover",
  "creator":{"id":42,"username":"maker","image":null},
  "recommend":{"recommendedCount":7,"notRecommendedCount":3,"recommendPct":0.7},"reviewCount":10,
  "isBeta":true,"isOfficial":false,"openCount":120,"updatedAt":"2026-03-05T00:00:00.000Z","restrictedAudience":null,
  "kindData":{"kind":"onsite","hasPage":true,"liveUrl":"https://paint.apps.invalid"},
  "description":"Long text","installCount":4,
  "screenshots":[{"url":"https://img.invalid/paint/s1","caption":"One"}]}`)

	// A listing the viewer may not see is a 404, exactly like a missing one.
	for _, c := range []struct {
		path string
		v    listingread.Viewer
		want int
	}{
		{"/listings/night", sfwViewer, http.StatusNotFound},
		{"/listings/night", listingread.Viewer{BrowsingLevel: 31, Scope: listingread.ScopeFull}, http.StatusNotFound},
		{"/listings/night", redXViewer, http.StatusOK},
		{"/listings/paint", listingread.Viewer{Scope: listingread.ScopePublicExternal}, http.StatusNotFound},
		{"/listings/links", listingread.Viewer{Scope: listingread.ScopePublicExternal}, http.StatusOK},
		{"/listings/links", listingread.Viewer{Scope: listingread.ScopeNone}, http.StatusNotFound},
		{"/listings/gone", redXViewer, http.StatusNotFound},
	} {
		if code, _, b := getAs(t, srv.URL+c.path, &c.v); code != c.want {
			t.Errorf("%s as %+v: %d %s, want %d", c.path, c.v, code, b, c.want)
		}
	}
	if v := testutil.ToFloat64(srv.reads.WithLabelValues("detail", "not_found")); v != 5 {
		t.Errorf("detail not_found count %v, want 5", v)
	}
}

func TestListingQueryValidation(t *testing.T) {
	srv := newListingServer(t, readyStore(t), readyListings(t, paintBody), viewerKey)
	for _, q := range []string{
		"kind=teleport", "sort=random", "limit=0", "limit=51", "limit=x", "userId=0", "userId=-3",
		"category=" + strings.Repeat("c", 65), "cursor=" + strings.Repeat("c", 513), "q=" + strings.Repeat("q", 201),
		"q=paint&cursor=abc",
	} {
		if code, _, b := getAs(t, srv.URL+"/listings?"+q, &sfwViewer); code != http.StatusBadRequest {
			t.Errorf("%.40s: %d %s, want 400", q, code, b)
		}
	}
	for _, q := range []string{"kind=all", "kind=onsite", "sort=newest", "limit=50", "userId=42", "category=generation"} {
		if code, _, b := getAs(t, srv.URL+"/listings?"+q, &sfwViewer); code != http.StatusOK {
			t.Errorf("%s: %d %s", q, code, b)
		}
	}
	if code, _, _ := getAs(t, srv.URL+"/listings/"+strings.Repeat("s", 65), &sfwViewer); code != http.StatusBadRequest {
		t.Errorf("a 65-byte slug: %d", code)
	}
}

// A text query is answered through the app index's search, in its order, narrowed to what the
// viewer may see.
func TestListingTextQuery(t *testing.T) {
	apps := readyStore(t, app("paint", "Paint", "onsite", "generation"), app("night", "Night Paint", "onsite", "generation"),
		app("links", "Links", "offsite", "tools"), app("other", "Paint Other", "onsite", "generation"))
	srv := newListingServer(t, apps, readyListings(t, paintBody, linksBody, nightBody), viewerKey)
	slugs := func(b []byte) []string {
		var p struct{ Items []struct{ Slug string } }
		if err := json.Unmarshal(b, &p); err != nil {
			t.Fatal(err)
		}
		out := make([]string, 0, len(p.Items))
		for _, i := range p.Items {
			out = append(out, i.Slug)
		}
		return out
	}
	// "other" is in the index but holds no listing; "night" is R, hidden on the SFW host.
	if _, _, b := getAs(t, srv.URL+"/listings?q=paint", &sfwViewer); !reflect.DeepEqual(slugs(b), []string{"paint"}) {
		t.Errorf("SFW search: %s", b)
	}
	_, _, b := getAs(t, srv.URL+"/listings?q=paint", &redXViewer)
	if got := slugs(b); len(got) != 2 || !strings.Contains(strings.Join(got, ","), "night") {
		t.Errorf("red X search: %s", b)
	}
	if _, _, b := getAs(t, srv.URL+"/listings?q=paint&limit=1", &redXViewer); len(slugs(b)) != 1 || strings.Contains(string(b), "nextCursor") {
		t.Errorf("one page, no cursor: %s", b)
	}
	if _, _, b := getAs(t, srv.URL+"/listings?q=links", &listingread.Viewer{Scope: listingread.ScopePublicExternal}); !reflect.DeepEqual(slugs(b), []string{"links"}) {
		t.Errorf("public-external search: %s", b)
	}
	if _, _, b := getAs(t, srv.URL+"/listings?q=paint", &listingread.Viewer{Scope: listingread.ScopePublicExternal}); len(slugs(b)) != 0 {
		t.Errorf("public-external search for on-site apps: %s", b)
	}
}

// failingListings fails the one read named by fail, with err.
type failingListings struct {
	store.Listings
	fail string
	err  error
}

func (f failingListings) State(ctx context.Context) (store.State, error) {
	if f.fail == "state" {
		return store.State{}, f.err
	}
	return f.Listings.State(ctx)
}

func (f failingListings) Keys(ctx context.Context, gen int64) ([]store.Listing, error) {
	if f.fail == "keys" {
		return nil, f.err
	}
	return f.Listings.Keys(ctx, gen)
}

func (f failingListings) GetMany(ctx context.Context, gen int64, urns []string) ([]store.Listing, error) {
	if f.fail == "many" {
		return nil, f.err
	}
	if f.fail == "deleted" {
		// Every listing of the page deleted between the ranking read and this one.
		return nil, nil
	}
	return f.Listings.GetMany(ctx, gen, urns)
}

func (f failingListings) BySlug(ctx context.Context, gen int64, slug string) (store.Listing, bool, error) {
	if f.fail == "slug" {
		return store.Listing{}, false, f.err
	}
	return f.Listings.BySlug(ctx, gen, slug)
}

// A store failure is a 500, never an empty answer the web tier could take for a real one; a
// generation dropped under the request, or an index not ready, is a 503.
func TestListingStoreFailures(t *testing.T) {
	ls := readyListings(t, paintBody)
	boom := errors.New("boom")
	for _, c := range []struct {
		fail, path string
		err        error
		want       int
	}{
		{"state", "/listings", boom, http.StatusInternalServerError},
		{"keys", "/listings", boom, http.StatusInternalServerError},
		{"keys", "/listings", store.ErrNoGeneration, http.StatusServiceUnavailable},
		{"many", "/listings", boom, http.StatusInternalServerError},
		{"slug", "/listings/paint", boom, http.StatusInternalServerError},
		{"slug", "/listings/paint", store.ErrNoGeneration, http.StatusServiceUnavailable},
	} {
		srv := newListingServer(t, readyStore(t), failingListings{ls, c.fail, c.err}, viewerKey)
		if code, _, b := getAs(t, srv.URL+c.path, &sfwViewer); code != c.want {
			t.Errorf("%s fails with %v on %s: %d %s, want %d", c.fail, c.err, c.path, code, b, c.want)
		}
	}
	// A listing deleted between the two reads is left out, as the site drops an id with no row.
	srv := newListingServer(t, readyStore(t), failingListings{ls, "deleted", nil}, viewerKey)
	if code, _, b := getAs(t, srv.URL+"/listings", &sfwViewer); code != http.StatusOK || string(b) != "{\"items\":[]}\n" {
		t.Errorf("page of deleted listings: %d %q", code, b)
	}
	// The app index not serving yet: a text query is a 503.
	srv = newListingServer(t, store.NewMemory(), ls, viewerKey)
	if code, _, b := getAs(t, srv.URL+"/listings?q=paint", &sfwViewer); code != http.StatusServiceUnavailable {
		t.Errorf("search before the app index is ready: %d %s", code, b)
	}
	// A stored body the card cannot read (a tagline that is not a string) is a 500 on both routes.
	odd := readyListings(t, strings.Replace(paintBody, `"tagline":"Paint things"`, `"tagline":5`, 1))
	srv = newListingServer(t, readyStore(t), odd, viewerKey)
	for _, p := range []string{"/listings", "/listings/paint"} {
		if code, _, b := getAs(t, srv.URL+p, &sfwViewer); code != http.StatusInternalServerError {
			t.Errorf("%s with an unreadable body: %d %s", p, code, b)
		}
	}
}

// With no clock set the real one checks the token, and the search timeout bounds the reads.
func TestListingRealClockAndTimeout(t *testing.T) {
	reg := prometheus.NewRegistry()
	s := &Server{Store: readyStore(t), Metrics: metrics.New(reg), Gatherer: reg, Log: slog.New(slog.DiscardHandler),
		Listings: readyListings(t, paintBody), ViewerKey: viewerKey, SearchTimeout: time.Second}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	if code, _, _ := getWith(t, srv.URL+"/listings/paint", listingread.SignViewer(viewerKey, sfwViewer, time.Now().Add(time.Minute))); code != http.StatusOK {
		t.Fatalf("detail with the real clock: %d", code)
	}
	// A token valid only at testNow is long expired by the real clock.
	if code, _, _ := getAs(t, srv.URL+"/listings/paint", &sfwViewer); code != http.StatusUnauthorized {
		t.Fatalf("a stale token: %d", code)
	}
}
