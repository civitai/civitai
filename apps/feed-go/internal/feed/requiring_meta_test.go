package feed

import (
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/hydrate"
)

const (
	requiringMetaClause = `i."blockedFor" = $`
	levelGate           = `(i."nsfwLevel" & $`
)

// getAllImagesUncaptured (#9491): `if (!requiringMeta || domain !== 'red')` the level and reviewed
// gates, then `if (requiringMeta) AND.push(i."blockedFor" = 'AiNotVerified')`. Only `requiringMeta`
// on the red domain leaves the gates out; every other domain (and none) keeps them before the clause.
func TestImagesQueryRequiringMetaDomain(t *testing.T) {
	reviewed := hydrate.ImageReviewedSQL("i")
	for _, c := range []struct {
		domain        string
		requiringMeta bool
		gates, clause bool
	}{
		{"red", true, false, true},
		{"green", true, true, true},
		{"blue", true, true, true},
		{"", true, true, true},
		{"red", false, true, false},
		{"green", false, true, false},
	} {
		b := (&ImagesQuery{Limit: 5, BrowsingLevel: 31, RequiringMeta: c.requiringMeta, Domain: c.domain}).Build()
		if got := strings.Contains(b.SQL, levelGate); got != c.gates {
			t.Errorf("domain %q requiringMeta %v: level gate %v, want %v:\n%s", c.domain, c.requiringMeta, got, c.gates, b.SQL)
		}
		if got := strings.Contains(b.SQL, reviewed); got != c.gates {
			t.Errorf("domain %q requiringMeta %v: reviewed gate %v, want %v", c.domain, c.requiringMeta, got, c.gates)
		}
		if got := strings.Contains(b.SQL, requiringMetaClause); got != c.clause {
			t.Errorf("domain %q requiringMeta %v: blockedFor clause %v, want %v", c.domain, c.requiringMeta, got, c.clause)
		}
		if c.clause {
			if v, ok := boundAt(b, `i."blockedFor" = `); !ok || v != "AiNotVerified" {
				t.Errorf("domain %q: the clause binds %v (%v), want AiNotVerified", c.domain, v, ok)
			}
		}
		if c.gates && c.clause && strings.Index(b.SQL, reviewed) > strings.Index(b.SQL, requiringMetaClause) {
			t.Errorf("domain %q: the clause precedes the gates:\n%s", c.domain, b.SQL)
		}
		// The gates' level is bound only where its clause is written.
		if _, ok := boundAt(b, levelGate[:len(levelGate)-1]); ok != c.gates {
			t.Errorf("domain %q requiringMeta %v: level bound %v, want %v", c.domain, c.requiringMeta, ok, c.gates)
		}
	}
	// The pending view keeps its own visibility clause whatever the domain: only the non-pending gates
	// are the ones Node drops.
	p := (&ImagesQuery{Limit: 5, BrowsingLevel: 31, RequiringMeta: true, Domain: "red", Pending: true, IsModerator: true, ViewerID: 4}).Build()
	if !strings.Contains(p.SQL, `((i."nsfwLevel" & $`) || !strings.Contains(p.SQL, `OR i."nsfwLevel" = 0)`) || !strings.Contains(p.SQL, requiringMetaClause) {
		t.Fatalf("a moderator's pending view on red: %s", p.SQL)
	}
}

// requiresImageDbPath: `requiringMeta` beside a `userId` takes the Postgres path (the feed has no
// filter for it); alone, or beside a `username`, it stays on the feed, whose mapper refuses it.
func TestInfiniteRequiringMetaPath(t *testing.T) {
	for _, c := range []struct {
		in   InfiniteInput
		want bool
	}{
		{InfiniteInput{Input: Input{RequiringMeta: true}}, false},
		{InfiniteInput{Input: Input{RequiringMeta: true}, UserID: 5}, true},
		{InfiniteInput{Input: Input{RequiringMeta: true}, Username: "alice"}, false},
		{InfiniteInput{UserID: 5}, false},
	} {
		in := c.in
		if got := in.dbPath(); got != c.want {
			t.Errorf("%+v: dbPath %v, want %v", c.in, got, c.want)
		}
	}
}

// image.getInfinite's Postgres page reads `requiringMeta` and the request's board color: beside a
// `userId` with the index on, no feed call and the clause on the page query; on red without the gates.
// Without a `userId` and the index on it is still the feed's (refused: an empty page, no query); with
// the index off it is the Postgres page's clause too.
func TestServeInfiniteRequiringMeta(t *testing.T) {
	for _, c := range []struct {
		color string
		gates bool
	}{{"blue", true}, {"green", true}, {"red", false}} {
		f := newInfFixture(t)
		f.rows = []RawImage{infRow(31, 700)}
		_, _, _, err := serveInf(t, f, map[string]any{"userId": num("5"), "requiringMeta": true, "limit": num("2")},
			InfiniteRequest{Viewer: &Viewer{ID: 5}, ViewerUsername: "alice", BoardColor: c.color})
		if err != nil {
			t.Fatalf("%s: %v", c.color, err)
		}
		if len(f.feed.queries) != 0 {
			t.Fatalf("%s: requiringMeta beside a userId asked the feed: %v", c.color, f.feed.queries)
		}
		if len(f.sql) != 1 {
			t.Fatalf("%s: %d page queries, want 1", c.color, len(f.sql))
		}
		mustContain(t, f.sql[0], requiringMetaClause, ` AND i."userId" = $`)
		if got := strings.Contains(f.sql[0], levelGate); got != c.gates {
			t.Fatalf("%s: level gate %v, want %v:\n%s", c.color, got, c.gates, f.sql[0])
		}
	}

	f := newInfFixture(t)
	j, _, ans, err := serveInf(t, f, map[string]any{"requiringMeta": true, "limit": num("2")}, InfiniteRequest{Cap: 1, BoardColor: "red"})
	if err != nil {
		t.Fatal(err)
	}
	if len(f.sql) != 0 || len(f.feed.queries) != 0 || len(itemIDs(j)) != 0 || j["source"] != "feed" || !ans.Trivial {
		t.Fatalf("requiringMeta alone on the index: sql %d, feed %v, answer %v", len(f.sql), f.feed.queries, j)
	}

	f = newInfFixture(t)
	f.deps.Config.ImageIndexFeed = false
	if _, _, _, err := serveInf(t, f, map[string]any{"requiringMeta": true, "limit": num("2")}, InfiniteRequest{Cap: 1, BoardColor: "green"}); err != nil {
		t.Fatal(err)
	}
	if len(f.sql) != 1 {
		t.Fatalf("index off: %d page queries, want 1", len(f.sql))
	}
	mustContain(t, f.sql[0], requiringMetaClause, levelGate)
}
