package store

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// listingsTestStore is a Listings whose commit can be failed.
type listingsTestStore interface {
	Listings
	setFailBeforeCommit(func(op string) error)
}

const listingSchemaURN = "urn:schema:apps.civitai.com:store-listing@v1"

func listingURN(slug string) string { return "urn:apps.civitai.com:store-listing/" + slug }

// Two sub-listing ids (asl_ and a 26-character ULID).
const (
	subA = "asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A"
	subB = "asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2B"
)

// listingJSON is a store-listing@v1 body as the adapter sends it (entities.ts listingBody): an
// R listing whose media include an X screenshot above its rating and both civitai.red overrides,
// with two sub-listings: an on-site item rated X with its own X image, and an unrated external one.
func listingJSON(slug, name string) json.RawMessage {
	return json.RawMessage(`{
  "app": "urn:apps.civitai.com:app/` + slug + `", "id": "apl_` + slug + `", "slug": "` + slug + `", "name": "` + name + `", "kind": "onsite",
  "contentRating": "r", "listingContentRating": "r", "tagline": "t", "category": "generation", "description": "d", "iconUrl": "https://img.invalid/icon",
  "media": [
    {"slot": "icon", "host": "any", "url": "https://img.invalid/icon", "nsfwLevel": 1, "rating": "pg"},
    {"slot": "cover", "host": "any", "url": "https://img.invalid/cover", "nsfwLevel": 2, "rating": "pg13"},
    {"slot": "screenshot", "host": "any", "url": "https://img.invalid/s1", "nsfwLevel": 4, "rating": "r", "caption": "first", "coverUrl": "https://img.invalid/s1-cover"},
    {"slot": "screenshot", "host": "any", "url": "https://img.invalid/s2", "nsfwLevel": 8, "rating": "x", "caption": null, "coverUrl": "https://img.invalid/s2-cover"},
    {"slot": "icon", "host": "red", "url": "https://img.invalid/red-icon", "nsfwLevel": 16, "rating": "xxx"},
    {"slot": "cover", "host": "red", "url": "https://img.invalid/red-cover", "nsfwLevel": 8, "rating": "x"}
  ],
  "creator": {"id": 42, "username": "maker", "image": null},
  "isBeta": false, "isOfficial": true, "hasPage": true,
  "stats": {"recommendedCount": 7, "notRecommendedCount": 3, "recommendPct": 0.7, "reviewCount": 5, "openCount": 120, "installCount": 0},
  "createdAt": "2026-03-04T05:06:07.123456Z", "updatedAt": null,
  "serialId": 77, "scopes": ["models:read:self"], "forkOf": {"slug": "parent-` + slug + `"},
  "subListings": [
    {"id": "` + subA + `", "title": "Gen Alpha", "tagline": "first item", "contentRating": "x", "cardContentRating": "x",
     "author": {"id": 51, "username": "author-a", "image": "https://img.invalid/author-a"}, "sortTime": "2026-03-05T01:02:03.654321Z",
     "runHref": "/apps/run/` + slug + `/g/A?sl=` + subA + `", "external": false,
     "image": {"url": "https://img.invalid/item-a", "nsfwLevel": 8, "rating": "x"}},
    {"id": "` + subB + `", "title": "Gen Beta", "tagline": null, "contentRating": null, "cardContentRating": "r",
     "author": {"id": 52, "username": null, "image": null}, "sortTime": "2026-03-06T00:00:00Z",
     "runHref": "https://games.invalid/?game=b", "external": true, "image": null}
  ],
  "subListingsOmitted": 3
}`)
}

func mustListing(slug, name string) Listing {
	l, _, err := ListingFromEntity(listingURN(slug), "rev-"+slug, listingJSON(slug, name))
	if err != nil {
		panic(err)
	}
	return l
}

func listingUpsert(l Listing, cursor string) Change {
	return Change{Kind: ChangeUpsert, Listing: l, Cursor: cursor}
}

func i64(v int64) *int64 { return &v }

func strp(s string) *string { return &s }

