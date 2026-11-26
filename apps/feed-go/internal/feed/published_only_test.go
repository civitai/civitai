package feed

import (
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

var publishedOnlyOn = InfinitePorts{PublishedOnly: true}

// Off (the default), `publishedOnly` falls back as it did before the port, whatever else the input
// says; a falsy value was, and stays, no filter.
func TestPublishedOnlyPortOffFallsBackAsBefore(t *testing.T) {
	for _, input := range []string{
		`{"publishedOnly":true}`,
		`{"publishedOnly":true,"userId":5}`,
		`{"publishedOnly":true,"username":"alice"}`,
	} {
		if _, err := ParseInfiniteWith(parseObj(t, input), InfinitePorts{}); fallback.Reason(err) != "input-publishedOnly" {
			t.Errorf("%s off: %v, want input-publishedOnly", input, err)
		}
		if _, err := ParseInfinite(parseObj(t, input)); fallback.Reason(err) != "input-publishedOnly" {
			t.Errorf("%s via ParseInfinite: %v, want input-publishedOnly", input, err)
		}
	}
	for _, input := range []string{`{"publishedOnly":false}`, `{"publishedOnly":null}`} {
		in, err := ParseInfiniteWith(parseObj(t, input), InfinitePorts{})
		if err != nil || in.PublishedOnly {
			t.Errorf("%s off: %+v, %v, want no filter as before", input, in, err)
		}
	}
	// The gallery still falls back on it.
	if _, err := Parse(parseObj(t, `{"publishedOnly":true}`)); fallback.Reason(err) != "input-publishedOnly" {
		t.Fatalf("gallery Parse: %v", err)
	}
}

// On, a boolean is read as sent; anything else, a null included, is the schema's BAD_REQUEST
// (z.boolean().optional(), not coerced).
func TestParsePublishedOnly(t *testing.T) {
	for input, want := range map[string]bool{
		`{"publishedOnly":true,"userId":5}`: true,
		`{"publishedOnly":false}`:           false,
		`{"userId":5}`:                      false,
	} {
		in, err := ParseInfiniteWith(parseObj(t, input), publishedOnlyOn)
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if in.PublishedOnly != want {
			t.Errorf("%s: PublishedOnly = %v, want %v", input, in.PublishedOnly, want)
		}
	}
	for _, input := range []string{`{"publishedOnly":null}`, `{"publishedOnly":"true"}`, `{"publishedOnly":1}`} {
		if _, err := ParseInfiniteWith(parseObj(t, input), publishedOnlyOn); fallback.Reason(err) != "input-invalid" {
			t.Errorf("%s: %v, want input-invalid", input, err)
		}
	}
	// The port only lifts its own key: every other unported key still falls back.
	if _, err := ParseInfiniteWith(parseObj(t, `{"publishedOnly":true,"scheduled":true}`), publishedOnlyOn); fallback.Reason(err) != "input-scheduled" {
		t.Fatalf("scheduled beside publishedOnly: %v, want input-scheduled", err)
	}
}

// The handler's withdrawal, then requiresImageDbPath: only `publishedOnly` beside the viewer's own
// `userId` routes to Postgres; beside another creator's (or signed out) it is withdrawn; without a
// `userId` (a `username` included) it stays, for the feed mapper to refuse.
func TestPublishedOnlyScopeAndPath(t *testing.T) {
	cases := []struct {
		name     string
		in       InfiniteInput
		viewerID int
		kept     bool
		dbPath   bool
	}{
		{"own userId", InfiniteInput{UserID: 5, PublishedOnly: true}, 5, true, true},
		{"another creator's userId", InfiniteInput{UserID: 6, PublishedOnly: true}, 5, false, false},
		{"a userId signed out", InfiniteInput{UserID: 5, PublishedOnly: true}, 0, false, false},
		{"no userId", InfiniteInput{PublishedOnly: true}, 5, true, false},
		{"the viewer's own username alone", InfiniteInput{Username: "alice", PublishedOnly: true}, 5, true, false},
		{"another creator's userId beside the viewer's name", InfiniteInput{UserID: 6, Username: "alice", PublishedOnly: true}, 5, false, false},
		{"not set, own userId", InfiniteInput{UserID: 5}, 5, false, false},
	}
	for _, c := range cases {
		in := c.in
		got := in.withPublishedOnlyScoped(c.viewerID)
		if got.PublishedOnly != c.kept {
			t.Errorf("%s: kept = %v, want %v", c.name, got.PublishedOnly, c.kept)
		}
		if got.dbPath() != c.dbPath {
			t.Errorf("%s: dbPath = %v, want %v", c.name, got.dbPath(), c.dbPath)
		}
		if in.PublishedOnly != c.in.PublishedOnly {
			t.Errorf("%s: the caller's input was modified", c.name)
		}
		if got.UserID != c.in.UserID || got.Username != c.in.Username {
			t.Errorf("%s: the scope changed: %+v", c.name, got)
		}
	}
}
