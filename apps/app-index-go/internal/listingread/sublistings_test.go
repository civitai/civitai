package listingread

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// Sub-listing ids: asl_ and a 26-character ULID. A2 sorts after A1 by id, so a descending sort puts
// A2 first.
const (
	subA1 = "asl_01J9ZK3Q4R5S6T7V8W9X0YA001"
	subA2 = "asl_01J9ZK3Q4R5S6T7V8W9X0YA002"
	subC1 = "asl_01J9ZK3Q4R5S6T7V8W9X0YC001"
)

func at(day int) *time.Time {
	t := time.Date(2026, 2, day, 0, 0, 0, 0, time.UTC)
	return &t
}

// subCatalog is catalog() with sub-listings: alpha (on-site, PG) holds A1 ("Zed item", own PG) and
// A2 ("Ant item", unrated); charlie (off-site, unrated) holds C1 ("Mid item", own X).
func subCatalog() []store.Listing {
	ks := catalog()
	ks[0].SubListings = []store.SubListing{
		{ID: subA1, Title: "Zed item", ContentRating: "pg", SortTime: at(9)},
		{ID: subA2, Title: "Ant item", SortTime: at(1)},
	}
	ks[2].SubListings = []store.SubListing{{ID: subC1, Title: "Mid item", ContentRating: "x", SortTime: at(5)}}
	return ks
}

// walkCards pages through Rank like walk, naming each card by its listing's slug, or by its id for a
// sub-listing card.
func walkCards(t *testing.T, keys []store.Listing, q ListQuery, v Viewer) []string {
	t.Helper()
	var out []string
	for range 100 {
		p := Rank(keys, q, v)
		if len(p.URNs) != len(p.SubListings) || len(p.URNs) > q.Limit {
			t.Fatalf("page of %d urns and %d sub-listings, limit %d", len(p.URNs), len(p.SubListings), q.Limit)
		}
		for i, u := range p.URNs {
			if p.SubListings[i] != "" {
				out = append(out, p.SubListings[i])
				continue
			}
			out = append(out, strings.TrimPrefix(u, "urn:apps.civitai.com:store-listing/"))
		}
		if p.NextCursor == "" {
			return out
		}
		q.Cursor = p.NextCursor
	}
	t.Fatal("paging never ended")
	return nil
}

var redX = Viewer{RedCapable: true, BrowsingLevel: 15, Scope: ScopeFull}