// wantMedia is listingJSON's media as the read model must hold it: every item, in stream order,
// each with its own rating, level and host; no ceiling applied.
var wantMedia = []ListingMedia{
	{Position: 0, Slot: "icon", Host: "any", URL: "https://img.invalid/icon", NsfwLevel: 1, Rating: "pg"},
	{Position: 1, Slot: "cover", Host: "any", URL: "https://img.invalid/cover", NsfwLevel: 2, Rating: "pg13"},
	{Position: 2, Slot: "screenshot", Host: "any", URL: "https://img.invalid/s1", NsfwLevel: 4, Rating: "r", Caption: "first", CoverURL: "https://img.invalid/s1-cover"},
	{Position: 3, Slot: "screenshot", Host: "any", URL: "https://img.invalid/s2", NsfwLevel: 8, Rating: "x", CoverURL: "https://img.invalid/s2-cover"},
	{Position: 4, Slot: "icon", Host: "red", URL: "https://img.invalid/red-icon", NsfwLevel: 16, Rating: "xxx"},
	{Position: 5, Slot: "cover", Host: "red", URL: "https://img.invalid/red-cover", NsfwLevel: 8, Rating: "x"},
}

// wantSubListings is listingJSON's sub-listings as the read model must hold them, for slug.
func wantSubListings(slug string) []SubListing {
	ta := time.Date(2026, 3, 5, 1, 2, 3, 654321000, time.UTC)
	tb := time.Date(2026, 3, 6, 0, 0, 0, 0, time.UTC)
	return []SubListing{
		{ID: subA, Title: "Gen Alpha", ContentRating: "x", SortTime: &ta, Tagline: strp("first item"), CardContentRating: "x",
			Author:  ListingChip{ID: 51, Username: strp("author-a"), Image: strp("https://img.invalid/author-a")},
			RunHref: "/apps/run/" + slug + "/g/A?sl=" + subA,
			Image:   &SubListingImage{URL: "https://img.invalid/item-a", NsfwLevel: 8, Rating: "x"}},
		{ID: subB, Title: "Gen Beta", SortTime: &tb, CardContentRating: "r", Author: ListingChip{ID: 52},
			RunHref: "https://games.invalid/?game=b", External: true},
	}
}

// firstMedia is body with only its first n media items.
func firstMedia(t *testing.T, body json.RawMessage, n int) json.RawMessage {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatal(err)
	}
	m["media"] = m["media"].([]any)[:n]
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func mustGet(t *testing.T, s Listings, gen int64, urn string) (Listing, bool) {
	t.Helper()
	l, ok, err := s.Get(t.Context(), gen, urn)
	if err != nil {
		t.Fatalf("get %s: %v", urn, err)
	}
	return l, ok
}

func mustCount(t *testing.T, s Listings, gen int64) int {
	t.Helper()
	n, err := s.Count(t.Context(), gen)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// checkListing compares a stored listing with the literal values of listingJSON. The body is
// compared as JSON, since Postgres's jsonb does not keep the bytes.
func checkListing(t *testing.T, got Listing, slug, name string) {
	t.Helper()
	created := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	want := Listing{URN: listingURN(slug), Rev: "rev-" + slug, ID: "apl_" + slug, App: "urn:apps.civitai.com:app/" + slug, Slug: slug,
		Name: name, Kind: "onsite", Category: "generation", ContentRating: "r", ListingContentRating: "r", CreatorID: i64(42), CreatedAt: &created,
		Stats:       ListingStats{RecommendedCount: i64(7), NotRecommendedCount: i64(3), ReviewCount: i64(5), OpenCount: i64(120), InstallCount: i64(0)},
		Media:       wantMedia,
		Detail:      ListingDetail{SerialID: i64(77), Scopes: []string{"models:read:self"}, ForkOf: &ListingStreamFork{Slug: strp("parent-" + slug)}},
		SubListings: wantSubListings(slug), SubListingsOmitted: 3}
	body := got.Body
	got.Body = nil
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stored listing\n got %+v\nwant %+v", got, want)
	}
	var a, b any
	if err := json.Unmarshal(body, &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(listingJSON(slug, name), &b); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("stored body %s, want the body as sent", body)
	}
}

