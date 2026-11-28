package feed

import (
	"context"
	"errors"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
)

// The outcomes of the image.getInfinite feed-call retry (feed_go_feed_retry_total{outcome}).
const (
	// RetryRecovered: the second call answered 200 (the page is then computed from it; the request can
	// still end past its budget, the `deadline` fallback).
	RetryRecovered = "recovered"
	// RetryFailed: the second call failed as the first did (a failed call or a 5xx), so the request
	// is the app's 503 (UnavailableError).
	RetryFailed = "failed"
	// RetryOther: the second call ended any other way (a status that is neither 200 nor 5xx, or the
	// request's own context ending), handled as that answer always is.
	RetryOther = "other"
	// RetryHandedBack: the request's deadline left less than one full feed call, so there was no
	// second call here: the request is handed back unmarked and the app's own call is the retry.
	RetryHandedBack = "handed_back"
)

// RetryOutcomes is every outcome of the retry, in a fixed order (the series are seeded).
var RetryOutcomes = []string{RetryRecovered, RetryFailed, RetryOther, RetryHandedBack}

type feedRetryKey struct{}

// WithFeedRetry turns on the feed-call retry for computes under ctx: an image.getInfinite feed call
// that fails as the app's 503 (UnavailableError) is made once more before that 503 is answered.
// observe is told each retry's outcome (one of RetryOutcomes).
//
// Why: handed back, the request makes the Node app call the feed itself (serveFromFeed, one call
// with its own 5 s FEED_PRIMARY_TIMEOUT_MS), so each request gets two calls, this service's and the
// app's. Node's serveFromFeed has no retry of its own; the hand-back is the second call. A route
// that answers the 503 here (server.Server.AnswerInfiniteFeedUnavailable) would remove it, so it
// sets this to make the second call itself. Only that route sets it: off, the hand-back already
// gives the second call, and a retry here would make a third.
func WithFeedRetry(ctx context.Context, observe func(outcome string)) context.Context {
	if observe == nil {
		observe = func(string) {}
	}
	return context.WithValue(ctx, feedRetryKey{}, observe)
}

func feedRetryFrom(ctx context.Context) (func(string), bool) {
	observe, ok := ctx.Value(feedRetryKey{}).(func(string))
	return observe, ok
}

// attemptTimeout is the time one feed call may take: the fetcher's own (feedsvc.Client.AttemptTimeout),
// else feedsvc.Timeout (FEED_PRIMARY_TIMEOUT_MS).
func attemptTimeout(f FeedFetcher) time.Duration {
	if t, ok := f.(interface{ AttemptTimeout() time.Duration }); ok {
		return t.AttemptTimeout()
	}
	return feedsvc.Timeout
}

// fetchInfiniteFeed is image.getInfinite's feed call (fetchInfiniteFeedOnce), retried once when ctx
// carries WithFeedRetry and the first call failed as the app's 503 (UnavailableError: a failed call
// or a 5xx, on a page no last-good copy can answer). The second call is the one the app would make
// after a hand-back: the same query at once (a GET, no delay), with a whole call's time. If the
// request's deadline leaves less than that, nothing is retried here and the first failure is
// returned unmarked, so the request is handed back and the app's call is the retry. Every other
// first result (an answer, a refusal status, an unmarked failure, the request ending) is returned as
// it was, without a second call.
func fetchInfiniteFeed(ctx context.Context, f FeedFetcher, query string, viewer Viewer) (feedsvc.Answer, error) {
	ans, err := fetchInfiniteFeedOnce(ctx, f, query, viewer)
	var unavailable *UnavailableError
	if err == nil || !errors.As(err, &unavailable) {
		return ans, err
	}
	observe, on := feedRetryFrom(ctx)
	if !on {
		return ans, err
	}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < attemptTimeout(f) {
		observe(RetryHandedBack)
		return ans, unavailable.Fallback
	}
	ans, err = fetchInfiniteFeedOnce(ctx, f, query, viewer)
	switch {
	case err == nil:
		observe(RetryRecovered)
	case IsUnavailable(err):
		observe(RetryFailed)
	default:
		observe(RetryOther)
	}
	return ans, err
}

// fetchInfiniteFeedOnce is one feed call with serveFromFeed's reading of its result: a 200 answer;
// the request's own context error when it ended first; a failed call (Node's `timeout` / `error`) or
// a 5xx (`status:5xx`) as the `feed-unavailable` / `feed-status` fallback, marked as the app's 503
// when no last-good page can answer it (nodeUnavailable); any other status as the plain
// `feed-status` fallback (Node's empty page).
func fetchInfiniteFeedOnce(ctx context.Context, f FeedFetcher, query string, viewer Viewer) (feedsvc.Answer, error) {
	ans, err := f.Fetch(ctx, query)
	if err != nil {
		if ctx.Err() != nil {
			return feedsvc.Answer{}, ctx.Err()
		}
		return feedsvc.Answer{}, nodeUnavailable(fallback.Wrap("feed-unavailable", err), viewer, query)
	}
	if ans.Status != 200 {
		status := fallback.Safef("feed-status", "%d", ans.Status)
		if ans.Status >= 500 && ans.Status <= 599 {
			return feedsvc.Answer{}, nodeUnavailable(status, viewer, query)
		}
		return feedsvc.Answer{}, status
	}
	return ans, nil
}
