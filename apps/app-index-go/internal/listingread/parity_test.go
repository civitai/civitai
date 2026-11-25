package listingread

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

// parityFixture is testdata/media-parity.json. The site reads the same file twice:
//   - listing-media-parity.test.ts runs each listing through the adapter (registryListingMedia,
//     and listingBody for its two ratings: the app entity's and the listing's own) and through the
//     store's gate and projection (scopeAdmitsListingKind, matureRatingAllowed, projectListingMedia)
//     for `expected`;
//   - listing-card-parity.test.ts checks `cards`: recommend is recommendRollup of the counts (and
//     the stream's recommendPct is its), reviewCount is listingReviewCount and openCount is
//     cardOpenCount, the functions projectListingCard uses (app-listing-card-stats.ts).
//
// This side runs it through the read model: each listing becomes the store-listing@v1 body the
// adapter would publish, decoded by the ingest's own decoder, and is gated and projected per viewer.
// Both sides must give `expected` and `cards` exactly.
type parityFixture struct {
	Viewers []struct {
		Name          string `json:"name"`
		RedCapable    bool   `json:"redCapable"`
		BrowsingLevel int64  `json:"browsingLevel"`
		Scope         string `json:"scope"`
	} `json:"viewers"`
	Listings []struct {
		Slug          string  `json:"slug"`
		ID            string  `json:"id"`
		Kind          string  `json:"kind"`
		ContentRating *string `json:"contentRating"`
		// AppContentRating is the app entity's rating, which the stream body carries as
		// contentRating; absent, it is the listing's own.
		AppContentRating *string         `json:"appContentRating"`
		Stats            json.RawMessage `json:"stats"`
		Media            []struct {
			Key       string  `json:"key"`
			Slot      string  `json:"slot"`
			Host      string  `json:"host"`
			NsfwLevel int64   `json:"nsfwLevel"`
			Rating    string  `json:"rating"`
			Caption   *string `json:"caption"`
		} `json:"media"`
	} `json:"listings"`
	Expected map[string]map[string]*parityMedia `json:"expected"`
	Cards    map[string]parityCard              `json:"cards"`
	Details  struct {
		Stream   map[string]map[string]json.RawMessage `json:"stream"`
		Expected map[string]map[string]json.RawMessage `json:"expected"`
	} `json:"details"`
	SubListings struct {
		Items []struct {
			ID                string  `json:"id"`
			Parent            string  `json:"parent"`
			ContentRating     *string `json:"contentRating"`
			CardContentRating *string `json:"cardContentRating"`
			Image             *struct {
				Key       string `json:"key"`
				NsfwLevel int64  `json:"nsfwLevel"`
			} `json:"image"`
		} `json:"items"`
		Expected map[string]map[string]*paritySubListing `json:"expected"`
	} `json:"subListings"`
}

type paritySubListing struct {
	ContentRating *string `json:"contentRating"`
	Cover         *string `json:"cover"`
	Icon          *string `json:"icon"`
}

type parityMedia struct {
	Icon        *string  `json:"icon"`
	Cover       *string  `json:"cover"`
	Screenshots []string `json:"screenshots"`
}

type parityCard struct {
	Recommend   Recommend `json:"recommend"`
	ReviewCount int64     `json:"reviewCount"`
	OpenCount   *int64    `json:"openCount"`
}

// The URLs the fixture's stream bodies carry for an item keyed k: a screenshot's cover rendition
// is a different URL, so a cover taken from a screenshot is told apart from the screenshot.
func coverRendition(k string) string { return k + "#cover" }