func runListingsContract(t *testing.T, newStore func(t *testing.T) listingsTestStore) {
	t.Run("StoresEveryMediaItemAsSent", func(t *testing.T) {
		s := newStore(t)
		g, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		mustApply(t, s, g.ID, listingUpsert(mustListing("alpha", "Alpha"), ""))
		l, ok := mustGet(t, s, g.ID, listingURN("alpha"))
		if !ok {
			t.Fatal("upserted listing not found")
		}
		checkListing(t, l, "alpha", "Alpha")
	})

	t.Run("UpsertReplacesMediaDeleteRemoves", func(t *testing.T) {
		s := newStore(t)
		g, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		mustApply(t, s, g.ID, listingUpsert(mustListing("alpha", "Alpha"), ""), listingUpsert(mustListing("beta", "Beta"), ""))
		// The media are read back from the body, so the shorter list is a body with one item.
		fewer, _, err := ListingFromEntity(listingURN("alpha"), "rev-alpha", firstMedia(t, listingJSON("alpha", "Alpha Two"), 1))
		if err != nil {
			t.Fatal(err)
		}
		mustApply(t, s, g.ID, listingUpsert(fewer, "c1"))
		l, _ := mustGet(t, s, g.ID, listingURN("alpha"))
		if l.Name != "Alpha Two" || !reflect.DeepEqual(l.Media, wantMedia[:1]) {
			t.Fatalf("after a re-upsert with one item: %q %+v", l.Name, l.Media)
		}
		mustApply(t, s, g.ID, Change{Kind: ChangeDelete, URN: listingURN("alpha"), Cursor: "c2"})
		if _, ok := mustGet(t, s, g.ID, listingURN("alpha")); ok {
			t.Fatal("deleted listing still held")
		}
		if n := mustCount(t, s, g.ID); n != 1 {
			t.Fatalf("count after delete = %d, want 1", n)
		}
		if c := mustState(t, s).Building.Cursor; c != "c2" {
			t.Fatalf("cursor %q, want c2", c)
		}
	})

	t.Run("NullStatsKeptAsNull", func(t *testing.T) {
		s := newStore(t)
		g, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		body := strings.Replace(string(listingJSON("beta", "Beta")), `, "installCount": 0}`, `}`, 1)
		l, drops, err := ListingFromEntity(listingURN("beta"), "rev-beta", json.RawMessage(body))
		if err != nil || len(drops) != 1 {
			t.Fatalf("decode: %v %+v", err, drops)
		}
		mustApply(t, s, g.ID, listingUpsert(l, ""))
		got, ok := mustGet(t, s, g.ID, listingURN("beta"))
		want := ListingStats{RecommendedCount: i64(7), NotRecommendedCount: i64(3), ReviewCount: i64(5), OpenCount: i64(120)}
		if !ok || !reflect.DeepEqual(got.Stats, want) {
			t.Fatalf("stored stats %+v (ok %v), want installCount null and the rest kept", got.Stats, ok)
		}
	})

	t.Run("CountPerGeneration", func(t *testing.T) {
		s := newStore(t)
		if _, err := s.Count(t.Context(), 999); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("count of a missing generation: %v, want ErrNoGeneration", err)
		}
		if _, _, err := s.Get(t.Context(), 999, listingURN("alpha")); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("get from a missing generation: %v, want ErrNoGeneration", err)
		}
		g, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		if n := mustCount(t, s, g.ID); n != 0 {
			t.Fatalf("new generation count = %d", n)
		}
		mustApply(t, s, g.ID, listingUpsert(mustListing("alpha", "Alpha"), ""), listingUpsert(mustListing("beta", "Beta"), ""),
			listingUpsert(mustListing("gamma", "Gamma"), ""))
		mustLive(t, s, g.ID, "L1")
		g2, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		mustApply(t, s, g2.ID, listingUpsert(mustListing("delta", "Delta"), ""))
		if a, b := mustCount(t, s, g.ID), mustCount(t, s, g2.ID); a != 3 || b != 1 {
			t.Fatalf("counts serving %d building %d, want 3 and 1", a, b)
		}
		if err := s.Reset(t.Context(), g2.ID); err != nil {
			t.Fatal(err)
		}
		if a, b := mustCount(t, s, g.ID), mustCount(t, s, g2.ID); a != 3 || b != 0 {
			t.Fatalf("after reset: serving %d building %d, want 3 and 0", a, b)
		}
	})

	t.Run("ReadsForTheAPI", func(t *testing.T) {
		s := newStore(t)
		if _, err := s.Keys(t.Context(), 999); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("keys of a missing generation: %v, want ErrNoGeneration", err)
		}
		if _, err := s.GetMany(t.Context(), 999, []string{listingURN("alpha")}); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("get many from a missing generation: %v, want ErrNoGeneration", err)
		}
		if _, _, err := s.BySlug(t.Context(), 999, "alpha"); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("by slug from a missing generation: %v, want ErrNoGeneration", err)
		}
		g, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		if keys, err := s.Keys(t.Context(), g.ID); err != nil || len(keys) != 0 {
			t.Fatalf("keys of an empty generation: %v %v", keys, err)
		}
		mustApply(t, s, g.ID, listingUpsert(mustListing("alpha", "Alpha"), ""), listingUpsert(mustListing("beta", "Beta"), ""))

		keys, err := s.Keys(t.Context(), g.ID)
		if err != nil {
			t.Fatal(err)
		}
		slices.SortFunc(keys, func(a, b Listing) int { return strings.Compare(a.URN, b.URN) })
		want := mustListing("alpha", "Alpha")
		// Keys carries the columns only: no body, media or detail fields, and each sub-listing's key
		// fields (id, title, own rating, sort time) and nothing else of it.
		want.Body, want.Media, want.Detail = nil, nil, ListingDetail{}
		ta := time.Date(2026, 3, 5, 1, 2, 3, 654321000, time.UTC)
		tb := time.Date(2026, 3, 6, 0, 0, 0, 0, time.UTC)
		// The count left out by the adapter's cap is a column too.
		if want.SubListingsOmitted != 3 {
			t.Fatalf("fixture omitted %d, want 3", want.SubListingsOmitted)
		}
		want.SubListings = []SubListing{{ID: subA, Title: "Gen Alpha", ContentRating: "x", SortTime: &ta},
			{ID: subB, Title: "Gen Beta", SortTime: &tb}}
		if len(keys) != 2 || !reflect.DeepEqual(keys[0], want) || keys[1].Slug != "beta" {
			t.Fatalf("keys\n got %+v\nwant [%+v beta]", keys, want)
		}

		many, err := s.GetMany(t.Context(), g.ID, []string{listingURN("beta"), listingURN("gone"), listingURN("alpha"), listingURN("beta")})
		if err != nil {
			t.Fatal(err)
		}
		slices.SortFunc(many, func(a, b Listing) int { return strings.Compare(a.URN, b.URN) })
		if len(many) != 2 {
			t.Fatalf("get many: %d listings, want alpha and beta once each", len(many))
		}
		checkListing(t, many[0], "alpha", "Alpha")
		checkListing(t, many[1], "beta", "Beta")

		l, ok, err := s.BySlug(t.Context(), g.ID, "beta")
		if err != nil || !ok {
			t.Fatalf("by slug: %v %v", ok, err)
		}
		checkListing(t, l, "beta", "Beta")
		if _, ok, err := s.BySlug(t.Context(), g.ID, "gone"); ok || err != nil {
			t.Fatalf("by an unknown slug: %v %v", ok, err)
		}
	})

	// A generation switched away from answers ErrNoGeneration to every read, never an empty one:
	// the API turns that into a 503 rather than an empty page.
	t.Run("ReadsOfASwitchedAwayGeneration", func(t *testing.T) {
		s := newStore(t)
		g, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		mustApply(t, s, g.ID, listingUpsert(mustListing("alpha", "Alpha"), ""))
		mustLive(t, s, g.ID, "L1")
		g2, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		mustApply(t, s, g2.ID, listingUpsert(mustListing("beta", "Beta"), ""))
		mustLive(t, s, g2.ID, "L2")
		if k, err := s.Keys(t.Context(), g.ID); !errors.Is(err, ErrNoGeneration) {
			t.Errorf("keys of the old generation: %v %v", k, err)
		}
		if m, err := s.GetMany(t.Context(), g.ID, []string{listingURN("alpha")}); !errors.Is(err, ErrNoGeneration) {
			t.Errorf("get many from the old generation: %v %v", m, err)
		}
		if _, _, err := s.BySlug(t.Context(), g.ID, "alpha"); !errors.Is(err, ErrNoGeneration) {
			t.Errorf("by slug from the old generation: %v", err)
		}
		if _, _, err := s.Get(t.Context(), g.ID, listingURN("alpha")); !errors.Is(err, ErrNoGeneration) {
			t.Errorf("get from the old generation: %v", err)
		}
	})

	t.Run("FailedCommitWritesNothing", func(t *testing.T) {
		s := newStore(t)
		g, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		mustApply(t, s, g.ID, listingUpsert(mustListing("alpha", "Alpha"), "c1"))
		s.setFailBeforeCommit(func(string) error { return errors.New("crash") })
		short := mustListing("alpha", "Alpha Two")
		short.Media = nil
		if err := s.Apply(t.Context(), g.ID, listingUpsert(short, "c2")); err == nil {
			t.Fatal("apply committed through a failed commit")
		}
		s.setFailBeforeCommit(nil)
		l, _ := mustGet(t, s, g.ID, listingURN("alpha"))
		if l.Name != "Alpha" || len(l.Media) != len(wantMedia) {
			t.Fatalf("a failed upsert changed the row: %q, %d media", l.Name, len(l.Media))
		}
		if c := mustState(t, s).Building.Cursor; c != "c1" {
			t.Fatalf("cursor %q after a failed commit, want c1", c)
		}
	})

	t.Run("StaleMarks", func(t *testing.T) {
		s := newStore(t)
		if _, err := s.StaleCount(t.Context(), 999); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("stale count of a missing generation: %v, want ErrNoGeneration", err)
		}
		g, err := s.NewBuilding(t.Context(), listingSchemaURN, 1)
		if err != nil {
			t.Fatal(err)
		}
		mustApply(t, s, g.ID, listingUpsert(mustListing("alpha", "Alpha"), ""), listingUpsert(mustListing("beta", "Beta"), ""))
		stale := func(want int, what string) {
			t.Helper()
			n, err := s.StaleCount(t.Context(), g.ID)
			if err != nil || n != want {
				t.Fatalf("stale count %s = %d %v, want %d", what, n, err, want)
			}
		}
		stale(0, "of fresh rows")
		// A mark keeps the row exactly as it was, and stores its cursor.
		mustApply(t, s, g.ID, Change{Kind: ChangeStale, URN: listingURN("alpha"), Cursor: "c1"},
			Change{Kind: ChangeStale, URN: listingURN("beta"), Cursor: "c2"})
		stale(2, "after two marks")
		l, ok := mustGet(t, s, g.ID, listingURN("alpha"))
		if !ok {
			t.Fatal("a stale mark removed the row")
		}
		checkListing(t, l, "alpha", "Alpha")
		if n := mustCount(t, s, g.ID); n != 2 {
			t.Fatalf("count after marks = %d, want 2", n)
		}
		if c := mustState(t, s).Building.Cursor; c != "c2" {
			t.Fatalf("cursor %q after a mark, want c2", c)
		}
		// A mark of a URN the generation does not hold changes nothing but the cursor.
		mustApply(t, s, g.ID, Change{Kind: ChangeStale, URN: listingURN("gamma"), Cursor: "c3"})
		stale(2, "after a mark of a missing row")
		if _, ok := mustGet(t, s, g.ID, listingURN("gamma")); ok {
			t.Fatal("a stale mark created a row")
		}
		// An upsert writes the row unmarked; a delete removes it, mark and all.
		mustApply(t, s, g.ID, listingUpsert(mustListing("alpha", "Alpha Two"), "c4"))
		stale(1, "after an upsert of a stale row")
		mustApply(t, s, g.ID, Change{Kind: ChangeDelete, URN: listingURN("beta"), Cursor: "c5"})
		stale(0, "after a delete of a stale row")
		// A row upserted again after its delete is not stale.
		mustApply(t, s, g.ID, listingUpsert(mustListing("beta", "Beta"), "c6"))
		stale(0, "after a re-upsert")
		mustApply(t, s, g.ID, Change{Kind: ChangeStale, URN: listingURN("beta"), Cursor: "c7"})
		stale(1, "after a mark")
		if err := s.Reset(t.Context(), g.ID); err != nil {
			t.Fatal(err)
		}
		stale(0, "after a reset")
	})
}

