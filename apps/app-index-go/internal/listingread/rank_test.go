package listingread

import (
	"encoding/base64"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-index-go/internal/store"
)

func n(v int64) *int64 { return &v }

func key(slug, kind, rating string, up, down, open, installs int64) store.Listing {
	created := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l := store.Listing{URN: "urn:apps.civitai.com:store-listing/" + slug, Slug: slug, Name: strings.ToUpper(slug[:1]) + slug[1:],
		Kind: kind, ContentRating: rating, ListingContentRating: rating, CreatedAt: &created,
		Stats: store.ListingStats{RecommendedCount: n(up), NotRecommendedCount: n(down), ReviewCount: n(up + down),
			OpenCount: n(open), InstallCount: n(installs)}}
	if kind != "onsite" {
		l.Stats.OpenCount = nil
	}
	return l
}

// The sort keys, literally, as listingSortKeyExpr's SQL renders them.
func TestSortKeys(t *testing.T) {
	on := key("a", "onsite", "pg", 8, 2, 50, 3)
	off := key("b", "offsite", "pg", 0, 0, 0, 12)
	if got, want := popularKey(on), "00000000000000000050"+"00000000000000000003"; got != want {
		t.Errorf("popular on-site %s, want %s", got, want)
	}
	// Off-site ranks by installs in the plays position: it has no play count.
	if got, want := popularKey(off), "00000000000000000012"+"00000000000000000012"; got != want {
		t.Errorf("popular off-site %s, want %s", got, want)
	}
	// (10·0.5 + 8) / (10 + 8 + 2) = 0.65 → 650000.
	if got, want := bayesKey(on, 0.5), "000650000"+popularKey(on); got != want {
		t.Errorf("top-rated %s, want %s", got, want)
	}
	// No reviews: the score is the mean. (10·0.7)/10 = 0.7 → 700000.
	if got, want := bayesKey(off, 0.7), "000700000"+popularKey(off); got != want {
		t.Errorf("top-rated, no reviews %s, want %s", got, want)
	}
	ts := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.FixedZone("x", 3600))
	if got, want := newestKey(&ts), "20260304040607123456"; got != want {
		t.Errorf("newest %s, want %s (UTC, microseconds)", got, want)
	}
	if got := newestKey(nil); got != "" {
		t.Errorf("newest of no date %q", got)
	}
	if got, want := nameKey("ÄBC Paint"), "äbc paint"; got != want {
		t.Errorf("name %q, want %q", got, want)
	}
	long := strings.Repeat("é", 70)
	if got := nameKey(long); got != strings.Repeat("é", 64) {
		t.Errorf("name key is %d runes, want 64 characters (not bytes)", len([]rune(got)))
	}
	if got := lpad(1234567, 3); got != "123" {
		t.Errorf("lpad cuts like Postgres: %q", got)
	}
}

func TestGlobalMean(t *testing.T) {
	if got := GlobalMean(nil); got != 0.5 {
		t.Errorf("no listings: %v, want 0.5", got)
	}
	ks := []store.Listing{key("a", "onsite", "pg", 3, 1, 0, 0), key("b", "onsite", "pg", 1, 1, 0, 0), key("c", "onsite", "pg", 0, 0, 0, 0)}
	// (0.75 + 0.5) / 2: a listing with no review does not count.
	if got := GlobalMean(ks); got != 0.625 {
		t.Errorf("mean %v, want 0.625", got)
	}
}