func loadParity(t *testing.T) (parityFixture, map[string]store.Listing) {
	t.Helper()
	raw, err := os.ReadFile("testdata/media-parity.json")
	if err != nil {
		t.Fatal(err)
	}
	var f parityFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	listings := map[string]store.Listing{}
	for _, l := range f.Listings {
		media := []map[string]any{}
		for _, m := range l.Media {
			item := map[string]any{"slot": m.Slot, "host": m.Host, "url": m.Key, "nsfwLevel": m.NsfwLevel, "rating": m.Rating}
			if m.Slot == "screenshot" {
				item["caption"] = m.Caption
				item["coverUrl"] = coverRendition(m.Key)
			}
			media = append(media, item)
		}
		appRating := l.ContentRating
		if l.AppContentRating != nil {
			appRating = l.AppContentRating
		}
		fields := map[string]any{
			"app": "urn:apps.civitai.com:app/" + l.Slug, "id": l.ID, "slug": l.Slug, "name": l.Slug, "kind": l.Kind,
			"contentRating": appRating, "listingContentRating": l.ContentRating, "tagline": nil, "category": nil, "media": media, "creator": nil,
			"stats": l.Stats, "createdAt": "2026-01-02T03:04:05.000Z", "updatedAt": nil, "subListings": []any{},
		}
		// The detail part of the body, as the adapter publishes it (details.stream).
		for k, v := range f.Details.Stream[l.Slug] {
			fields[k] = v
		}
		body, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		sl, drops, err := store.ListingFromEntity("urn:apps.civitai.com:store-listing/"+l.Slug, "r", body)
		if err != nil || drops != nil {
			t.Fatalf("%s: the fixture body does not decode cleanly: %v %+v", l.Slug, err, drops)
		}
		listings[l.Slug] = sl
	}
	return f, listings
}

// keyOfURL maps a projected URL back to the fixture key it was built from.
func keyOfURL(t *testing.T, u *string, want string) *string {
	t.Helper()
	if u == nil {
		return nil
	}
	k := *u
	if k == coverRendition(want) {
		k = want
	}
	return &k
}

// TestMediaParity runs every fixture listing through Admits and ProjectMedia for every fixture
// viewer and compares with `expected`, and through ProjectCard for `cards`.
func TestMediaParity(t *testing.T) {
	f, listings := loadParity(t)
	if len(f.Viewers) < 7 || len(f.Listings) < 11 {
		t.Fatalf("the fixture shrank: %d viewers, %d listings", len(f.Viewers), len(f.Listings))
	}
	shown := 0
	for _, fv := range f.Viewers {
		v := Viewer{RedCapable: fv.RedCapable, BrowsingLevel: fv.BrowsingLevel, Scope: fv.Scope}
		want, ok := f.Expected[fv.Name]
		if !ok || len(want) != len(f.Listings) {
			t.Fatalf("viewer %q: expected has %d listings, want %d", fv.Name, len(want), len(f.Listings))
		}
		for slug, l := range listings {
			w, ok := want[slug]
			if !ok {
				t.Fatalf("viewer %q: no expectation for %s", fv.Name, slug)
			}
			if !Admits(l, v) {
				if w != nil {
					t.Errorf("viewer %q, %s: hidden, want shown", fv.Name, slug)
				}
				continue
			}
			if w == nil {
				t.Errorf("viewer %q, %s: shown, want hidden", fv.Name, slug)
				continue
			}
			shown++
			m := ProjectMedia(l, v, true)
			cover := ""
			if w.Cover != nil {
				cover = *w.Cover
			}
			got := parityMedia{Icon: m.IconURL, Cover: keyOfURL(t, m.CoverURL, cover), Screenshots: []string{}}
			for _, s := range m.Screenshots {
				got.Screenshots = append(got.Screenshots, s.URL)
			}
			if !reflect.DeepEqual(got, *w) {
				t.Errorf("viewer %q, %s:\n got %s\nwant %s", fv.Name, slug, show(got), show(*w))
			}
			// A cover taken from a screenshot is its cover rendition, never the screenshot's own URL.
			for _, fl := range f.Listings {
				if fl.Slug != slug {
					continue
				}
				for _, fm := range fl.Media {
					if fm.Slot == "screenshot" && m.CoverURL != nil && *m.CoverURL == fm.Key {
						t.Errorf("viewer %q, %s: the cover is a screenshot's gallery URL, not its cover rendition", fv.Name, slug)
					}
				}
			}
		}
	}
	// Positive control: the matrix shows listings at all, so a gate that hid everything would fail.
	if shown < 30 {
		t.Fatalf("only %d listing views shown across the matrix", shown)
	}
	for slug, l := range listings {
		c, err := ProjectCard(l, Viewer{Scope: ScopeFull})
		if err != nil {
			t.Fatal(err)
		}
		got := parityCard{Recommend: c.Recommend, ReviewCount: c.ReviewCount, OpenCount: c.OpenCount}
		if want := f.Cards[slug]; !reflect.DeepEqual(got, want) {
			t.Errorf("%s card stats:\n got %s\nwant %s", slug, show(got), show(want))
		}
		// The card shows the listing's own rating (projectListingCard: row.contentRating), never the
		// app entity's, which falls back to the block's.
		for _, fl := range f.Listings {
			if fl.Slug == slug && !reflect.DeepEqual(c.ContentRating, fl.ContentRating) {
				t.Errorf("%s card contentRating %v, want the listing's own %v", slug, show(c.ContentRating), show(fl.ContentRating))
			}
		}
	}
}