func TestListingsMemoryContract(t *testing.T) {
	runListingsContract(t, func(*testing.T) listingsTestStore { return NewListingsMemory() })
}

func (m *ListingsMemory) setFailBeforeCommit(f func(op string) error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.failBeforeCommit = f
}

func TestListingFromEntity(t *testing.T) {
	l, drops, err := ListingFromEntity(listingURN("alpha"), "r1", listingJSON("alpha", "Alpha"))
	if err != nil || drops != nil {
		t.Fatalf("valid body: err %v drops %+v", err, drops)
	}
	checkListing(t, Listing{URN: l.URN, Rev: "rev-alpha", Body: l.Body, ID: l.ID, App: l.App, Slug: l.Slug, Name: l.Name, Kind: l.Kind,
		Category: l.Category, ContentRating: l.ContentRating, ListingContentRating: l.ListingContentRating, CreatorID: l.CreatorID, CreatedAt: l.CreatedAt,
		UpdatedAt: l.UpdatedAt, Stats: l.Stats, Media: l.Media, Detail: l.Detail, SubListings: l.SubListings,
		SubListingsOmitted: l.SubListingsOmitted}, "alpha", "Alpha")

	// Off-site: openCount null, no creator, no media, no dates.
	off, drops, err := ListingFromEntity(listingURN("o"), "r", json.RawMessage(`{"app":"urn:apps.civitai.com:app/o","id":"apl_o","slug":"o","name":"O",
		"kind":"offsite","contentRating":null,"listingContentRating":null,"media":[],"creator":null,"stats":{"recommendedCount":0,"notRecommendedCount":0,
		"recommendPct":null,"reviewCount":0,"openCount":null,"installCount":9},"subListings":[]}`))
	if err != nil || drops != nil {
		t.Fatalf("off-site body: err %v drops %+v (a null openCount is not a drop)", err, drops)
	}
	if off.Stats.OpenCount != nil || off.CreatorID != nil || off.CreatedAt != nil || off.ContentRating != "" ||
		*off.Stats.InstallCount != 9 || off.Media == nil || len(off.Media) != 0 || off.SubListings == nil || len(off.SubListings) != 0 ||
		off.SubListingsOmitted != 0 {
		t.Fatalf("off-site listing %+v", off)
	}

	valid := string(listingJSON("alpha", "Alpha"))
	for _, c := range []struct{ name, from, to, reason string }{
		{"unknown rating", `"rating": "xxx"`, `"rating": "nc17"`, "media[4]: rating missing or unknown"},
		{"unknown host", `"host": "red", "url": "https://img.invalid/red-cover"`, `"host": "blue", "url": "https://img.invalid/red-cover"`, "media[5]: host missing or unknown"},
		// An item's nsfwLevel must be exactly its rating's bit (pg 1, pg13 2, r 4, x 8, xxx 16).
		{"pg at 16", `"nsfwLevel": 1, "rating": "pg"`, `"nsfwLevel": 16, "rating": "pg"`, "media[0]: nsfwLevel 16 is not rating pg's level"},
		{"pg13 at 3 (two bits)", `"nsfwLevel": 2, "rating": "pg13"`, `"nsfwLevel": 3, "rating": "pg13"`, "media[1]: nsfwLevel 3 is not rating pg13's level"},
		{"r at 0", `"nsfwLevel": 4, "rating": "r"`, `"nsfwLevel": 0, "rating": "r"`, "media[2]: nsfwLevel 0 is not rating r's level"},
		{"x at 32 (Blocked)", `"nsfwLevel": 8, "rating": "x"`, `"nsfwLevel": 32, "rating": "x"`, "media[3]: nsfwLevel 32 is not rating x's level"},
		{"no nsfwLevel", `"nsfwLevel": 2, `, ``, "media[1]: nsfwLevel missing"},
		{"no media", `"media": [`, `"mediaX": [`, "media missing"},
		{"no app", `"app": "urn`, `"appX": "urn`, "app missing"},
		// The card key and the sort tie-break: without it a listing cannot be ranked as the store ranks it.
		{"no id", `"id": "apl_alpha"`, `"idX": "apl_alpha"`, "id missing"},
		{"empty id", `"id": "apl_alpha"`, `"id": ""`, "id missing"},
		{"bad detail field", `"isOfficial": true,`, `"isOfficial": true, "scopes": "models:read:self",`, "detail fields: json: cannot unmarshal string into Go struct field ListingDetail.scopes of type []string"},
		{"bad kind", `"kind": "onsite"`, `"kind": "teleport"`, "kind missing or unknown"},
		{"bad date", `"createdAt": "2026-03-04T05:06:07.123456Z"`, `"createdAt": "yesterday"`, "createdAt: not an RFC 3339 date-time"},
		{"bad updatedAt", `"updatedAt": null`, `"updatedAt": 5`, "updatedAt: not a string or null"},
		{"no slug", `"slug": "alpha"`, `"slugX": "alpha"`, "slug missing"},
		{"no name", `"name": "Alpha"`, `"nameX": "Alpha"`, "name missing"},
		{"no contentRating", `"contentRating": "r"`, `"contentRatingX": "r"`, "contentRating missing"},
		{"bad contentRating", `"contentRating": "r"`, `"contentRating": 3`, "contentRating: not a string or null"},
		// The listing's own rating is what the read API gates on: without it the body is unusable.
		{"no listingContentRating", `"listingContentRating": "r"`, `"listingContentRatingX": "r"`, "listingContentRating missing"},
		{"bad listingContentRating", `"listingContentRating": "r"`, `"listingContentRating": 4`, "listingContentRating: not a string or null"},
		{"bad category", `"category": "generation"`, `"category": []`, "category: not a string or null"},
		{"bad creator", `"creator": {"id": 42, "username": "maker", "image": null}`, `"creator": "maker"`, "creator: not an object or null"},
		{"media not an object", `"media": [`, `"media": [7, `, "media[0]: not an object"},
		{"no url", `"url": "https://img.invalid/cover", `, ``, "media[1]: url missing"},
		{"bad caption", `"caption": "first"`, `"caption": 1`, "media[2]: caption: not a string or null"},
		{"bad coverUrl", `"coverUrl": "https://img.invalid/s1-cover"`, `"coverUrl": {}`, "media[2]: coverUrl: not a string or null"},
		// A body without subListings is from an adapter that does not publish them: its listing would
		// read as having none, so it is unusable rather than a listing with no items.
		{"no subListings", `"subListings": [`, `"subListingsX": [`, "subListings missing"},
		{"negative subListingsOmitted", `"subListingsOmitted": 3`, `"subListingsOmitted": -1`, "subListingsOmitted is negative"},
		{"sub-listing not an object", `"subListings": [`, `"subListings": [7, `, "subListings[0]: not an object"},
		{"sub-listing id not a sub-listing id", `"id": "` + subA + `"`, `"id": "apl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A"`, "subListings[0]: id missing or not a sub-listing id"},
		{"sub-listing id too short", `"id": "` + subB + `"`, `"id": "asl_01J9"`, "subListings[1]: id missing or not a sub-listing id"},
		{"sub-listing id twice", `"id": "` + subB + `"`, `"id": "` + subA + `"`, "subListings[1]: id " + subA + " twice"},
		{"no title", `"title": "Gen Beta"`, `"titleX": "Gen Beta"`, "subListings[1]: title missing"},
		{"no own rating", `"contentRating": null, "cardContentRating"`, `"cardContentRating"`, "subListings[1]: contentRating missing"},
		{"bad own rating", `"contentRating": "x"`, `"contentRating": 8`, "subListings[0]: contentRating: not a string or null"},
		{"no card rating", `"cardContentRating": "r"`, `"cardContentRatingX": "r"`, "subListings[1]: cardContentRating missing"},
		{"no author", `"author": {"id": 52`, `"authorX": {"id": 52`, "subListings[1]: author missing"},
		{"author without id", `"author": {"id": 52, `, `"author": {`, "subListings[1]: author missing"},
		{"no runHref", `"runHref": "https://games.invalid/?game=b"`, `"runHref": ""`, "subListings[1]: runHref missing"},
		{"no external", `"external": true`, `"externalX": true`, "subListings[1]: external missing"},
		{"no image", `"external": true, "image": null`, `"external": true`, "subListings[1]: image missing"},
		{"bad sortTime", `"sortTime": "2026-03-06T00:00:00Z"`, `"sortTime": "tomorrow"`, "subListings[1]: sortTime missing or not an RFC 3339 date-time"},
		{"null sortTime", `"sortTime": "2026-03-06T00:00:00Z"`, `"sortTime": null`, "subListings[1]: sortTime missing or not an RFC 3339 date-time"},
		{"bad tagline", `"tagline": "first item"`, `"tagline": 3`, "subListings[0]: tagline: not a string or null"},
		// An item image is gated per request like a media item: its level must be its rating's.
		{"image level not its rating's", `"nsfwLevel": 8, "rating": "x"}}`, `"nsfwLevel": 4, "rating": "x"}}`, "subListings[0]: image: nsfwLevel 4 is not rating x's level"},
		{"image rating unknown", `"nsfwLevel": 8, "rating": "x"}}`, `"nsfwLevel": 8, "rating": "nc17"}}`, "subListings[0]: image: rating missing or unknown"},
		{"image without url", `"image": {"url": "https://img.invalid/item-a", `, `"image": {`, "subListings[0]: image: url missing"},
		{"image not an object", `"image": {"url": "https://img.invalid/item-a", "nsfwLevel": 8, "rating": "x"}`, `"image": 5`, "subListings[0]: image: not an object or null"},
	} {
		body := strings.Replace(valid, c.from, c.to, 1)
		if body == valid {
			t.Fatalf("%s: the fixture did not change", c.name)
		}
		_, _, err := ListingFromEntity("u", "r", json.RawMessage(body))
		if err == nil || err.Error() != c.reason {
			t.Errorf("%s: err %v, want %q", c.name, err, c.reason)
		}
	}
	if _, err := DecodeListing("u", "r", json.RawMessage(`[]`)); err == nil || !strings.HasPrefix(err.Error(), "body is not an object") {
		t.Errorf("an array body: err %v", err)
	}
}

