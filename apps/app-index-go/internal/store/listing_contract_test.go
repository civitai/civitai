package store

import (
	"encoding/json"
	"errors"
	"reflect"
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

// listingJSON is a store-listing@v1 body as the adapter sends it (entities.ts listingBody): an
// R listing whose media include an X screenshot above its rating and both civitai.red overrides.
func listingJSON(slug, name string) json.RawMessage {
	return json.RawMessage(`{
  "app": "urn:apps.civitai.com:app/` + slug + `", "slug": "` + slug + `", "name": "` + name + `", "kind": "onsite",
  "contentRating": "r", "tagline": "t", "category": "generation", "description": "d", "iconUrl": "https://img.invalid/icon",
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
  "createdAt": "2026-03-04T05:06:07.123456Z", "updatedAt": null
}`)
}

func mustListing(slug, name string) Listing {
	l, err := ListingFromEntity(listingURN(slug), "rev-"+slug, listingJSON(slug, name))
	if err != nil {
		panic(err)
	}
	return l
}

func listingUpsert(l Listing, cursor string) Change {
	return Change{Kind: ChangeUpsert, Listing: l, Cursor: cursor}
}

func i64(v int64) *int64 { return &v }

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
	want := Listing{URN: listingURN(slug), Rev: "rev-" + slug, App: "urn:apps.civitai.com:app/" + slug, Slug: slug,
		Name: name, Kind: "onsite", Category: "generation", ContentRating: "r", CreatorID: i64(42), CreatedAt: &created,
		Stats: ListingStats{RecommendedCount: 7, NotRecommendedCount: 3, ReviewCount: 5, OpenCount: i64(120), InstallCount: 0},
		Media: wantMedia}
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
		fewer := mustListing("alpha", "Alpha Two")
		fewer.Media = fewer.Media[:1]
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
	l, err := ListingFromEntity(listingURN("alpha"), "r1", listingJSON("alpha", "Alpha"))
	if err != nil {
		t.Fatal(err)
	}
	checkListing(t, Listing{URN: l.URN, Rev: "rev-alpha", Body: l.Body, App: l.App, Slug: l.Slug, Name: l.Name, Kind: l.Kind,
		Category: l.Category, ContentRating: l.ContentRating, CreatorID: l.CreatorID, CreatedAt: l.CreatedAt,
		UpdatedAt: l.UpdatedAt, Stats: l.Stats, Media: l.Media}, "alpha", "Alpha")

	// Off-site: openCount null, no creator, no media, no dates.
	off, err := ListingFromEntity(listingURN("o"), "r", json.RawMessage(`{"app":"urn:apps.civitai.com:app/o","slug":"o","name":"O",
		"kind":"offsite","contentRating":null,"media":[],"creator":null,"stats":{"recommendedCount":0,"notRecommendedCount":0,
		"recommendPct":null,"reviewCount":0,"openCount":null,"installCount":9}}`))
	if err != nil {
		t.Fatal(err)
	}
	if off.Stats.OpenCount != nil || off.CreatorID != nil || off.CreatedAt != nil || off.ContentRating != "" ||
		off.Stats.InstallCount != 9 || off.Media == nil || len(off.Media) != 0 {
		t.Fatalf("off-site listing %+v", off)
	}

	valid := string(listingJSON("alpha", "Alpha"))
	for _, c := range []struct{ name, from, to, reason string }{
		{"unknown rating", `"rating": "xxx"`, `"rating": "nc17"`, "media[4]: rating missing or unknown"},
		{"unknown host", `"host": "red", "url": "https://img.invalid/red-cover"`, `"host": "blue", "url": "https://img.invalid/red-cover"`, "media[5]: host missing or unknown"},
		{"unknown slot", `"slot": "cover", "host": "any"`, `"slot": "banner", "host": "any"`, "media[1]: slot missing or unknown"},
		{"no nsfwLevel", `"nsfwLevel": 2, `, ``, "media[1]: nsfwLevel missing"},
		{"no media", `"media": [`, `"mediaX": [`, "media missing"},
		{"no stats", `"stats": {`, `"statsX": {`, "stats missing"},
		{"negative count", `"reviewCount": 5`, `"reviewCount": -1`, "stats.reviewCount missing or negative"},
		{"no app", `"app": "urn`, `"appX": "urn`, "app missing"},
		{"bad kind", `"kind": "onsite"`, `"kind": "teleport"`, "kind missing or unknown"},
		{"bad date", `"createdAt": "2026-03-04T05:06:07.123456Z"`, `"createdAt": "yesterday"`, "createdAt: not an RFC 3339 date-time"},
		{"bad updatedAt", `"updatedAt": null`, `"updatedAt": 5`, "updatedAt: not a string or null"},
		{"no slug", `"slug": "alpha"`, `"slugX": "alpha"`, "slug missing"},
		{"no name", `"name": "Alpha"`, `"nameX": "Alpha"`, "name missing"},
		{"no contentRating", `"contentRating": "r"`, `"contentRatingX": "r"`, "contentRating missing"},
		{"bad contentRating", `"contentRating": "r"`, `"contentRating": 3`, "contentRating: not a string or null"},
		{"bad category", `"category": "generation"`, `"category": []`, "category: not a string or null"},
		{"bad creator", `"creator": {"id": 42, "username": "maker", "image": null}`, `"creator": "maker"`, "creator: not an object or null"},
		{"bad openCount", `"openCount": 120`, `"openCount": -1`, "stats.openCount: not a count or null"},
		{"media not an object", `"media": [`, `"media": [7, `, "media[0]: not an object"},
		{"no url", `"url": "https://img.invalid/cover", `, ``, "media[1]: url missing"},
		{"bad caption", `"caption": "first"`, `"caption": 1`, "media[2]: caption: not a string or null"},
		{"bad coverUrl", `"coverUrl": "https://img.invalid/s1-cover"`, `"coverUrl": {}`, "media[2]: coverUrl: not a string or null"},
	} {
		body := strings.Replace(valid, c.from, c.to, 1)
		if body == valid {
			t.Fatalf("%s: the fixture did not change", c.name)
		}
		_, err := ListingFromEntity("u", "r", json.RawMessage(body))
		if err == nil || err.Error() != c.reason {
			t.Errorf("%s: err %v, want %q", c.name, err, c.reason)
		}
	}
	if _, err := DecodeListing("u", "r", json.RawMessage(`[]`)); err == nil || !strings.HasPrefix(err.Error(), "body is not an object") {
		t.Errorf("an array body: err %v", err)
	}
}