// Captions travel with the gallery: a screenshot's own caption, null when it has none.
func TestMediaParityCaptions(t *testing.T) {
	_, listings := loadParity(t)
	m := ProjectMedia(listings["pg-mixed"], Viewer{RedCapable: true, BrowsingLevel: 31, Scope: ScopeFull}, true)
	var caps []any
	for _, s := range m.Screenshots {
		if s.Caption == nil {
			caps = append(caps, nil)
		} else {
			caps = append(caps, *s.Caption)
		}
	}
	if want := []any{"an R shot", "a PG shot", nil}; !reflect.DeepEqual(caps, want) {
		t.Fatalf("captions %v, want %v", caps, want)
	}
}

// TestDetailParity projects every fixture listing with detail fields for every fixture viewer and
// compares with details.expected: the fields an anonymous viewer is served, the same for every
// viewer, and forkOf per viewer, its parent looked up as the read API does (by the slug the stream
// names) and named only when the viewer may see it.
func TestDetailParity(t *testing.T) {
	f, listings := loadParity(t)
	if len(f.Details.Expected) < 5 {
		t.Fatalf("the detail fixture shrank: %d listings", len(f.Details.Expected))
	}
	named := 0
	for slug, want := range f.Details.Expected {
		l, ok := listings[slug]
		if !ok {
			t.Fatalf("details name %s, which is not a fixture listing", slug)
		}
		var forkOf map[string]json.RawMessage
		if err := json.Unmarshal(want["forkOf"], &forkOf); err != nil {
			t.Fatal(err)
		}
		for _, fv := range f.Viewers {
			v := Viewer{RedCapable: fv.RedCapable, BrowsingLevel: fv.BrowsingLevel, Scope: fv.Scope}
			var parent *store.Listing
			if p, ok := listings[ForkParentSlug(l)]; ok {
				parent = &p
			}
			d, err := ProjectDetail(l, v, parent)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]json.RawMessage
			raw, _ := json.Marshal(d)
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatal(err)
			}
			var kindData map[string]json.RawMessage
			if err := json.Unmarshal(got["kindData"], &kindData); err != nil {
				t.Fatal(err)
			}
			if _, ok := want["connectClientId"]; !ok && l.Kind == "offsite" {
				t.Fatalf("%s: an off-site detail expectation without connectClientId", slug)
			}
			for k, w := range want {
				switch k {
				case "forkOf":
					w = forkOf[fv.Name]
				case "connectClientId":
					// The detail's off-site kindData field, not a top-level one.
					if !jsonEqual(t, kindData[k], w) {
						t.Errorf("%s, viewer %q, kindData.connectClientId: got %s, want %s", slug, fv.Name, kindData[k], w)
					}
					continue
				}
				if !jsonEqual(t, got[k], w) {
					t.Errorf("%s, viewer %q, %s: got %s, want %s", slug, fv.Name, k, got[k], w)
				}
			}
			if d.ForkOf != nil && d.ForkOf.Visible {
				named++
			}
		}
		// The card carries the stream's appBlockId on-site, and none off-site.
		c, err := ProjectCard(l, Viewer{Scope: ScopeFull})
		if err != nil {
			t.Fatal(err)
		}
		kd, _ := json.Marshal(c.KindData)
		var kindData map[string]json.RawMessage
		_ = json.Unmarshal(kd, &kindData)
		w, inStream := f.Details.Stream[slug]["appBlockId"]
		got, onCard := kindData["appBlockId"]
		if inStream != (l.Kind == "onsite") || onCard != inStream || (onCard && !jsonEqual(t, got, w)) {
			t.Errorf("%s card appBlockId %s, want %s", slug, got, w)
		}
	}
	// Positive control: some viewer is shown a fork's parent, so a rule that never named one fails.
	if named == 0 {
		t.Fatal("no viewer was shown a fork's parent")
	}
}

