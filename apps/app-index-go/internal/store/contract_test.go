package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
)

// testStore is a Store whose commit can be failed.
type testStore interface {
	Store
	setFailBeforeCommit(func(op string) error)
}

const schemaURN = "urn:schema:apps.civitai.com:app@v1"

func urnOf(slug string) string { return "urn:apps.civitai.com:app/" + slug }

type fixture struct {
	slug, name, kind, category, tagline, creator string
}

func (f fixture) app() App {
	body, _ := json.Marshal(map[string]any{"slug": f.slug, "name": f.name, "kind": f.kind, "contentRating": "g",
		"category": f.category, "tagline": f.tagline, "creator": f.creator})
	a, err := AppFromEntity(urnOf(f.slug), "rev-"+f.slug, body)
	if err != nil {
		panic(err)
	}
	return a
}

func upsert(f fixture, cursor string) Change {
	return Change{Kind: ChangeUpsert, App: f.app(), Cursor: cursor}
}

func mustApply(t *testing.T, s Generations, gen int64, cs ...Change) {
	t.Helper()
	for _, c := range cs {
		if err := s.Apply(t.Context(), gen, c); err != nil {
			t.Fatalf("apply %+v: %v", c, err)
		}
	}
}

func mustLive(t *testing.T, s Generations, gen int64, cursor string) bool {
	t.Helper()
	p, err := s.Live(t.Context(), gen, cursor)
	if err != nil {
		t.Fatalf("live: %v", err)
	}
	return p
}