func walk(t *testing.T, keys []store.Listing, q ListQuery, v Viewer) []string {
	t.Helper()
	var out []string
	for range 100 {
		p := Rank(keys, q, v)
		if len(p.URNs) > q.Limit {
			t.Fatalf("page of %d, limit %d", len(p.URNs), q.Limit)
		}
		for _, u := range p.URNs {
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

var full = Viewer{Scope: ScopeFull}

func catalog() []store.Listing {
	return []store.Listing{
		key("alpha", "onsite", "pg", 9, 1, 40, 2),
		key("bravo", "onsite", "pg13", 0, 0, 40, 2), // ties alpha on the popular key
		key("charlie", "offsite", "", 2, 2, 0, 41),
		key("delta", "onsite", "r", 5, 0, 100, 0),
		key("echo", "onsite", "pg", 0, 0, 0, 0),
		key("foxtrot", "offsite", "pg", 1, 0, 0, 3),
		key("golf", "onsite", "x", 0, 9, 7, 7),
	}
}

func TestRankSortsAndPages(t *testing.T) {
	ks := catalog()
	for _, c := range []struct {
		sort  string
		limit int
		want  []string
	}{
		// charlie 41 (offsite: installs), then alpha/bravo tie on 40·2 and fall to the slug, DESC.
		{SortPopular, 2, []string{"charlie", "bravo", "alpha", "foxtrot", "echo"}},
		{SortPopular, 50, []string{"charlie", "bravo", "alpha", "foxtrot", "echo"}},
		{SortName, 2, []string{"alpha", "bravo", "charlie", "echo", "foxtrot"}},
		// mean over the listings HELD (delta and golf included, though this viewer sees neither):
		// alpha .9, charlie .5, delta 1, foxtrot 1, golf 0 → 3.4/5 = 0.68.
		// alpha (6.8+9)/20=.79, charlie (6.8+2)/14=.628571→628571, foxtrot (6.8+1)/11=.709090→709091,
		// bravo and echo .68, bravo before echo on plays.
		{SortTopRated, 1, []string{"alpha", "foxtrot", "bravo", "echo", "charlie"}},
		{SortTopRated, 3, []string{"alpha", "foxtrot", "bravo", "echo", "charlie"}},
	} {
		got := walk(t, ks, ListQuery{Sort: c.sort, Limit: c.limit}, full)
		if !slices.Equal(got, c.want) {
			t.Errorf("%s limit %d: %v, want %v", c.sort, c.limit, got, c.want)
		}
	}
	// newest: by created time DESC, then slug DESC.
	ks = catalog()
	for i := range ks {
		at := time.Date(2026, 1, 1+i%3, 0, 0, 0, 0, time.UTC)
		ks[i].CreatedAt = &at
	}
	if got, want := walk(t, ks, ListQuery{Sort: SortNewest, Limit: 2}, full), []string{"foxtrot", "charlie", "echo", "bravo", "alpha"}; !slices.Equal(got, want) {
		t.Errorf("newest %v, want %v", got, want)
	}
}

// The top-rated mean is pinned in the cursor: a review landing between two pages does not move
// the boundary, so no listing is served twice or skipped.
func TestRankPinsTheMean(t *testing.T) {
	ks := catalog()
	p1 := Rank(ks, ListQuery{Sort: SortTopRated, Limit: 2}, full)
	c := decodeCursor(p1.NextCursor)
	if !c.ok || c.mean == nil || math.Abs(*c.mean-0.68) > 1e-12 {
		t.Fatalf("cursor %+v, want the mean 0.68 pinned", c)
	}
	// golf turns from 0% to 100%: the fresh mean would be 0.88.
	ks[6].Stats.RecommendedCount, ks[6].Stats.NotRecommendedCount = n(9), n(0)
	rest := walk(t, ks, ListQuery{Sort: SortTopRated, Limit: 2, Cursor: p1.NextCursor}, full)
	if want := []string{"bravo", "echo", "charlie"}; !slices.Equal(rest, want) {
		t.Fatalf("after the pinned cursor %v, want %v", rest, want)
	}
}

func TestRankCursors(t *testing.T) {
	ks := catalog()
	first := walk(t, ks, ListQuery{Sort: SortName, Limit: 50}, full)
	for _, bad := range []string{
		"!!!",
		// The database path's own cursor (v2): another tie-break, so the first page.
		base64.RawURLEncoding.EncodeToString([]byte("v2\x1fcharlie\x1fapl_01")),
		base64.RawURLEncoding.EncodeToString([]byte("rm1\x1fonly-two")),
	} {
		if got := walk(t, ks, ListQuery{Sort: SortName, Limit: 50, Cursor: bad}, full); !slices.Equal(got, first) {
			t.Errorf("cursor %q: %v, want the first page %v", bad, got, first)
		}
	}
	// An out-of-range mean is dropped for the fresh one, as decodeListingCursor does.
	if c := decodeCursor(EncodeCursor("k", "s", ptr(1.5))); !c.ok || c.mean != nil {
		t.Errorf("mean 1.5 kept: %+v", c)
	}
	if c := decodeCursor(EncodeCursor("k", "s", ptr(0.25))); c.mean == nil || *c.mean != 0.25 {
		t.Errorf("mean 0.25 lost: %+v", c)
	}
}

// The cursor format as literals: the web tier's shadow builds this service's cursor from a database
// cursor (readModelCursor, app-listings-read-model-shadow.service.ts) and its test pins the same two
// strings, so a format change on either side fails a test.
func TestCursorVector(t *testing.T) {
	for _, c := range []struct {
		key, slug string
		mean      *float64
		want      string
	}{
		{"00000700000000000000000000120", "paint", ptr(0.625), "cm0xHzAwMDAwNzAwMDAwMDAwMDAwMDAwMDAwMDAwMTIwH3BhaW50HzAuNjI1"},
		{"paint", "paint", nil, "cm0xH3BhaW50H3BhaW50"},
	} {
		if got := EncodeCursor(c.key, c.slug, c.mean); got != c.want {
			t.Errorf("EncodeCursor(%q, %q): %s, want %s", c.key, c.slug, got, c.want)
		}
		if d := decodeCursor(c.want); !d.ok || d.key != c.key || d.slug != c.slug {
			t.Errorf("decodeCursor(%s): %+v", c.want, d)
		}
	}
}

func ptr(f float64) *float64 { return &f }

func TestRankFilters(t *testing.T) {
	ks := catalog()
	ks[0].CreatorID = n(7)
	ks[2].CreatorID = n(7)
	ks[2].Category = "tools"
	for _, c := range []struct {
		name string
		q    ListQuery
		v    Viewer
		want []string
	}{
		{"SFW host hides r and x", ListQuery{}, full, []string{"alpha", "bravo", "charlie", "echo", "foxtrot"}},
		{"red X viewer sees r and x", ListQuery{}, Viewer{RedCapable: true, BrowsingLevel: 15, Scope: ScopeFull},
			[]string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"}},
		{"red R viewer sees r, not x", ListQuery{}, Viewer{RedCapable: true, BrowsingLevel: 7, Scope: ScopeFull},
			[]string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot"}},
		{"main X viewer sees no mature listing", ListQuery{}, Viewer{BrowsingLevel: 15, Scope: ScopeFull},
			[]string{"alpha", "bravo", "charlie", "echo", "foxtrot"}},
		{"public-external is off-site only", ListQuery{}, Viewer{Scope: ScopePublicExternal}, []string{"charlie", "foxtrot"}},
		{"scope none is empty", ListQuery{}, Viewer{Scope: ScopeNone}, nil},
		{"an unknown scope is none", ListQuery{}, Viewer{Scope: "all"}, nil},
		{"kind", ListQuery{Kind: "offsite"}, full, []string{"charlie", "foxtrot"}},
		{"category", ListQuery{Category: "tools"}, full, []string{"charlie"}},
		{"developer", ListQuery{UserID: n(7)}, full, []string{"alpha", "charlie"}},
	} {
		c.q.Sort, c.q.Limit = SortName, 50
		if got := walk(t, ks, c.q, c.v); !slices.Equal(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}