// imageRatings is each NsfwLevel bit's media rating (NSFW_LEVEL_BY_IMAGE_RATING, inverted).
var imageRatings = map[int64]string{1: "pg", 2: "pg13", 4: "r", 8: "x", 16: "xxx"}

// TestSubListingParity runs every fixture sub-listing through the read model for every fixture
// viewer: its parent's body, with the items the adapter would publish under it, decoded by the
// ingest's decoder; the grid's gate on the parent (Filter) and on the item (SubListingAdmits); and
// ProjectSubListingCard. Each must give subListings.expected exactly.
func TestSubListingParity(t *testing.T) {
	f, listings := loadParity(t)
	if len(f.SubListings.Items) < 8 {
		t.Fatalf("the sub-listing fixture shrank: %d items", len(f.SubListings.Items))
	}
	// Each parent's body again, with its items as the stream carries them.
	items := map[string][]map[string]any{}
	for _, it := range f.SubListings.Items {
		var image any
		if it.Image != nil {
			image = map[string]any{"url": it.Image.Key, "nsfwLevel": it.Image.NsfwLevel, "rating": imageRatings[it.Image.NsfwLevel]}
		}
		items[it.Parent] = append(items[it.Parent], map[string]any{
			"id": it.ID, "title": "title of " + it.ID, "tagline": nil, "contentRating": it.ContentRating,
			"cardContentRating": it.CardContentRating, "author": map[string]any{"id": 9, "username": nil, "image": nil},
			"sortTime": "2026-01-03T00:00:00Z", "runHref": "/apps/run/" + it.Parent + "/x?sl=" + it.ID, "external": false, "image": image,
		})
	}
	parents := map[string]store.Listing{}
	for slug, subs := range items {
		l, ok := listings[slug]
		if !ok {
			t.Fatalf("a sub-listing names %s, which is not a fixture listing", slug)
		}
		var body map[string]any
		if err := json.Unmarshal(l.Body, &body); err != nil {
			t.Fatal(err)
		}
		body["subListings"] = subs
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		p, drops, err := store.ListingFromEntity(l.URN, l.Rev, raw)
		if err != nil || drops != nil {
			t.Fatalf("%s with its sub-listings does not decode cleanly: %v %+v", slug, err, drops)
		}
		parents[slug] = p
	}
	shown := 0
	for _, fv := range f.Viewers {
		v := Viewer{RedCapable: fv.RedCapable, BrowsingLevel: fv.BrowsingLevel, Scope: fv.Scope}
		want := f.SubListings.Expected[fv.Name]
		if len(want) != len(f.SubListings.Items) {
			t.Fatalf("viewer %q: expected has %d items, want %d", fv.Name, len(want), len(f.SubListings.Items))
		}
		for _, it := range f.SubListings.Items {
			w, ok := want[it.ID]
			if !ok {
				t.Fatalf("viewer %q: no expectation for %s", fv.Name, it.ID)
			}
			p := parents[it.Parent]
			s, ok := SubListingOf(p, it.ID)
			if !ok {
				t.Fatalf("%s is not under %s", it.ID, it.Parent)
			}
			admitted := len(Filter([]store.Listing{p}, "", "", nil, v)) == 1 && SubListingAdmits(s, v)
			if !admitted {
				if w != nil {
					t.Errorf("viewer %q, %s: hidden, want shown", fv.Name, it.ID)
				}
				continue
			}
			if w == nil {
				t.Errorf("viewer %q, %s: shown, want hidden", fv.Name, it.ID)
				continue
			}
			shown++
			c := ProjectSubListingCard(p, s, v)
			got := paritySubListing{ContentRating: c.ContentRating, Cover: c.CoverURL, Icon: c.Parent.IconURL}
			if !reflect.DeepEqual(got, *w) {
				t.Errorf("viewer %q, %s:\n got %s\nwant %s", fv.Name, it.ID, show(got), show(*w))
			}
		}
	}
	// Positive control: the matrix shows cards at all, so a gate that hid every item would fail.
	if shown < 25 {
		t.Fatalf("only %d sub-listing views shown across the matrix", shown)
	}
}

func jsonEqual(t *testing.T, a, b json.RawMessage) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(x, y)
}

func show(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