func mustBuilding(t *testing.T, s Generations) Generation {
	t.Helper()
	g, err := s.NewBuilding(t.Context(), schemaURN, 1)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func mustState(t *testing.T, s Generations) State {
	t.Helper()
	st, err := s.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return st
}

// slugs searches and returns the result slugs in order.
func slugs(t *testing.T, s Store, q Query) []string {
	t.Helper()
	if q.Limit == 0 {
		q.Limit = 50
	}
	p, err := s.Search(t.Context(), q)
	if err != nil {
		t.Fatalf("search %+v: %v", q, err)
	}
	out := make([]string, 0, len(p.Results))
	for _, r := range p.Results {
		out = append(out, r.Slug)
	}
	return out
}

// ratedCatalog is one app per rating class, ratings in mixed case as the stream may send them.
var ratedCatalog = []struct{ slug, rating string }{
	{"m1-r", "r"},
	{"m2-x", "X"},
	{"m3-xxx", "xxx"},
	{"m4-unknown", "mystery"},
	{"m5-none", ""},
	{"s1-g", "g"},
	{"s2-pg", "PG"},
	{"s3-pg13", "pg13"},
	{"s4-pg-13", "pg-13"},
}

// ratedApp is an app named its slug, rated rating ("" sends a null contentRating).
func ratedApp(slug, rating string) App {
	var r any
	if rating != "" {
		r = rating
	}
	body, _ := json.Marshal(map[string]any{"slug": slug, "name": slug, "kind": "onsite", "contentRating": r})
	a, err := AppFromEntity(urnOf(slug), "rev-"+slug, body)
	if err != nil {
		panic(err)
	}
	return a
}

// noField leaves listingContentRating out of a listedApp body (an adapter that predates it).
const noField = "<absent>"

// listedApp is an app named its slug whose entity is rated appRating and whose listing is rated
// listingRating: nil sends listingContentRating null, noField leaves it out of the body.
func listedApp(slug, appRating string, listingRating any) App {
	m := map[string]any{"slug": slug, "name": slug, "kind": "onsite", "contentRating": appRating}
	if listingRating != noField {
		m["listingContentRating"] = listingRating
	}
	body, _ := json.Marshal(m)
	a, err := AppFromEntity(urnOf(slug), "rev-"+slug, body)
	if err != nil {
		panic(err)
	}
	return a
}

// listedCatalog: what the adapter publishes for an app whose listing has no known rating, so that
// its app entity's contentRating fell back to the block's (b1-b3), beside listings rated mature
// (a1, a2), and bodies without the field (a3, b4), which fall back to the app's rating. a2's app
// rating admits what its listing rating does not, so a filter on the app rating, or on the laxer
// of the two, answers it wrongly; a3 and b4 catch a filter on the listing rating alone, which
// reads an absent field as unrated. Every hidden row sorts before every shown one, so a filter
// applied after the limit would leave a short page.
var listedCatalog = []struct {
	slug, appRating string
	listingRating   any
}{
	{"a1-listing-x", "x", "x"},
	{"a2-listing-r-app-g", "g", "r"},
	{"a3-no-field-x", "x", noField},
	{"b1-listing-null-block-x", "x", nil},
	{"b2-listing-unknown-block-x", "X", "mystery"},
	{"b3-listing-pg-13-block-r", "r", "pg-13"},
	{"b4-no-field-g", "g", noField},
}

var catalog = []fixture{
	{"pixel-forge", "Pixel Forge", "onsite", "generation", "Make pixel art from prompts", "ana"},
	{"alpha-chat", "Alpha Chat", "offsite", "chat", "Talk to characters", "bo"},
	{"beta-paint", "beta Paint", "onsite", "generation", "Paint with brushes", "ana"},
	{"gamma-tools", "Gamma Tools", "onsite", "utility", "Batch tools for pixel workflows", "cy"},
	{"delta-quiz", "Delta Quiz", "offsite", "game", "Daily quiz", "dee"},
	{"echo-music", "Echo Music", "onsite", "audio", "Generate loops", "pixelsmith"},
	{"zeta-zine", "Zeta Zine", "offsite", "generation", "Magazine layouts", "eve"},
}

func runContract(t *testing.T, newStore func(t *testing.T) testStore) {
	t.Run("NotReadyUntilLive", func(t *testing.T) {
		s := newStore(t)
		if _, err := s.Search(t.Context(), Query{}); !errors.Is(err, ErrNotReady) {
			t.Fatalf("empty store: search err %v, want ErrNotReady", err)
		}
		g := mustBuilding(t, s)
		mustApply(t, s, g.ID, upsert(catalog[0], ""), upsert(catalog[1], ""))
		if _, err := s.Search(t.Context(), Query{}); !errors.Is(err, ErrNotReady) {
			t.Fatalf("building generation answered a search before its Live: err %v", err)
		}
		st := mustState(t, s)
		if st.Serving != nil || st.Building == nil || st.Building.ID != g.ID {
			t.Fatalf("state %+v", st)
		}
		if !mustLive(t, s, g.ID, "L1") {
			t.Fatal("first Live did not promote the building generation")
		}
		if got := slugs(t, s, Query{}); !slices.Equal(got, []string{"alpha-chat", "pixel-forge"}) {
			t.Fatalf("after Live: %v", got)
		}
		st = mustState(t, s)
		if st.Building != nil || st.Serving == nil || st.Serving.ID != g.ID || st.Serving.Cursor != "L1" {
			t.Fatalf("after Live: state %+v", st)
		}
		if mustLive(t, s, g.ID, "L2") {
			t.Fatal("a second Live promoted again")
		}
		if st := mustState(t, s); st.Serving.Cursor != "L2" {
			t.Fatalf("second Live cursor %q", st.Serving.Cursor)
		}
	})

	// The guarantee: a change and its cursor commit together. A transaction that fails before its
	// commit leaves neither the row change nor the cursor behind.
	t.Run("CursorCommitsWithItsChange", func(t *testing.T) {
		s := newStore(t)
		g := mustBuilding(t, s)
		mustApply(t, s, g.ID, upsert(catalog[0], "c1"))
		mustLive(t, s, g.ID, "L1")
		crash := errors.New("crash before commit")
		s.setFailBeforeCommit(func(op string) error {
			if op == "apply" {
				return crash
			}
			return nil
		})
		if err := s.Apply(t.Context(), g.ID, upsert(catalog[1], "c2")); !errors.Is(err, crash) {
			t.Fatalf("apply err %v, want the injected crash", err)
		}
		if err := s.Apply(t.Context(), g.ID, Change{Kind: ChangeDelete, URN: urnOf(catalog[0].slug), Cursor: "c3"}); !errors.Is(err, crash) {
			t.Fatalf("delete err %v, want the injected crash", err)
		}
		s.setFailBeforeCommit(nil)
		if got := slugs(t, s, Query{}); !slices.Equal(got, []string{"pixel-forge"}) {
			t.Fatalf("row change survived its failed transaction: index holds %v, want [pixel-forge]", got)
		}
		if c := mustState(t, s).Serving.Cursor; c != "L1" {
			t.Fatalf("cursor moved to %q though its transaction failed, want L1", c)
		}
		// And a committed change moves both.
		mustApply(t, s, g.ID, upsert(catalog[1], "c4"))
		if got := slugs(t, s, Query{}); !slices.Equal(got, []string{"alpha-chat", "pixel-forge"}) {
			t.Fatalf("after commit: %v", got)
		}
		if c := mustState(t, s).Serving.Cursor; c != "c4" {
			t.Fatalf("cursor %q after a committed change, want c4", c)
		}
	})

	t.Run("LiveCommitsAtomically", func(t *testing.T) {
		s := newStore(t)
		old := mustBuilding(t, s)
		mustApply(t, s, old.ID, upsert(catalog[0], "c1"))
		mustLive(t, s, old.ID, "L1")
		g := mustBuilding(t, s)
		mustApply(t, s, g.ID, upsert(catalog[1], ""))
		s.setFailBeforeCommit(func(op string) error {
			if op == "live" {
				return errors.New("crash")
			}
			return nil
		})
		if _, err := s.Live(t.Context(), g.ID, "L2"); err == nil {
			t.Fatal("live with a failing commit succeeded")
		}
		s.setFailBeforeCommit(nil)
		st := mustState(t, s)
		if st.Serving == nil || st.Serving.ID != old.ID || st.Serving.Cursor != "L1" || st.Building == nil || st.Building.Cursor != "" {
			t.Fatalf("failed Live changed the state: %+v / %+v", st.Serving, st.Building)
		}
	})

	t.Run("UpsertReplacesTheWholeRow", func(t *testing.T) {
		s := newStore(t)
		g := mustBuilding(t, s)
		f := catalog[0]
		mustApply(t, s, g.ID, upsert(f, ""))
		f.tagline, f.category = "", ""
		mustApply(t, s, g.ID, upsert(f, ""), upsert(f, "")) // twice: harmless
		mustLive(t, s, g.ID, "L")
		p, err := s.Search(t.Context(), Query{})
		if err != nil || len(p.Results) != 1 {
			t.Fatalf("got %+v %v", p, err)
		}
		if r := p.Results[0]; r.Tagline != "" || r.Category != "" || r.Name != "Pixel Forge" {
			t.Fatalf("row kept old fields: %+v", r)
		}
	})

	t.Run("DeleteAndProgress", func(t *testing.T) {
		s := newStore(t)
		g := mustBuilding(t, s)
		mustApply(t, s, g.ID, upsert(catalog[0], ""), upsert(catalog[1], ""))
		mustLive(t, s, g.ID, "L")
		mustApply(t, s, g.ID,
			Change{Kind: ChangeDelete, URN: urnOf(catalog[0].slug), Cursor: "d1"},
			Change{Kind: ChangeDelete, URN: urnOf("never-seen"), Cursor: "d2"},
			Change{Kind: ChangeProgress, Cursor: "p3"})
		if got := slugs(t, s, Query{}); !slices.Equal(got, []string{"alpha-chat"}) {
			t.Fatalf("after delete: %v", got)
		}
		if c := mustState(t, s).Serving.Cursor; c != "p3" {
			t.Fatalf("cursor %q, want p3", c)
		}
	})

	t.Run("RebuildBeside", func(t *testing.T) {
		s := newStore(t)
		old := mustBuilding(t, s)
		mustApply(t, s, old.ID, upsert(catalog[0], ""), upsert(catalog[1], ""))
		mustLive(t, s, old.ID, "L1")
		g := mustBuilding(t, s)
		renamed := catalog[0]
		renamed.name = "Pixel Forge Two"
		mustApply(t, s, g.ID, upsert(renamed, ""), upsert(catalog[2], ""))
		// The old generation keeps answering while the new one builds.
		if got := slugs(t, s, Query{}); !slices.Equal(got, []string{"alpha-chat", "pixel-forge"}) {
			t.Fatalf("during rebuild: %v", got)
		}
		st := mustState(t, s)
		if st.Serving.ID != old.ID || st.Building.ID != g.ID {
			t.Fatalf("during rebuild: state %+v %+v", st.Serving, st.Building)
		}
		if !mustLive(t, s, g.ID, "L2") {
			t.Fatal("rebuild did not switch over at Live")
		}
		if got := slugs(t, s, Query{}); !slices.Equal(got, []string{"beta-paint", "pixel-forge"}) {
			t.Fatalf("after switch: %v", got)
		}
		p, _ := s.Search(t.Context(), Query{Text: "two"})
		if len(p.Results) != 1 || p.Results[0].Name != "Pixel Forge Two" {
			t.Fatalf("after switch the new body is not served: %+v", p)
		}
		st = mustState(t, s)
		if st.Serving.ID != g.ID || st.Building != nil || st.Serving.Cursor != "L2" {
			t.Fatalf("after switch: state %+v %+v", st.Serving, st.Building)
		}
		if err := s.Apply(t.Context(), old.ID, Change{Kind: ChangeProgress, Cursor: "x"}); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("old generation still writable: %v", err)
		}
	})

	t.Run("NewBuildingReplacesBuilding", func(t *testing.T) {
		s := newStore(t)
		a := mustBuilding(t, s)
		mustApply(t, s, a.ID, upsert(catalog[0], "c1"))
		b := mustBuilding(t, s)
		if b.ID == a.ID {
			t.Fatal("same generation id")
		}
		st := mustState(t, s)
		if st.Building == nil || st.Building.ID != b.ID || st.Building.Cursor != "" {
			t.Fatalf("state %+v", st.Building)
		}
		if err := s.Apply(t.Context(), a.ID, Change{Kind: ChangeProgress, Cursor: "x"}); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("replaced generation still writable: %v", err)
		}
	})

	t.Run("Reset", func(t *testing.T) {
		s := newStore(t)
		g := mustBuilding(t, s)
		mustApply(t, s, g.ID, upsert(catalog[0], "c1"))
		if err := s.Reset(t.Context(), g.ID); err != nil {
			t.Fatal(err)
		}
		if c := mustState(t, s).Building.Cursor; c != "" {
			t.Fatalf("cursor %q after reset", c)
		}
		mustLive(t, s, g.ID, "L")
		p, err := s.Search(t.Context(), Query{})
		if err != nil || len(p.Results) != 0 {
			t.Fatalf("rows survived reset: %+v %v", p, err)
		}
	})

	t.Run("SearchFiltersAndText", func(t *testing.T) {
		s := newStore(t)
		g := mustBuilding(t, s)
		for _, f := range catalog {
			mustApply(t, s, g.ID, upsert(f, ""))
		}
		mustLive(t, s, g.ID, "L")
		cases := []struct {
			q    Query
			want []string
		}{
			{Query{}, []string{"alpha-chat", "beta-paint", "delta-quiz", "echo-music", "gamma-tools", "pixel-forge", "zeta-zine"}},
			{Query{Kind: "offsite"}, []string{"alpha-chat", "delta-quiz", "zeta-zine"}},
			{Query{Category: "generation"}, []string{"beta-paint", "pixel-forge", "zeta-zine"}},
			{Query{Kind: "onsite", Category: "generation"}, []string{"beta-paint", "pixel-forge"}},
			// Prefix match on name, tagline and creator words.
			{Query{Text: "pix"}, []string{"echo-music", "gamma-tools", "pixel-forge"}},
			{Query{Text: "PIXEL forge"}, []string{"pixel-forge"}},
			{Query{Text: "quiz"}, []string{"delta-quiz"}},
			{Query{Text: "ana"}, []string{"beta-paint", "pixel-forge"}},
			{Query{Text: "nomatch"}, nil},
			{Query{Text: "!!! ..."}, nil},
			{Query{Text: "pix", Kind: "offsite"}, nil},
		}
		for _, tc := range cases {
			got := slugs(t, s, tc.q)
			if tc.q.Text != "" {
				slices.Sort(got) // relevance order is pinned against Postgres only
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("search %+v = %v, want %v", tc.q, got, tc.want)
			}
		}
	})

	t.Run("SearchLimit", func(t *testing.T) {
		s := newStore(t)
		g := mustBuilding(t, s)
		for _, f := range catalog {
			mustApply(t, s, g.ID, upsert(f, ""))
		}
		mustLive(t, s, g.ID, "L")
		all := slugs(t, s, Query{})
		if len(all) != len(catalog) {
			t.Fatalf("no limit hit: %v", all)
		}
		for _, limit := range []int{1, 3} {
			if got := slugs(t, s, Query{Limit: limit}); !slices.Equal(got, all[:limit]) {
				t.Errorf("limit %d = %v, want the first %d of %v", limit, got, limit, all)
			}
		}
		if got := slugs(t, s, Query{Text: "pix", Limit: 2}); len(got) != 2 {
			t.Errorf("text with limit 2 = %v", got)
		}
	})

	t.Run("SearchMatureRatings", func(t *testing.T) {
		s := newStore(t)
		g := mustBuilding(t, s)
		// The mature ratings sort first by name, so a filter applied after the limit would leave a
		// short page (the limit cases below).
		for _, c := range ratedCatalog {
			mustApply(t, s, g.ID, Change{Kind: ChangeUpsert, App: ratedApp(c.slug, c.rating)})
		}
		mustLive(t, s, g.ID, "L")
		cases := []struct {
			m     Mature
			limit int
			want  []string
		}{
			// Only r, x and xxx are mature (Mature.Admits, the site's matureRatingAllowed): an unknown
			// rating, none, and pg-13 are answered whatever the viewer allows.
			{Mature{}, 0, []string{"m4-unknown", "m5-none", "s1-g", "s2-pg", "s3-pg13", "s4-pg-13"}},
			{Mature{R: true}, 0, []string{"m1-r", "m4-unknown", "m5-none", "s1-g", "s2-pg", "s3-pg13", "s4-pg-13"}},
			{Mature{X: true}, 0, []string{"m2-x", "m4-unknown", "m5-none", "s1-g", "s2-pg", "s3-pg13", "s4-pg-13"}},
			{Mature{XXX: true}, 0, []string{"m3-xxx", "m4-unknown", "m5-none", "s1-g", "s2-pg", "s3-pg13", "s4-pg-13"}},
			{Mature{R: true, X: true}, 0,
				[]string{"m1-r", "m2-x", "m4-unknown", "m5-none", "s1-g", "s2-pg", "s3-pg13", "s4-pg-13"}},
			{Mature{X: true, XXX: true}, 0,
				[]string{"m2-x", "m3-xxx", "m4-unknown", "m5-none", "s1-g", "s2-pg", "s3-pg13", "s4-pg-13"}},
			{Mature{R: true, X: true, XXX: true}, 0,
				[]string{"m1-r", "m2-x", "m3-xxx", "m4-unknown", "m5-none", "s1-g", "s2-pg", "s3-pg13", "s4-pg-13"}},
			// Filtered before the limit: the first three names are all mature.
			{Mature{}, 2, []string{"m4-unknown", "m5-none"}},
			{Mature{X: true}, 2, []string{"m2-x", "m4-unknown"}},
		}
		for _, tc := range cases {
			if got := slugs(t, s, Query{Mature: tc.m, Limit: tc.limit}); !slices.Equal(got, tc.want) {
				t.Errorf("mature %+v limit %d = %v, want %v", tc.m, tc.limit, got, tc.want)
			}
		}
		// Text search filters too.
		if got := slugs(t, s, Query{Text: "m1"}); len(got) != 0 {
			t.Errorf("SFW text search answered %v", got)
		}
		if got := slugs(t, s, Query{Text: "m1", Mature: Mature{R: true}}); !slices.Equal(got, []string{"m1-r"}) {
			t.Errorf("r text search = %v", got)
		}
	})

	// The site's database search filters on the listing's own rating (listingMatureFilter on
	// al.content_rating); search filters on the same one (App.GateRating), not on the app entity's
	// contentRating, which falls back to the block's when the listing has no known rating.
	t.Run("SearchGatesOnListingRating", func(t *testing.T) {
		s := newStore(t)
		g := mustBuilding(t, s)
		for _, c := range listedCatalog {
			mustApply(t, s, g.ID, Change{Kind: ChangeUpsert, App: listedApp(c.slug, c.appRating, c.listingRating)})
		}
		mustLive(t, s, g.ID, "L")
		shown := []string{"b1-listing-null-block-x", "b2-listing-unknown-block-x", "b3-listing-pg-13-block-r", "b4-no-field-g"}
		cases := []struct {
			m     Mature
			limit int
			want  []string
		}{
			{Mature{}, 0, shown},
			{Mature{R: true}, 0, append([]string{"a2-listing-r-app-g"}, shown...)},
			{Mature{X: true}, 0, append([]string{"a1-listing-x", "a3-no-field-x"}, shown...)},
			{Mature{R: true, X: true, XXX: true}, 0,
				append([]string{"a1-listing-x", "a2-listing-r-app-g", "a3-no-field-x"}, shown...)},
			// Filtered before the limit: the first three names are hidden from an SFW viewer, and
			// the first one from an R-only viewer.
			{Mature{}, 2, []string{"b1-listing-null-block-x", "b2-listing-unknown-block-x"}},
			{Mature{R: true}, 2, []string{"a2-listing-r-app-g", "b1-listing-null-block-x"}},
		}
		for _, tc := range cases {
			if got := slugs(t, s, Query{Mature: tc.m, Limit: tc.limit}); !slices.Equal(got, tc.want) {
				t.Errorf("mature %+v limit %d = %v, want %v", tc.m, tc.limit, got, tc.want)
			}
		}
		// Text search filters on it too. Compared as a set: the relevance order is each store's own.
		got := slugs(t, s, Query{Text: "block"})
		slices.Sort(got)
		if !slices.Equal(got, shown[:3]) {
			t.Errorf("SFW text search = %v, want %v", got, shown[:3])
		}
		// The rating answered is still the app entity's: only the filter changed.
		p, err := s.Search(t.Context(), Query{Text: "b1", Limit: 5})
		if err != nil {
			t.Fatal(err)
		}
		if len(p.Results) != 1 || p.Results[0].Rating != "x" {
			t.Errorf("b1 results = %+v, want one rated x", p.Results)
		}
	})

	// An upsert of a URN the generation already holds replaces its listing rating too: a row
	// written from a body without the field (an older adapter) is filtered on the app's rating
	// until the same app arrives with the field, which is how an index deployed before the adapter
	// converges.
	t.Run("UpsertReplacesTheListingRating", func(t *testing.T) {
		s := newStore(t)
		g := mustBuilding(t, s)
		const slug = "b1-listing-null-block-x"
		mustApply(t, s, g.ID, Change{Kind: ChangeUpsert, App: listedApp(slug, "x", noField), Cursor: "c1"})
		mustLive(t, s, g.ID, "L1")
		if got := slugs(t, s, Query{}); len(got) != 0 {
			t.Fatalf("SFW before the field = %v, want none", got)
		}
		mustApply(t, s, g.ID, Change{Kind: ChangeUpsert, App: listedApp(slug, "x", nil), Cursor: "c2"})
		if got := slugs(t, s, Query{}); !slices.Equal(got, []string{slug}) {
			t.Fatalf("SFW after the field = %v, want [%s]", got, slug)
		}
	})

	t.Run("UnknownGeneration", func(t *testing.T) {
		s := newStore(t)
		if err := s.Apply(t.Context(), 999, Change{Kind: ChangeProgress}); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("apply: %v", err)
		}
		if _, err := s.Live(t.Context(), 999, "x"); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("live: %v", err)
		}
		if err := s.Reset(t.Context(), 999); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("reset: %v", err)
		}
		if err := s.Claim(t.Context(), 999); !errors.Is(err, ErrNoGeneration) {
			t.Fatalf("claim: %v", err)
		}
	})
}