// What the read model can leave out without misgating is dropped, and the listing kept: a media
// item whose slot it does not know, and a stats counter that is not a count (stored null).
// Identity and gating defects still reject the body (TestListingFromEntity).
func TestListingDropsKeepTheListing(t *testing.T) {
	valid := string(listingJSON("alpha", "Alpha"))
	for _, c := range []struct {
		name, from, to string
		drops          []Drop
		check          func(Listing) bool
	}{
		{"unknown slot", `"slot": "cover", "host": "any"`, `"slot": "banner", "host": "any"`,
			[]Drop{{"media_item", "media[1]: slot missing or unknown"}},
			func(l Listing) bool {
				return len(l.Media) == 5 && l.Media[0] == wantMedia[0] && l.Media[1] == wantMedia[2] && l.Media[4] == wantMedia[5]
			}},
		{"no slot", `"slot": "icon", "host": "red", `, `"host": "red", `,
			[]Drop{{"media_item", "media[4]: slot missing or unknown"}},
			func(l Listing) bool { return len(l.Media) == 5 && l.Media[4] == wantMedia[5] }},
		{"installCount missing", `, "installCount": 0}`, `}`,
			[]Drop{{"stat", "stats.installCount missing or not a count"}},
			func(l Listing) bool {
				return l.Stats.InstallCount == nil && *l.Stats.ReviewCount == 5 && len(l.Media) == 6
			}},
		{"negative and ill-typed counters", `"recommendedCount": 7, "notRecommendedCount": 3`,
			`"recommendedCount": "7", "notRecommendedCount": -3`,
			[]Drop{{"stat", "stats.recommendedCount missing or not a count"}, {"stat", "stats.notRecommendedCount missing or not a count"}},
			func(l Listing) bool {
				return l.Stats.RecommendedCount == nil && l.Stats.NotRecommendedCount == nil && *l.Stats.OpenCount == 120
			}},
		{"openCount negative", `"openCount": 120`, `"openCount": -1`,
			[]Drop{{"stat", "stats.openCount missing or not a count"}},
			func(l Listing) bool { return l.Stats.OpenCount == nil && *l.Stats.InstallCount == 0 }},
		{"no stats", `"stats": {`, `"statsX": {`,
			[]Drop{{"stat", "stats missing or not an object"}},
			func(l Listing) bool { return l.Stats == (ListingStats{}) && l.Slug == "alpha" }},
	} {
		body := strings.Replace(valid, c.from, c.to, 1)
		if body == valid {
			t.Fatalf("%s: the fixture did not change", c.name)
		}
		l, drops, err := ListingFromEntity(listingURN("alpha"), "r", json.RawMessage(body))
		if err != nil {
			t.Errorf("%s: the listing was rejected: %v", c.name, err)
			continue
		}
		if !reflect.DeepEqual(drops, c.drops) {
			t.Errorf("%s: drops %+v, want %+v", c.name, drops, c.drops)
		}
		if !c.check(l) {
			t.Errorf("%s: kept listing %+v", c.name, l)
		}
	}
}
