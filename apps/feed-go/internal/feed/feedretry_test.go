package feed

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
)

// scriptFeed answers its calls in order from script (a step with err set fails the call, else it
// answers status with ids), and records the queries. A call past the script fails the test.
type scriptFeed struct {
	t       *testing.T
	script  []scriptStep
	queries []string
	timeout time.Duration // 0: no AttemptTimeout method is consulted (see timedScriptFeed)
}

type scriptStep struct {
	status int
	ids    []int
	err    error
}

func (f *scriptFeed) Fetch(_ context.Context, query string) (feedsvc.Answer, error) {
	f.queries = append(f.queries, query)
	n := len(f.queries)
	if n > len(f.script) {
		f.t.Fatalf("feed called %d times, script has %d steps", n, len(f.script))
	}
	s := f.script[n-1]
	if s.err != nil {
		return feedsvc.Answer{}, s.err
	}
	return feedsvc.Answer{Status: s.status, IDs: s.ids}, nil
}

// timedScriptFeed is a scriptFeed with its own per-call timeout, as feedsvc.Client reports it.
type timedScriptFeed struct{ *scriptFeed }

func (f timedScriptFeed) AttemptTimeout() time.Duration { return f.timeout }

// serveInfCtx is serveInf's ServeInfinite call under ctx, for a signed-in viewer (whose failed feed
// call is the app's 503: lastGoodKey is undefined), returning only the answer and the error.
func serveInfCtx(t *testing.T, ctx context.Context, f *infFixture, fetcher FeedFetcher) (*InfiniteAnswer, error) {
	t.Helper()
	f.deps.Feed = fetcher
	in, err := ParseInfinite(map[string]any{})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return ServeInfinite(ctx, f.deps, InfiniteRequest{Input: in, Cap: 1, Viewer: &Viewer{ID: 5}})
}

var errRefused = errors.New("dial tcp: connection refused")

// With the retry on (WithFeedRetry: the route answers the app's 503 itself), a feed call that fails
// as that 503 is made once more, at once and with the same query, as the app's own call after a
// hand-back would be: a second answer is served (recovered), a second failure is the 503 (failed), and
// a second call that answers neither (a 4xx) is that answer as before (other). A first result that is
// not the 503 (a page, a 4xx, an anonymous first page's unmarked failure) is never retried.
func TestInfiniteFeedRetry(t *testing.T) {
	ok := scriptStep{status: 200}
	down := scriptStep{err: errRefused}
	for _, c := range []struct {
		name         string
		script       []scriptStep
		wantCalls    int
		wantOutcomes []string
		wantReason   string // "" = answered
		wantMarked   bool
	}{
		{"failed call, then a page", []scriptStep{down, ok}, 2, []string{"recovered"}, "", false},
		{"503, then a page", []scriptStep{{status: 503}, ok}, 2, []string{"recovered"}, "", false},
		{"failed call twice", []scriptStep{down, down}, 2, []string{"failed"}, "feed-unavailable", true},
		{"502, then a failed call", []scriptStep{{status: 502}, down}, 2, []string{"failed"}, "feed-unavailable", true},
		{"failed call, then a 500", []scriptStep{down, {status: 500}}, 2, []string{"failed"}, "feed-status", true},
		{"failed call, then a 400", []scriptStep{down, {status: 400}}, 2, []string{"other"}, "feed-status", false},
		{"a page: no retry", []scriptStep{ok}, 1, nil, "", false},
		{"a 400: not retried", []scriptStep{{status: 400}}, 1, nil, "feed-status", false},
		{"a 404: not retried", []scriptStep{{status: 404}}, 1, nil, "feed-status", false},
		{"a 600: not retried", []scriptStep{{status: 600}}, 1, nil, "feed-status", false},
	} {
		f := newInfFixture(t)
		sf := &scriptFeed{t: t, script: c.script}
		var outcomes []string
		ctx := WithFeedRetry(context.Background(), func(o string) { outcomes = append(outcomes, o) })
		ans, err := serveInfCtx(t, ctx, f, sf)
		if len(sf.queries) != c.wantCalls {
			t.Errorf("%s: feed called %d times, want %d", c.name, len(sf.queries), c.wantCalls)
		}
		if len(sf.queries) == 2 && sf.queries[0] != sf.queries[1] {
			t.Errorf("%s: retry query %q differs from the first %q", c.name, sf.queries[1], sf.queries[0])
		}
		if !slices.Equal(outcomes, c.wantOutcomes) {
			t.Errorf("%s: retry outcomes %v, want %v", c.name, outcomes, c.wantOutcomes)
		}
		if got := fallback.Reason(err); got != c.wantReason {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.wantReason)
		}
		if c.wantReason == "" && (err != nil || ans == nil) {
			t.Errorf("%s: answer %v, error %v, want a page", c.name, ans, err)
		}
		if got := IsUnavailable(err); got != c.wantMarked {
			t.Errorf("%s: IsUnavailable = %v, want %v", c.name, got, c.wantMarked)
		}
	}
}