func TestAppFromEntity(t *testing.T) {
	ok := `{"slug":"a","name":"A","kind":"onsite","contentRating":null,"tagline":"t","category":null,"iconUrl":"https://cdn.invalid/i.png","creator":"c","release":"urn:apps.civitai.com:app/a@1.0.0","unknownField":{"x":1}}`
	a, err := AppFromEntity("urn:apps.civitai.com:app/a", "r", json.RawMessage(ok))
	if err != nil {
		t.Fatal(err)
	}
	want := App{URN: "urn:apps.civitai.com:app/a", Rev: "r", Slug: "a", Name: "A", Kind: "onsite", Tagline: "t",
		IconURL: "https://cdn.invalid/i.png", Creator: "c", Release: "urn:apps.civitai.com:app/a@1.0.0"}
	a.Body = nil
	if fmt.Sprint(a) != fmt.Sprint(want) {
		t.Fatalf("got %+v\nwant %+v", a, want)
	}
	for name, body := range map[string]string{
		"not an object":             `[1]`,
		"no slug":                   `{"name":"A","kind":"onsite","contentRating":"g"}`,
		"empty slug":                `{"slug":"","name":"A","kind":"onsite","contentRating":"g"}`,
		"no name":                   `{"slug":"a","kind":"onsite","contentRating":"g"}`,
		"unknown kind":              `{"slug":"a","name":"A","kind":"web","contentRating":"g"}`,
		"no rating":                 `{"slug":"a","name":"A","kind":"onsite"}`,
		"rating not string":         `{"slug":"a","name":"A","kind":"onsite","contentRating":3}`,
		"tagline object":            `{"slug":"a","name":"A","kind":"onsite","contentRating":"g","tagline":{}}`,
		"listing rating not string": `{"slug":"a","name":"A","kind":"onsite","contentRating":"g","listingContentRating":4}`,
	} {
		if _, err := AppFromEntity("u", "r", json.RawMessage(body)); err == nil {
			t.Errorf("%s: accepted %s", name, body)
		}
	}
}

