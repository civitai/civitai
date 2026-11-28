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

// Viewer classes of `GET /api/v1/images` answers (shadow and serve-parity compares; EndpointV1Images):
// the tRPC feeds' classes for a request without an API credential, and for one with:
//
//   - api-key (V1ViewerAPIKey): a full-scope personal key, read as its user's cookie session;
//   - api-key-scoped: any other key, read with neither the owner's nor the moderator's view;
//   - api-key-anon: a credential that stands for no session (a download or service token, a
//     client-credentials key), answered as for anyone.
const (
	V1ImagesViewerAPIKeyScoped = "api-key-scoped"
	V1ImagesViewerAPIKeyAnon   = "api-key-anon"
)

// V1ImagesViewerClasses is every `/api/v1/images` viewer class, in a fixed order.
var V1ImagesViewerClasses = []string{FeedViewerAnon, FeedViewerCrawler, FeedViewerBanned, FeedViewerUser, FeedViewerModerator,
	V1ViewerAPIKey, V1ImagesViewerAPIKeyScoped, V1ImagesViewerAPIKeyAnon}

// v1ImagesViewerClass is the class of an images answer: user is the resolved viewer (nil: signed out),
// apiKey whether the request carried an API credential, full whether that credential reads with the
// session's views (auth.ImagesViewer.Full), crawler whether the request is a verified crawler's.
func v1ImagesViewerClass(user *auth.SessionUser, apiKey, full, crawler bool) string {
	switch {
	case !apiKey:
		return feedViewerClass(user, crawler)
	case user == nil:
		return V1ImagesViewerAPIKeyAnon
	case full:
		return V1ViewerAPIKey
	}
	return V1ImagesViewerAPIKeyScoped
}

// hasViewerResponseClass reports whether endpoint's response-header compares are counted per viewer
// class too (feed_go_shadow_response_viewer_total): the tRPC feeds, and the images route, whose
// headers differ by credential (PublicEndpoint's credentialed arm).
func hasViewerResponseClass(endpoint string) bool {
	return isFeedViewerEndpoint(endpoint) || endpoint == EndpointV1Images
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
