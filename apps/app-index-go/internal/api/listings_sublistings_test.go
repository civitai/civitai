package api

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/listingread"
	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// Sub-listing ids of hubBody: asl_ and a 26-character ULID.
const (
	subCanvas = "asl_01J9ZK3Q4R5S6T7V8W9X0YH001"
	subNight  = "asl_01J9ZK3Q4R5S6T7V8W9X0YH002"
	subZine   = "asl_01J9ZK3Q4R5S6T7V8W9X0YH003"
)

// hubBody is an on-site PG listing with its own PG icon and PG-13 cover and three sub-listings:
// "Canvas set" (PG, its own PG-13 image), "Night pack" (rated X, no image) and "Zine" (unrated,
// external).
const hubBody = `{"app":"urn:apps.civitai.com:app/hub","id":"apl_hub_4","slug":"hub","name":"Hub","kind":"onsite","contentRating":"pg","listingContentRating":"pg",
"tagline":"A hub","category":"generation","description":null,"iconUrl":null,
"media":[
 {"slot":"icon","host":"any","url":"https://img.invalid/hub/icon","nsfwLevel":1,"rating":"pg"},
 {"slot":"cover","host":"any","url":"https://img.invalid/hub/cover","nsfwLevel":2,"rating":"pg13"}],
"creator":{"id":77,"username":"hubber","image":null},"isBeta":false,"isOfficial":false,"hasPage":true,
"liveUrl":"https://hub.apps.invalid","appBlockId":"ab_hub_1",
"stats":{"recommendedCount":0,"notRecommendedCount":0,"recommendPct":null,"reviewCount":0,"openCount":5,"installCount":1},
"createdAt":"2026-03-03T00:00:00.000Z","updatedAt":null,
"subListings":[
 {"id":"` + subCanvas + `","title":"Canvas set","tagline":"Ready canvases","contentRating":"pg","cardContentRating":"pg",
  "author":{"id":501,"username":"painter","image":"https://img.invalid/painter"},"sortTime":"2026-03-08T00:00:00.000Z",
  "runHref":"/apps/run/hub/canvas?sl=` + subCanvas + `","external":false,
  "image":{"url":"https://img.invalid/hub/canvas-pg13","nsfwLevel":2,"rating":"pg13"}},
 {"id":"` + subNight + `","title":"Night pack","tagline":null,"contentRating":"x","cardContentRating":"x",
  "author":{"id":502,"username":"owl","image":null},"sortTime":"2026-03-09T00:00:00.000Z",
  "runHref":"/apps/run/hub/night?sl=` + subNight + `","external":false,"image":null},
 {"id":"` + subZine + `","title":"Zine","tagline":null,"contentRating":null,"cardContentRating":"pg",
  "author":{"id":503,"username":null,"image":null},"sortTime":"2026-03-07T00:00:00.000Z",
  "runHref":"https://zines.invalid/z/1","external":true,"image":null}]}`

// cardNames names each card of a GET /listings answer: a listing by its slug, a sub-listing by its id.
func cardNames(t *testing.T, b []byte) ([]string, string, bool) {
	t.Helper()
	var p struct {
		Items []struct {
			CardType string `json:"cardType"`
			ID       string `json:"id"`
			Slug     string `json:"slug"`
		} `json:"items"`
		NextCursor  string `json:"nextCursor"`
		SubListings bool   `json:"subListings"`
	}
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatalf("%v in %s", err, b)
	}
	out := []string{}
	for _, i := range p.Items {
		if i.CardType == "sub-listing" {
			out = append(out, i.ID)
		} else {
			out = append(out, i.Slug)
		}
	}
	return out, p.NextCursor, p.SubListings
}