// The order of listAvailableListings with includeSubListings: (sort key, tb, id), tb 0 for a
// listing and 1 for a sub-listing and ascending in every sort, so a parent comes before its children
// on one key, and so does every other listing on that key; the id breaks what is left, in the sort's
// direction. Each case pages at every limit from 1 to 9, so a page boundary falls on every card,
// sub-listing cards included, and the cursor resumes after it.
func TestRankWithSubListings(t *testing.T) {
	ks := subCatalog()
	newest := subCatalog()
	for i := range newest {
		newest[i].CreatedAt = at(2 + i)
	}
	for _, c := range []struct {
		name string
		keys []store.Listing
		q    ListQuery
		v    Viewer
		want []string
	}{
		// popular: charlie 41; alpha and bravo tie on 40·2 and alpha's items take alpha's key, so the
		// listings on that key (alpha apl_07, bravo apl_06, by id DESC) come before alpha's items (A2,
		// A1, by id DESC). C1 is X: not on a SFW host.
		{"popular, SFW", ks, ListQuery{Sort: SortPopular}, full,
			[]string{"charlie", "alpha", "bravo", subA2, subA1, "foxtrot", "echo"}},
		// A red X viewer sees C1 (on charlie's key, after charlie) and the R and X listings.
		{"popular, red X", ks, ListQuery{Sort: SortPopular}, redX,
			[]string{"delta", "charlie", subC1, "alpha", "bravo", subA2, subA1, "golf", "foxtrot", "echo"}},
		// name: an item by its own title, interleaved with the listings' names.
		{"name", ks, ListQuery{Sort: SortName}, full,
			[]string{"alpha", subA2, "bravo", "charlie", "echo", "foxtrot", subA1}},
		// newest: an item by its own sort time (A1 day 9, C1 day 5, A2 day 1); listings day 2 + i, so
		// C1 ties delta (day 5) and follows it.
		{"newest, red X", newest, ListQuery{Sort: SortNewest}, redX,
			[]string{subA1, "golf", "foxtrot", "echo", "delta", subC1, "charlie", "bravo", "alpha", subA2}},
		// top-rated: an item takes its parent's key (alpha's), so it follows every listing on it.
		{"top-rated", ks, ListQuery{Sort: SortTopRated}, full,
			[]string{"alpha", subA2, subA1, "foxtrot", "bravo", "echo", "charlie"}},
		// The filters apply to the parent: an item follows its parent in and out.
		{"kind off-site, red X", ks, ListQuery{Sort: SortName, Kind: "offsite"}, redX, []string{"charlie", "foxtrot", subC1}},
		{"kind on-site", ks, ListQuery{Sort: SortName, Kind: "onsite"}, full, []string{"alpha", subA2, "bravo", "echo", subA1}},
		{"public-external", ks, ListQuery{Sort: SortName}, Viewer{RedCapable: true, BrowsingLevel: 15, Scope: ScopePublicExternal},
			[]string{"charlie", "foxtrot", subC1}},
		// Without SubListings no item is a row.
		{"no sub-listings", ks, ListQuery{Sort: SortName, SubListings: false}, redX,
			[]string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"}},
	} {
		if c.name != "no sub-listings" {
			c.q.SubListings = true
		}
		for limit := 1; limit <= 9; limit++ {
			c.q.Limit = limit
			got := walkCards(t, c.keys, c.q, c.v)
			if !slices.Equal(got, c.want) {
				t.Errorf("%s, limit %d:\n got %v\nwant %v", c.name, limit, got, c.want)
				break
			}
		}
	}
}

// The developer filter names the parent's creator (al.user_id), as the child arm reads it: an item
// of that developer's app is on the page whoever wrote it.
func TestRankWithSubListingsDeveloperFilter(t *testing.T) {
	ks := subCatalog()
	ks[0].CreatorID = n(7)
	ks[3].CreatorID = n(7)
	got := walkCards(t, ks, ListQuery{Sort: SortName, Limit: 50, UserID: n(7), SubListings: true}, redX)
	if want := []string{"alpha", subA2, "delta", subA1}; !slices.Equal(got, want) {
		t.Fatalf("developer 7: %v, want %v", got, want)
	}
}

// A page that ends on a sub-listing card hands out a cursor on it (the item's key and id), which the
// database reads as tb 1 from the id; the next page resumes after it.
func TestRankCursorAfterASubListingCard(t *testing.T) {
	ks := subCatalog()
	q := ListQuery{Sort: SortPopular, Limit: 4, SubListings: true}
	p := Rank(ks, q, full)
	if !slices.Equal(p.SubListings, []string{"", "", "", subA2}) {
		t.Fatalf("page 1 sub-listings %q, want the 4th card to be A2", p.SubListings)
	}
	c := decodeCursor(p.NextCursor)
	if !c.ok || c.id != subA2 || c.key != popularKey(ks[0]) {
		t.Fatalf("cursor %+v, want A2 at alpha's key", c)
	}
	q.Cursor = p.NextCursor
	got := walkCards(t, ks, q, full)
	if want := []string{subA1, "foxtrot", "echo"}; !slices.Equal(got, want) {
		t.Fatalf("after the A2 cursor: %v, want %v", got, want)
	}
	// The same cursor on the parents-only statement (the flag turned off between two pages): every
	// listing on that key was served before its items, so it resumes strictly after the key, and
	// bravo, on alpha's key, is not served twice.
	q.SubListings = false
	got = walkCards(t, ks, q, full)
	if want := []string{"foxtrot", "echo"}; !slices.Equal(got, want) {
		t.Fatalf("after the A2 cursor, parents only: %v, want %v", got, want)
	}
	// The database cursor format at that position (readModelCursor in the shadow): the id decides tb.
	if c := EncodeCursor(popularKey(ks[0]), subA2, nil); c != p.NextCursor {
		t.Fatalf("cursor %s, want %s", p.NextCursor, c)
	}
}

func TestIsSubListingID(t *testing.T) {
	for id, want := range map[string]bool{
		subA1: true, "apl_01J9ZK3Q4R5S6T7V8W9X0YA001": false, "asl_01J9ZK3Q4R5S6T7V8W9X0YA00": false,
		"asl_01J9ZK3Q4R5S6T7V8W9X0YA0011": false, "asl_01J9ZK3Q4R5S6T7V8W9X0YA00I": false, "": false,
	} {
		if got := store.IsSubListingID(id); got != want {
			t.Errorf("IsSubListingID(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestBySubListingIDs(t *testing.T) {
	ks := subCatalog()
	ks[0].CreatorID = n(7)
	for _, c := range []struct {
		name string
		ids  []string
		kind string
		user *int64
		v    Viewer
		want []string
	}{
		{"given order, unknown and repeated ids dropped", []string{subA1, "asl_01J9ZK3Q4R5S6T7V8W9X0YZ999", subA2, subA1}, "", nil, full, []string{subA1, subA2}},
		{"an X item hidden on a SFW host", []string{subC1, subA2}, "", nil, full, []string{subA2}},
		{"and shown to a red X viewer", []string{subC1, subA2}, "", nil, redX, []string{subC1, subA2}},
		{"the kind filter, on the parent", []string{subC1, subA2}, "offsite", nil, redX, []string{subC1}},
		{"the developer filter, on the parent", []string{subC1, subA2}, "", n(7), redX, []string{subA2}},
		{"scope none", []string{subA2}, "", nil, Viewer{Scope: ScopeNone}, nil},
		{"a listing id is not an item", []string{"apl_07"}, "", nil, full, nil},
	} {
		p := BySubListingIDs(ks, c.ids, c.kind, "", c.user, c.v)
		if !slices.Equal(p.SubListings, c.want) || p.NextCursor != "" {
			t.Errorf("%s: %v, want %v", c.name, p.SubListings, c.want)
		}
		for i, urn := range p.URNs {
			if want := ks[0].URN; p.SubListings[i] != subC1 && urn != want {
				t.Errorf("%s: %s under %s, want %s", c.name, p.SubListings[i], urn, want)
			}
		}
	}
}

// subParent is an on-site PG-13 listing with its own PG icon and PG-13 cover, an R screenshot and a
// PG civitai.red cover override, holding one PG-13 item with its own R image and one external item
// with none.
func subParent(t *testing.T) store.Listing {
	t.Helper()
	body := `{"app":"urn:apps.civitai.com:app/gen","id":"apl_gen","slug":"gen","name":"Gen Hub","kind":"onsite",
"contentRating":"pg13","listingContentRating":"pg13","tagline":null,"category":"generation","creator":{"id":3,"username":"owner","image":null},
"media":[
 {"slot":"icon","host":"any","url":"https://img.invalid/gen/icon-pg","nsfwLevel":1,"rating":"pg"},
 {"slot":"cover","host":"any","url":"https://img.invalid/gen/cover-pg13","nsfwLevel":2,"rating":"pg13"},
 {"slot":"screenshot","host":"any","url":"https://img.invalid/gen/s1-r","nsfwLevel":4,"rating":"r","caption":null,"coverUrl":"https://img.invalid/gen/s1-r-cover"},
 {"slot":"cover","host":"red","url":"https://img.invalid/gen/red-cover-pg","nsfwLevel":1,"rating":"pg"}],
"stats":{"recommendedCount":0,"notRecommendedCount":0,"recommendPct":null,"reviewCount":0,"openCount":0,"installCount":0},
"createdAt":"2026-01-01T00:00:00Z","updatedAt":null,
"subListings":[
 {"id":"` + subA1 + `","title":"Gen Alpha","tagline":"first","contentRating":"pg13","cardContentRating":"pg13",
  "author":{"id":51,"username":"author-a","image":"https://img.invalid/author-a"},"sortTime":"2026-02-01T00:00:00Z",
  "runHref":"/apps/run/gen/g/A?sl=` + subA1 + `","external":false,
  "image":{"url":"https://img.invalid/item-a-r","nsfwLevel":4,"rating":"r"}},
 {"id":"` + subA2 + `","title":"Gen Beta","tagline":null,"contentRating":null,"cardContentRating":"pg13",
  "author":{"id":52,"username":null,"image":null},"sortTime":"2026-02-02T00:00:00Z",
  "runHref":"https://games.invalid/?game=b","external":true,"image":null}]}`
	l, drops, err := store.ListingFromEntity("urn:apps.civitai.com:store-listing/gen", "r", json.RawMessage(body))
	if err != nil || drops != nil {
		t.Fatalf("fixture: %v %+v", err, drops)
	}
	return l
}

// The card, literally, and its one image ceiling (subListingImageCeiling): the viewer's levels cap
// it even off a red-capable host, which a listing's own card (listingMediaCeiling) does not; the
// red host lifts it to the viewer's levels; it never takes the parent's civitai.red override or a
// screenshot as the cover.
func TestProjectSubListingCard(t *testing.T) {
	p := subParent(t)
	a, _ := SubListingOf(p, subA1)
	b, _ := SubListingOf(p, subA2)
	if s, ok := SubListingOf(p, subC1); ok || s.ID != "" {
		t.Fatalf("an item the listing does not hold: %+v %v", s, ok)
	}
	card := func(s store.SubListing, v Viewer) string {
		raw, err := json.Marshal(ProjectSubListingCard(p, s, v))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	// Anonymous, main host: PG only. The PG-13 parent cover is above it (the listing's own card shows
	// it: listingMediaCeiling has no viewer term) and so is the R item image: no cover.
	sameCard(t, "anonymous main", card(a, full), `{"cardType":"sub-listing","id":"`+subA1+`","name":"Gen Alpha","tagline":"first",
"kind":"onsite","category":"generation","contentRating":"pg13","coverUrl":null,
"creator":{"id":51,"username":"author-a","image":"https://img.invalid/author-a"},
"parent":{"id":"apl_gen","slug":"gen","name":"Gen Hub","iconUrl":"https://img.invalid/gen/icon-pg"},
"runHref":"/apps/run/gen/g/A?sl=`+subA1+`"}`)
	if got := ProjectMedia(p, full, false).CoverURL; got == nil || *got != "https://img.invalid/gen/cover-pg13" {
		t.Fatalf("the listing's own card cover %v, want its PG-13 cover: the control for the viewer term", show(got))
	}
	// A PG-13 viewer on the main host: the parent's own cover, never the R item image.
	if got := ProjectSubListingCard(p, a, Viewer{BrowsingLevel: 31, Scope: ScopeFull}).CoverURL; got == nil || *got != "https://img.invalid/gen/cover-pg13" {
		t.Errorf("main host, every level: cover %v, want the parent's own cover", show(got))
	}
	// A red-host R viewer: the item's own R image.
	if got := ProjectSubListingCard(p, a, Viewer{RedCapable: true, BrowsingLevel: 7, Scope: ScopeFull}).CoverURL; got == nil || *got != "https://img.invalid/item-a-r" {
		t.Errorf("red host, R: cover %v, want the item image", show(got))
	}
	// Anonymous on the red host: nothing lifted, the same as the main host; never the PG red override.
	if got := ProjectSubListingCard(p, a, Viewer{RedCapable: true, Scope: ScopeFull}).CoverURL; got != nil {
		t.Errorf("red host, anonymous: cover %v, want none (not the red override)", show(got))
	}
	// An item with no image takes the parent's own cover when visible; an external one says so.
	sameCard(t, "external, PG-13 viewer", card(b, Viewer{BrowsingLevel: 3, Scope: ScopeFull}), `{"cardType":"sub-listing","id":"`+subA2+`",
"name":"Gen Beta","tagline":null,"kind":"onsite","category":"generation","contentRating":"pg13",
"coverUrl":"https://img.invalid/gen/cover-pg13","creator":{"id":52,"username":null,"image":null},
"parent":{"id":"apl_gen","slug":"gen","name":"Gen Hub","iconUrl":"https://img.invalid/gen/icon-pg"},
"runHref":"https://games.invalid/?game=b","external":true}`)
}

func sameCard(t *testing.T, name, got, want string) {
	t.Helper()
	if !jsonEqual(t, json.RawMessage(got), json.RawMessage(want)) {
		t.Errorf("%s\n got %s\nwant %s", name, got, want)
	}
}

// subListingImageCeiling, literally, beside listingMediaCeiling for the same inputs.
func TestSubListingImageCeiling(t *testing.T) {
	for _, c := range []struct {
		v          Viewer
		rating     string
		want, list int64
	}{
		{Viewer{}, "pg13", levelPG, levelPG | levelPG13},
		{Viewer{BrowsingLevel: 31}, "pg13", levelPG | levelPG13, levelPG | levelPG13},
		{Viewer{BrowsingLevel: 31}, "x", levelPG | levelPG13, levelPG | levelPG13},
		{Viewer{BrowsingLevel: 31}, "g", levelPG, levelPG},
		{Viewer{BrowsingLevel: 32}, "pg13", levelPG, levelPG | levelPG13}, // Blocked alone is no level
		{Viewer{RedCapable: true}, "x", levelPG, levelPG | levelPG13},
		{Viewer{RedCapable: true, BrowsingLevel: 5}, "pg", levelPG | levelR, levelPG | levelR},
		{Viewer{RedCapable: true, BrowsingLevel: 63}, "pg13", allLevels, allLevels},
	} {
		if got := subListingImageCeiling(c.v, c.rating); got != c.want {
			t.Errorf("subListingImageCeiling(%+v, %q) = %d, want %d", c.v, c.rating, got, c.want)
		}
		if got := listingMediaCeiling(c.v, c.rating); got != c.list {
			t.Errorf("listingMediaCeiling(%+v, %q) = %d, want %d", c.v, c.rating, got, c.list)
		}
	}
}
