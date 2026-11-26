package server

import "github.com/civitai/civitai/apps/feed-go/internal/auth"

// Viewer classes of the tRPC feed answers (FeedViewerEndpoints). Each compared shadow sample of those
// endpoints is also counted under its class, the body's result in feed_go_shadow_compare_viewer_total
// and the headers' in feed_go_shadow_response_viewer_total, so the signed-out cohort's parity reads
// from signed-out samples only: a signed-out answer is the one an edge cache may keep (createContext's
// public TTL), and its headers decide who else is served it.
//
//   - anon: no session user and no verified crawler (the edge-cacheable answer).
//   - crawler: a verified crawler with no session user (image.getInfinite only; the other two hand a
//     verified bot back). Never edge-cached.
//   - banned: a banned session (no viewer, but a session user, so never edge-cached).
//   - user, moderator: a signed-in viewer.
const (
	FeedViewerAnon      = "anon"
	FeedViewerCrawler   = "crawler"
	FeedViewerBanned    = "banned"
	FeedViewerUser      = "user"
	FeedViewerModerator = "moderator"
)

// FeedViewerClasses is every tRPC feed viewer class, in a fixed order.
var FeedViewerClasses = []string{FeedViewerAnon, FeedViewerCrawler, FeedViewerBanned, FeedViewerUser, FeedViewerModerator}

// FeedViewerEndpoints are the endpoints whose answers carry a FeedViewerClasses class.
var FeedViewerEndpoints = []string{EndpointAsPosts, EndpointInfinite, EndpointModelGetAll}

// isFeedViewerEndpoint reports whether endpoint is one of FeedViewerEndpoints.
func isFeedViewerEndpoint(endpoint string) bool {
	for _, e := range FeedViewerEndpoints {
		if e == endpoint {
			return true
		}
	}
	return false
}

// feedViewerClass is the class of a request with session user (nil: none) and, for image.getInfinite,
// whether it is a verified crawler's.
func feedViewerClass(user *auth.SessionUser, crawler bool) string {
	switch {
	case user == nil && crawler:
		return FeedViewerCrawler
	case user == nil:
		return FeedViewerAnon
	case user.Banned:
		return FeedViewerBanned
	case user.IsModerator:
		return FeedViewerModerator
	}
	return FeedViewerUser
}
