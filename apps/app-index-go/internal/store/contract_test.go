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
		"not an object":     `[1]`,
		"no slug":           `{"name":"A","kind":"onsite","contentRating":"g"}`,
		"empty slug":        `{"slug":"","name":"A","kind":"onsite","contentRating":"g"}`,
		"no name":           `{"slug":"a","kind":"onsite","contentRating":"g"}`,
		"unknown kind":      `{"slug":"a","name":"A","kind":"web","contentRating":"g"}`,
		"no rating":         `{"slug":"a","name":"A","kind":"onsite"}`,
		"rating not string": `{"slug":"a","name":"A","kind":"onsite","contentRating":3}`,
		"tagline object":    `{"slug":"a","name":"A","kind":"onsite","contentRating":"g","tagline":{}}`,
	} {
		if _, err := AppFromEntity("u", "r", json.RawMessage(body)); err == nil {
			t.Errorf("%s: accepted %s", name, body)
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