// An anonymous first page's failed call is not the app's 503 (the app may answer it from its
// last-good page): it is handed back unmarked and the app's call is the second one, so it is not
// retried here even with the retry on.
func TestInfiniteFeedRetryNotForAnonymousFirstPage(t *testing.T) {
	f := newInfFixture(t)
	sf := &scriptFeed{t: t, script: []scriptStep{{err: errRefused}, {status: 200}}}
	var outcomes []string
	ctx := WithFeedRetry(context.Background(), func(o string) { outcomes = append(outcomes, o) })
	f.deps.Feed = sf
	in, err := ParseInfinite(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = ServeInfinite(ctx, f.deps, InfiniteRequest{Input: in, Cap: 1})
	if len(sf.queries) != 1 || len(outcomes) != 0 {
		t.Fatalf("feed called %d times, outcomes %v, want 1 call and none", len(sf.queries), outcomes)
	}
	if fallback.Reason(err) != "feed-unavailable" || IsUnavailable(err) {
		t.Fatalf("err %v (marked %v), want the unmarked feed-unavailable fallback", err, IsUnavailable(err))
	}
}

// With the retry off (no WithFeedRetry: the switch is off, or a shadow or probe compute), the failed
// call is made once and returned marked, exactly as before: the hand-back gives the app's call.
func TestInfiniteFeedRetryOff(t *testing.T) {
	f := newInfFixture(t)
	sf := &scriptFeed{t: t, script: []scriptStep{{err: errRefused}, {status: 200}}}
	_, err := serveInfCtx(t, context.Background(), f, sf)
	if len(sf.queries) != 1 {
		t.Fatalf("feed called %d times, want 1", len(sf.queries))
	}
	if fallback.Reason(err) != "feed-unavailable" || !IsUnavailable(err) {
		t.Fatalf("err %v (marked %v), want the marked feed-unavailable fallback", err, IsUnavailable(err))
	}
}

// The retry gets a whole feed call's time, as the app's call after a hand-back does: when the
// request's deadline leaves less than the fetcher's per-call timeout, nothing is retried here and the
// failure is handed back unmarked (handed_back), so the app makes the second call; with at least that
// left, it is retried. The timeout read is the fetcher's own (feedsvc.Client.AttemptTimeout), else
// feedsvc.Timeout (5 s).
func TestInfiniteFeedRetryRespectsTheDeadline(t *testing.T) {
	for _, c := range []struct {
		name         string
		left         time.Duration
		ownTimeout   time.Duration // 0: the fetcher has no AttemptTimeout (feedsvc.Timeout applies)
		wantCalls    int
		wantOutcomes []string
		wantMarked   bool
	}{
		{"3s left, 5s default call: handed back", 3 * time.Second, 0, 1, []string{"handed_back"}, false},
		{"40s left, 5s default call: retried", 40 * time.Second, 0, 2, []string{"failed"}, true},
		{"3s left, 1s own call: retried", 3 * time.Second, time.Second, 2, []string{"failed"}, true},
		{"3s left, 7s own call: handed back", 3 * time.Second, 7 * time.Second, 1, []string{"handed_back"}, false},
	} {
		f := newInfFixture(t)
		sf := &scriptFeed{t: t, script: []scriptStep{{err: errRefused}, {err: errRefused}}, timeout: c.ownTimeout}
		var fetcher FeedFetcher = sf
		if c.ownTimeout != 0 {
			fetcher = timedScriptFeed{sf}
		}
		var outcomes []string
		ctx, cancel := context.WithTimeout(WithFeedRetry(context.Background(), func(o string) { outcomes = append(outcomes, o) }), c.left)
		_, err := serveInfCtx(t, ctx, f, fetcher)
		cancel()
		if len(sf.queries) != c.wantCalls {
			t.Errorf("%s: feed called %d times, want %d", c.name, len(sf.queries), c.wantCalls)
		}
		if !slices.Equal(outcomes, c.wantOutcomes) {
			t.Errorf("%s: retry outcomes %v, want %v", c.name, outcomes, c.wantOutcomes)
		}
		if fallback.Reason(err) != "feed-unavailable" {
			t.Errorf("%s: reason %q (%v), want feed-unavailable", c.name, fallback.Reason(err), err)
		}
		if got := IsUnavailable(err); got != c.wantMarked {
			t.Errorf("%s: IsUnavailable = %v, want %v", c.name, got, c.wantMarked)
		}
	}
}

// The request's own context ending during the second call is that context's error (the `deadline` /
// `canceled` fallback the server makes of it, a hand-back), never the 503: counted as other.
func TestInfiniteFeedRetryContextEnds(t *testing.T) {
	f := newInfFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	var outcomes []string
	ctx = WithFeedRetry(ctx, func(o string) { outcomes = append(outcomes, o) })
	sf := &cancelOnSecond{scriptFeed: scriptFeed{t: t, script: []scriptStep{{err: errRefused}, {err: errRefused}}}, cancel: cancel}
	_, err := serveInfCtx(t, ctx, f, sf)
	defer cancel()
	if len(sf.queries) != 2 || !slices.Equal(outcomes, []string{"other"}) {
		t.Fatalf("feed called %d times, outcomes %v, want 2 and [other]", len(sf.queries), outcomes)
	}
	if !errors.Is(err, context.Canceled) || IsUnavailable(err) {
		t.Fatalf("err %v (marked %v), want context.Canceled, unmarked", err, IsUnavailable(err))
	}
}

// cancelOnSecond cancels the request's context during the second call, before failing it.
type cancelOnSecond struct {
	scriptFeed
	cancel context.CancelFunc
}

func (f *cancelOnSecond) Fetch(ctx context.Context, query string) (feedsvc.Answer, error) {
	if len(f.queries) == 1 {
		f.cancel()
	}
	return f.scriptFeed.Fetch(ctx, query)
}

// feedsvc.Client's per-call timeout, as the retry's deadline check reads it: feedsvc.Timeout unset,
// the client's own when set.
func TestClientAttemptTimeout(t *testing.T) {
	if got := (&feedsvc.Client{}).AttemptTimeout(); got != 5*time.Second {
		t.Errorf("unset: %v, want 5s", got)
	}
	if got := (&feedsvc.Client{Timeout: 1500 * time.Millisecond}).AttemptTimeout(); got != 1500*time.Millisecond {
		t.Errorf("set: %v, want 1.5s", got)
	}
	if got := attemptTimeout(&feedsvc.Client{Timeout: 2 * time.Second}); got != 2*time.Second {
		t.Errorf("attemptTimeout(client 2s) = %v, want 2s", got)
	}
}