// With subListings=1 the page mixes the sub-listing cards in, in the grid's order, gated per viewer,
// and says so; without it there are none, and it says nothing.
func TestListingSubListingsOnThePage(t *testing.T) {
	srv := newListingServer(t, readyStore(t), readyListings(t, hubBody, paintBody, linksBody), viewerKey)
	for _, c := range []struct {
		name, query string
		v           listingread.Viewer
		want        []string
		marked      bool
	}{
		// name: each item by its own title, among the listings' names. Night pack is X.
		{"name, SFW", "sort=name&subListings=1", sfwViewer, []string{subCanvas, "hub", "links", "paint", subZine}, true},
		{"name, red X", "sort=name&subListings=1", redXViewer, []string{subCanvas, "hub", "links", subNight, "paint", subZine}, true},
		// popular: an item takes its parent's key, after every listing on it, then by id DESC.
		{"popular, SFW", "sort=popular&subListings=1", sfwViewer, []string{"paint", "links", "hub", subZine, subCanvas}, true},
		{"the kind filter, on the parent", "sort=name&subListings=1&kind=offsite", redXViewer, []string{"links"}, true},
		{"the developer filter, on the parent", "sort=name&subListings=1&userId=77", sfwViewer, []string{subCanvas, "hub", subZine}, true},
		{"without subListings", "sort=name", redXViewer, []string{"hub", "links", "paint"}, false},
	} {
		code, _, b := getAs(t, srv.URL+"/listings?"+c.query, &c.v)
		got, _, marked := cardNames(t, b)
		if code != http.StatusOK || !reflect.DeepEqual(got, c.want) || marked != c.marked {
			t.Errorf("%s: %d %v (marked %v), want %v (marked %v)", c.name, code, got, marked, c.want, c.marked)
		}
	}
	// One page per card: every page boundary, sub-listing cards included, resumes after its card.
	var walked []string
	cursor := ""
	for range 10 {
		q := "/listings?sort=name&subListings=1&limit=1"
		if cursor != "" {
			q += "&cursor=" + cursor
		}
		_, _, b := getAs(t, srv.URL+q, &redXViewer)
		names, next, _ := cardNames(t, b)
		walked = append(walked, names...)
		if cursor = next; cursor == "" {
			break
		}
	}
	if want := []string{subCanvas, "hub", "links", subNight, "paint", subZine}; !reflect.DeepEqual(walked, want) {
		t.Errorf("walked one card a page: %v, want %v", walked, want)
	}
	// The cards, literally: the sub-listing card's image is gated at its own ceiling (a SFW viewer is
	// PG only, so its PG-13 image and the parent's PG-13 cover are both above it).
	_, _, b := getAs(t, srv.URL+"/listings?sort=name&subListings=1&limit=2", &sfwViewer)
	var page struct {
		Items       []json.RawMessage `json:"items"`
		NextCursor  string            `json:"nextCursor"`
		SubListings bool              `json:"subListings"`
	}
	if err := json.Unmarshal(b, &page); err != nil || len(page.Items) != 2 || page.NextCursor == "" || !page.SubListings {
		t.Fatalf("page: %v %s", err, b)
	}
	sameJSON(t, "canvas card, SFW", page.Items[0], `{"cardType":"sub-listing","id":"`+subCanvas+`","name":"Canvas set",
"tagline":"Ready canvases","kind":"onsite","category":"generation","contentRating":"pg","coverUrl":null,
"creator":{"id":501,"username":"painter","image":"https://img.invalid/painter"},
"parent":{"id":"apl_hub_4","slug":"hub","name":"Hub","iconUrl":"https://img.invalid/hub/icon"},
"runHref":"/apps/run/hub/canvas?sl=`+subCanvas+`"}`)
	// A red-host R viewer sees its PG-13 image; the external item says it is external.
	_, _, b = getAs(t, srv.URL+"/listings?sort=name&subListings=1", &listingread.Viewer{RedCapable: true, BrowsingLevel: 7, Scope: listingread.ScopeFull})
	if !strings.Contains(string(b), `"coverUrl":"https://img.invalid/hub/canvas-pg13"`) ||
		!strings.Contains(string(b), `"runHref":"https://zines.invalid/z/1","external":true`) {
		t.Errorf("red R page: %s", b)
	}
}

