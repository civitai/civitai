package feed

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
)

// statusFeed answers every query with err, else with status and no ids, and records the queries.
type statusFeed struct {
	status  int
	err     error
	queries []string
}

func (f *statusFeed) Fetch(_ context.Context, query string) (feedsvc.Answer, error) {
	f.queries = append(f.queries, query)
	if f.err != nil {
		return feedsvc.Answer{}, f.err
	}
	return feedsvc.Answer{Status: f.status}, nil
}

// A failed feed call on image.getInfinite is marked as the app's 503 (UnavailableError) exactly when
// the app answers it with that 503 whatever feed-service-degrade says: a transport error or a 5xx
// (500..599), for a signed-in viewer or a paged query (lastGoodKey undefined). An anonymous first
// page, a 4xx and a status past 599 stay plain fallbacks. Either way the fallback reason is the one
// the request was handed back with before (`feed-unavailable` / `feed-status`), so with the server's
// switch off nothing changes.
func TestServeInfiniteMarksNodes503FeedFailures(t *testing.T) {
	down := errors.New("dial tcp: connection refused")
	cases := []struct {
		name       string
		m          map[string]any
		viewer     *Viewer
		feed       statusFeed
		wantReason string
		wantMarked bool
		wantParam  string // a param the feed query must carry, as the positive control of the case
	}{
		{"anonymous first page, call failed", nil, nil, statusFeed{err: down}, "feed-unavailable", false, ""},
		{"anonymous first page, 503", nil, nil, statusFeed{status: 503}, "feed-status", false, ""},
		{"anonymous next page, call failed", map[string]any{"cursor": "feed:1:2"}, nil, statusFeed{err: down}, "feed-unavailable", true, "cursor"},
		{"anonymous next page, 500", map[string]any{"cursor": "feed:1:2"}, nil, statusFeed{status: 500}, "feed-status", true, "cursor"},
		{"signed in, call failed", nil, &Viewer{ID: 5}, statusFeed{err: down}, "feed-unavailable", true, "viewerId"},
		{"signed in, 503", nil, &Viewer{ID: 5}, statusFeed{status: 503}, "feed-status", true, "viewerId"},
		{"signed in, 599", nil, &Viewer{ID: 5}, statusFeed{status: 599}, "feed-status", true, ""},
		{"signed in, 400: the app's empty page", nil, &Viewer{ID: 5}, statusFeed{status: 400}, "feed-status", false, ""},
		{"signed in, 499", nil, &Viewer{ID: 5}, statusFeed{status: 499}, "feed-status", false, ""},
		{"signed in, 600: not ^status:5\\d\\d$", nil, &Viewer{ID: 5}, statusFeed{status: 600}, "feed-status", false, ""},
		{"signed in, 204: the app's empty page", nil, &Viewer{ID: 5}, statusFeed{status: 204}, "feed-status", false, ""},
	}
	for _, c := range cases {
		f := newInfFixture(t)
		sf := c.feed
		f.deps.Feed = &sf
		m := c.m
		if m == nil {
			m = map[string]any{}
		}
		_, _, _, err := serveInf(t, f, m, InfiniteRequest{Cap: 1, Viewer: c.viewer})
		if len(sf.queries) != 1 {
			t.Fatalf("%s: feed called %d times, want 1 (the case must reach the feed call)", c.name, len(sf.queries))
		}
		if c.wantParam != "" {
			if q, _ := url.ParseQuery(sf.queries[0]); !q.Has(c.wantParam) {
				t.Fatalf("%s: feed query %q has no %s", c.name, sf.queries[0], c.wantParam)
			}
		}
		if got := fallback.Reason(err); got != c.wantReason {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.wantReason)
		}
		if got := IsUnavailable(err); got != c.wantMarked {
			t.Errorf("%s: IsUnavailable = %v, want %v", c.name, got, c.wantMarked)
		}
	}
}

// The mark keeps the fallback's loggable detail: the error's class for a failed call, the status for
// a 5xx, as before.
func TestUnavailableErrorKeepsTheFallbackDetail(t *testing.T) {
	err := &UnavailableError{Fallback: fallback.Safef("feed-status", "%d", 502)}
	if fallback.Reason(err) != "feed-status" || fallback.SafeDetail(err) != "502" || err.Error() != "fallback: feed-status (502)" {
		t.Fatalf("reason %q detail %q text %q, want feed-status, 502, fallback: feed-status (502)",
			fallback.Reason(err), fallback.SafeDetail(err), err.Error())
	}
	if IsUnavailable(fallback.New("feed-unavailable")) || IsUnavailable(nil) {
		t.Fatal("a plain fallback (or nil) reads as marked")
	}
}

// lastGoodKeyFixture is testdata/last-good-key.json: the (viewer, feed query) cases that do and do not
// have a saved last-good page in the Node app, shared with the app's test of lastGoodKey
// (src/server/services/__tests__/feed-primary-degrade-last-good-key.test.ts).
type lastGoodKeyFixture struct {
	UncacheableParams []string `json:"uncacheableParams"`
	Cases             []struct {
		Name          string `json:"name"`
		CurrentUserID *int   `json:"currentUserId"`
		Query         string `json:"query"`
		LastGood      bool   `json:"lastGood"`
	} `json:"cases"`
}

// lastGoodUncacheable is lastGoodKey (feed-primary-degrade.ts) returning undefined, case for case on
// the fixture the app's own lastGoodKey test reads, so a change to the condition on either side fails
// one of the two: a signed-in viewer (on its own, whatever the query), or a query with cursor,
// offset, before or viewerId. Guard, not regression coverage: it pins the two copies together.
func TestLastGoodUncacheableMatchesNodesLastGoodKey(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "last-good-key.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx lastGoodKeyFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(lastGoodPagingParams, fx.UncacheableParams) {
		t.Errorf("lastGoodPagingParams %v, fixture uncacheableParams %v", lastGoodPagingParams, fx.UncacheableParams)
	}
	// Positive control: the fixture has cases on both sides, a signed-in one and every param alone.
	var cacheable, uncacheable, signedIn int
	for _, c := range fx.Cases {
		id := 0
		if c.CurrentUserID != nil {
			id = *c.CurrentUserID
		}
		if id != 0 {
			signedIn++
		}
		if c.LastGood {
			cacheable++
		} else {
			uncacheable++
		}
		if got := lastGoodUncacheable(Viewer{ID: id}, c.Query); got != !c.LastGood {
			t.Errorf("%s (viewer %d, %q): uncacheable %v, want %v (lastGood %v)", c.Name, id, c.Query, got, !c.LastGood, c.LastGood)
		}
	}
	if cacheable < 3 || uncacheable < 5 || signedIn < 2 {
		t.Fatalf("fixture has %d cacheable, %d uncacheable, %d signed-in cases: too few to pin the condition", cacheable, uncacheable, signedIn)
	}
	for _, p := range fx.UncacheableParams {
		if !lastGoodUncacheable(Viewer{}, "levels=1&"+p+"=1") {
			t.Errorf("an anonymous query with %s alone reads as cacheable", p)
		}
	}
}

// Go only: a query that does not parse reads as cacheable (the fallback is kept). Node's
// URLSearchParams has no parse error, and the feed query Go sends is always well-formed
// (feedsvc.Map), so this case is not in the shared fixture.
func TestLastGoodUncacheableUnparseableQuery(t *testing.T) {
	if lastGoodUncacheable(Viewer{}, "levels=%zz&cursor=1") {
		t.Error("an unparseable query reads as uncacheable, want cacheable")
	}
}
