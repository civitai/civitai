package feed

import (
	"errors"
	"net/url"
)

// UnavailableError marks an image.getInfinite feed-service failure the Node app answers with its
// retryable 503 whatever the `feed-service-degrade` flag says (answerWithoutFeed in
// src/server/services/image.service.ts, for isTransientFeedReason). It IS the fallback it carries:
// Error, fallback.Reason and fallback.SafeDetail all read Fallback (`feed-unavailable` or
// `feed-status`), so a caller that does not look for this type hands the request back exactly as
// before. The public route can answer that 503 itself instead (server.Server.AnswerInfiniteFeedUnavailable).
//
// Which failures (serveFromFeed in src/server/services/feed-primary.service.ts):
//
//   - the call failed: a transport error, the 5 s FEED_PRIMARY_TIMEOUT_MS, or an answer body that is
//     not JSON (Node's `timeout` and `error`), here `feed-unavailable`;
//   - the feed answered a 5xx (Node's `status:5xx`; isTransientFeedReason matches `^status:5\d\d$`, so
//     500 to 599 only), here `feed-status`.
//
// And only for a request whose page feed-primary-degrade can never serve from its last-good cache:
// lastGoodKey (src/server/services/feed-primary-degrade.ts) is undefined for a signed-in viewer
// (`currentUserId`) and for a feed query carrying cursor, offset, before or viewerId, so for those
// requests a failed call is the 503 with the flag on or off. An anonymous first page is not marked:
// with the flag on, the Node pod may hold a fresh last-good page and answer it instead, which this
// service cannot know, so it stays the plain fallback.
//
// Not marked either, and so left as fallbacks: a 2xx other than 200, a 4xx or a status past 599
// (`feed-status`; Node answers those with an empty page), a failed hydrate (`feed-hydrate-error`,
// Node's `hydrate:error`, also its 503, but a different query on a different store, left out of this
// port), and the request's own budget or client ending first (`deadline`, `canceled`: with a budget
// under the feed timeout, a hung feed ends as `deadline`, not here).
type UnavailableError struct {
	// Fallback is the fallback error the request is handed back with when the 503 is not answered here.
	Fallback error
}

func (e *UnavailableError) Error() string { return e.Fallback.Error() }

// Unwrap is Fallback, so errors.As finds the *fallback.Error (its reason and safe detail) through it.
func (e *UnavailableError) Unwrap() error { return e.Fallback }

// IsUnavailable reports whether err is an UnavailableError: a feed failure the Node app answers with
// its 503 whatever feed-service-degrade says.
func IsUnavailable(err error) bool {
	var u *UnavailableError
	return errors.As(err, &u)
}

// lastGoodPagingParams are PAGING_PARAMS plus `viewerId`: the feed-query params that make lastGoodKey
// undefined (feed-primary-degrade.ts).
var lastGoodPagingParams = []string{"cursor", "offset", "before", "viewerId"}

// lastGoodUncacheable is `lastGoodKey(input, query) === undefined`: a signed-in viewer, or a feed
// query that pages, time-cuts or names a viewer, so no Node pod ever holds a last-good copy of its
// page. A query that does not parse reads as cacheable, the direction that keeps the fallback.
func lastGoodUncacheable(viewer Viewer, query string) bool {
	if viewer.ID != 0 {
		return true
	}
	params, err := url.ParseQuery(query)
	if err != nil {
		return false
	}
	for _, p := range lastGoodPagingParams {
		if params.Has(p) {
			return true
		}
	}
	return false
}

// nodeUnavailable is fb marked as an UnavailableError when the request's page is lastGoodUncacheable,
// else fb unchanged.
func nodeUnavailable(fb error, viewer Viewer, query string) error {
	if lastGoodUncacheable(viewer, query) {
		return &UnavailableError{Fallback: fb}
	}
	return fb
}