// A listing whose stream left items out past the adapter's cap is named on every subListingIds
// answer that could have found it (cappedListings), and only there: the web tier's shadow then reads
// an item of it that is not found as a known cap difference.
func TestListingSubListingIDsNameCappedListings(t *testing.T) {
	capped := strings.Replace(hubBody, `"createdAt":"2026-03-03T00:00:00.000Z"`, `"subListingsOmitted":4,"createdAt":"2026-03-03T00:00:00.000Z"`, 1)
	if capped == hubBody {
		t.Fatal("the fixture did not change")
	}
	srv := newListingServer(t, readyStore(t), readyListings(t, capped, paintBody, linksBody), viewerKey)
	names := func(query string) []string {
		_, _, b := getAs(t, srv.URL+"/listings?"+query, &sfwViewer)
		var p struct {
			CappedListings []string `json:"cappedListings"`
		}
		if err := json.Unmarshal(b, &p); err != nil {
			t.Fatal(err)
		}
		return p.CappedListings
	}
	if got := names("subListingIds=asl_01J9ZK3Q4R5S6T7V8W9X0YH999"); !reflect.DeepEqual(got, []string{"apl_hub_4"}) {
		t.Errorf("by id: capped %v, want the hub", got)
	}
	// Not a listing this viewer could find with these filters: not named.
	if got := names("subListingIds=" + subCanvas + "&kind=offsite"); got != nil {
		t.Errorf("off-site filter: capped %v, want none", got)
	}
	// Not on a page answer.
	if got := names("sort=name&subListings=1"); got != nil {
		t.Errorf("page: capped %v, want none", got)
	}
}

// Sub-listing hydration: the cards of the named items this viewer could find in the grid with
// sub-listings on, in the given order, each once, with the kind, category and developer filters.
func TestListingSubListingIDs(t *testing.T) {
	srv := newListingServer(t, readyStore(t), readyListings(t, hubBody, paintBody, linksBody), viewerKey)
	for _, c := range []struct {
		name, query string
		v           listingread.Viewer
		want        []string
	}{
		{"given order, unknown and repeated ids dropped", "subListingIds=" + subZine + ",asl_01J9ZK3Q4R5S6T7V8W9X0YZ999," + subCanvas + "," + subZine,
			sfwViewer, []string{subZine, subCanvas}},
		{"the X item hidden on the SFW host", "subListingIds=" + subNight + "," + subCanvas, sfwViewer, []string{subCanvas}},
		{"and shown to a red X viewer", "subListingIds=" + subNight + "," + subCanvas, redXViewer, []string{subNight, subCanvas}},
		{"the kind filter", "subListingIds=" + subCanvas + "&kind=offsite", sfwViewer, []string{}},
		{"the category filter", "subListingIds=" + subCanvas + "&category=generation", sfwViewer, []string{subCanvas}},
		{"the developer filter names the parent's creator", "subListingIds=" + subCanvas + "&userId=77", sfwViewer, []string{subCanvas}},
		{"another developer", "subListingIds=" + subCanvas + "&userId=42", sfwViewer, []string{}},
		{"public-external is off-site only", "subListingIds=" + subCanvas, listingread.Viewer{Scope: listingread.ScopePublicExternal}, []string{}},
		{"a listing id is not an item", "subListingIds=apl_hub_4", sfwViewer, []string{}},
		{"an empty list", "subListingIds=", sfwViewer, []string{}},
	} {
		code, _, b := getAs(t, srv.URL+"/listings?"+c.query, &c.v)
		got, next, marked := cardNames(t, b)
		if code != http.StatusOK || !reflect.DeepEqual(got, c.want) || next != "" || !marked {
			t.Errorf("%s: %d %s, want %v", c.name, code, b, c.want)
		}
	}
	// The cards are the page's cards.
	_, _, one := getAs(t, srv.URL+"/listings?subListingIds="+subCanvas, &sfwViewer)
	_, _, page := getAs(t, srv.URL+"/listings?sort=name&subListings=1&limit=1", &sfwViewer)
	var a, b struct {
		Items []json.RawMessage `json:"items"`
	}
	if json.Unmarshal(one, &a) != nil || json.Unmarshal(page, &b) != nil || len(a.Items) != 1 || len(b.Items) != 1 || string(a.Items[0]) != string(b.Items[0]) {
		t.Errorf("hydrated card differs from the page's:\n%s\n%s", one, page)
	}
}