// TestListingRating pins what AppFromEntity reads of listingContentRating and which rating
// GateRating answers: the listing's when the body carries the field (null included), else the app's.
func TestListingRating(t *testing.T) {
	for _, c := range []struct {
		name          string
		listingRating any
		rated         bool
		gate          string
	}{
		{"absent", noField, false, "x"},
		{"null", nil, true, ""},
		{"unknown", "mystery", true, "mystery"},
		{"pg-13", "pg-13", true, "pg-13"},
		{"r", "r", true, "r"},
	} {
		a := listedApp("a", "x", c.listingRating)
		if a.ListingRated != c.rated || a.GateRating() != c.gate || a.Rating != "x" {
			t.Errorf("%s: rated %v gate %q rating %q, want %v %q \"x\"", c.name, a.ListingRated, a.GateRating(),
				a.Rating, c.rated, c.gate)
		}
	}
}

// TestMatureAdmits pins Mature.Admits to the site's matureRatingAllowed (app-listing-store-gate.ts)
// rating by rating: only r, x and xxx in any case are mature; pg-13, an unknown rating and none are
// admitted to every viewer, the SFW one included.
func TestMatureAdmits(t *testing.T) {
	none := Mature{}
	rOnly := Mature{R: true}
	xOnly := Mature{X: true}
	xxxOnly := Mature{XXX: true}
	all := Mature{R: true, X: true, XXX: true}
	for _, c := range []struct {
		rating                      string
		none, rOnly, xOnly, xxxOnly bool
	}{
		{"", true, true, true, true},
		{"mystery", true, true, true, true},
		{"g", true, true, true, true},
		{"PG", true, true, true, true},
		{"pg13", true, true, true, true},
		{"pg-13", true, true, true, true},
		{"PG-13", true, true, true, true},
		{"r", false, true, false, false},
		{"R", false, true, false, false},
		{"x", false, false, true, false},
		{"X", false, false, true, false},
		{"xxx", false, false, false, true},
		{"XXX", false, false, false, true},
		// Not trimmed, as the site does not trim: " r" is not the rating r.
		{" r", true, true, true, true},
	} {
		for _, v := range []struct {
			name string
			m    Mature
			want bool
		}{
			{"none", none, c.none}, {"r", rOnly, c.rOnly}, {"x", xOnly, c.xOnly}, {"xxx", xxxOnly, c.xxxOnly},
			{"all", all, true},
		} {
			if got := v.m.Admits(c.rating); got != v.want {
				t.Errorf("Mature %s admits %q = %v, want %v", v.name, c.rating, got, v.want)
			}
		}
	}
}

func TestTokens(t *testing.T) {
	cases := map[string][]string{
		"":                     nil,
		"  Pixel   forge ":     {"pixel", "forge"},
		"pixel pixel":          {"pixel"},
		"a&b|c:*!d'e":          {"a", "b", "c", "d", "e"},
		"日本語 テスト":              {"日本語", "テスト"},
		"1 2 3 4 5 6 7 8 9 10": {"1", "2", "3", "4", "5", "6", "7", "8"},
	}
	for in, want := range cases {
		if got := Tokens(in); !slices.Equal(got, want) {
			t.Errorf("Tokens(%q) = %q, want %q", in, got, want)
		}
	}
	if got := prefixTSQuery([]string{"a", "b"}); got != "a:* & b:*" {
		t.Fatalf("prefixTSQuery = %q", got)
	}
}
