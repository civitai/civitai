package feed

import (
	"context"
	"errors"
	"net/url"
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

// lastGoodUncacheable is lastGoodKey (feed-primary-degrade.ts) returning undefined: a signed-in viewer
// (on its own, whatever the query), or a query with cursor, offset, before or viewerId. A query that
// does not parse reads as cacheable (the fallback is kept).
func TestLastGoodUncacheable(t *testing.T) {
	first := "levels=1&excludedTags=9901&sort=reactions&limit=2"
	cases := []struct {
		viewer int
		query  string
		want   bool
	}{
		{0, first, false},
		{5, first, true},
		{0, first + "&cursor=1%7C2", true},
		{0, first + "&offset=40", true},
		{0, "levels=1&sort=newest&limit=2&before=1700000000", true},
		{0, first + "&viewerId=5", true},
		{0, "levels=1&cursorx=1&offsets=2&limit=2", false},
		{0, "levels=%zz&cursor=1", false},
	}
	for _, c := range cases {
		if got := lastGoodUncacheable(Viewer{ID: c.viewer}, c.query); got != c.want {
			t.Errorf("viewer %d, %q: %v, want %v", c.viewer, c.query, got, c.want)
		}
	}
}