func TestListingSubListingQueryValidation(t *testing.T) {
	srv := newListingServer(t, readyStore(t), readyListings(t, hubBody), viewerKey)
	for _, q := range []string{
		"subListings=2", "subListings=true", "subListings=0",
		"slugs=hub&subListingIds=" + subCanvas, "slugs=hub&subListings=1",
		"subListingIds=" + subCanvas + "&cursor=abc", "subListingIds=" + strings.Repeat("s", 65),
		"subListingIds=" + strings.TrimSuffix(strings.Repeat(subCanvas+",", 51), ","),
	} {
		if code, _, b := getAs(t, srv.URL+"/listings?"+q, &sfwViewer); code != http.StatusBadRequest {
			t.Errorf("%.60s: %d %s, want 400", q, code, b)
		}
	}
	for _, q := range []string{"subListings=1", "subListings=", "subListingIds=" + subCanvas + "&userId=3", "subListingIds=" + subCanvas + "&sort=name&limit=1"} {
		if code, _, b := getAs(t, srv.URL+"/listings?"+q, &sfwViewer); code != http.StatusOK {
			t.Errorf("%s: %d %s", q, code, b)
		}
	}
}

// rewritingHub applies one upsert of the hub listing between the ranking read (Keys) and the page
// read (GetMany): an item re-rated or withdrawn while a request is in flight.
type rewritingHub struct {
	*store.ListingsMemory
	t    *testing.T
	body string
}

func (r rewritingHub) GetMany(ctx context.Context, gen int64, urns []string) ([]store.Listing, error) {
	c, err := store.DecodeListing("urn:apps.civitai.com:store-listing/hub", "r2", json.RawMessage(r.body))
	if err != nil {
		r.t.Fatal(err)
	}
	if err := r.Apply(ctx, gen, c); err != nil {
		r.t.Fatal(err)
	}
	return r.ListingsMemory.GetMany(ctx, gen, urns)
}

// The item's gate is applied to the item that is projected: one re-rated above the viewer, or gone
// from its listing, between the two reads is left out of the page, on both paths.
func TestListingSubListingRegatedAtProjection(t *testing.T) {
	rerated := strings.Replace(hubBody, `"contentRating":"pg","cardContentRating":"pg"`, `"contentRating":"r","cardContentRating":"r"`, 1)
	gone := strings.Replace(hubBody, `"id":"`+subCanvas+`"`, `"id":"asl_01J9ZK3Q4R5S6T7V8W9X0YH009"`, 1)
	if rerated == hubBody || gone == hubBody {
		t.Fatal("the fixture did not change")
	}
	for _, c := range []struct{ name, body, query string }{
		{"re-rated, page", rerated, "/listings?sort=name&subListings=1"},
		{"re-rated, ids", rerated, "/listings?subListingIds=" + subCanvas},
		{"gone, page", gone, "/listings?sort=name&subListings=1"},
		{"gone, ids", gone, "/listings?subListingIds=" + subCanvas},
	} {
		srv := newListingServer(t, readyStore(t), rewritingHub{readyListings(t, hubBody), t, c.body}, viewerKey)
		code, _, b := getAs(t, srv.URL+c.query, &sfwViewer)
		if code != http.StatusOK || strings.Contains(string(b), subCanvas) {
			t.Errorf("%s: %d %s, want 200 without %s", c.name, code, b, subCanvas)
		}
	}
	// Positive control: a rewrite the gate does not read keeps the item.
	same := strings.Replace(hubBody, `"title":"Canvas set"`, `"title":"Canvas set two"`, 1)
	srv := newListingServer(t, readyStore(t), rewritingHub{readyListings(t, hubBody), t, same}, viewerKey)
	if _, _, b := getAs(t, srv.URL+"/listings?subListingIds="+subCanvas, &sfwViewer); !strings.Contains(string(b), `"name":"Canvas set two"`) {
		t.Errorf("an ungated rewrite: %s, want the item with its new title", b)
	}
}
