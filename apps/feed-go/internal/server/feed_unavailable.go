package server

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"time"

	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// OutcomeFeedUnavailable is the feed_go_requests_total outcome of an image.getInfinite request whose
// feed-service call failed and that this service answered with the app's 503 itself
// (Server.AnswerInfiniteFeedUnavailable): neither `served` (no page was computed) nor `fallback`
// (nothing went to the app). Serve mode, the infinite route only.
const OutcomeFeedUnavailable = "feed_unavailable"

// feedUnavailableError is the TRPCError answerWithoutFeed (src/server/services/image.service.ts)
// throws for a transient feed failure (isTransientFeedReason).
var feedUnavailableError = trpc.Error{
	Code:       "SERVICE_UNAVAILABLE",
	HTTPStatus: http.StatusServiceUnavailable,
	Message:    "Image search is temporarily overloaded — please retry.",
}

// feedUnavailableCause is the reason and detail feed_go_feed_unavailable_total counts an answered 503
// under: the fallback the request would have been handed back with (fallback.Reason) and its loggable
// detail (fallback.SafeDetail), the pair a fallback records. Both are bounded here, whatever the
// error carries: reason feed-unavailable with a detail among fallback.ErrorClasses (fallback.Wrap's
// class of the failed call: deadline for the feed client's own timeout, conn_refused, json for a body
// that is not JSON, ...), reason feed-status with a 5xx status (500..599, the only statuses
// feed.UnavailableError marks), anything else `other`.
func feedUnavailableCause(err error) (reason, detail string) {
	reason, detail = fallback.Reason(err), fallback.SafeDetail(err)
	switch reason {
	case "feed-unavailable":
		if !slices.Contains(fallback.ErrorClasses(), detail) {
			detail = "other"
		}
	case "feed-status":
		if n, perr := strconv.Atoi(detail); perr != nil || n < 500 || n > 599 || strconv.Itoa(n) != detail {
			detail = "other"
		}
	default:
		reason, detail = "other", "other"
	}
	return reason, detail
}

// answerFeedUnavailable writes the app's 503 for err on the image.getInfinite route when err is a
// feed failure the app answers with it whatever feed-service-degrade says (feed.IsUnavailable) and
// AnswerInfiniteFeedUnavailable is on, counts it (outcome feed_unavailable, no fallback reason; its
// cause on feed_go_feed_unavailable_total and the span, feedUnavailableCause) and reports true; otherwise it does nothing and reports false, and the request is handed back as before
// (`feed-unavailable` / `feed-status`). Only the public route calls it: the shadow and the Go-first
// probe never write to a client, and keep counting the fallback. asDevalue is whether the request's
// answer is written as devalue (trpc.DevalueWrite with no cache policy: an error is never
// edge-cacheable).
func (s *Server) answerFeedUnavailable(ctx context.Context, span trace.Span, start time.Time, w http.ResponseWriter, endpoint, procedure string, asDevalue bool, err error) bool {
	if !s.AnswerInfiniteFeedUnavailable || endpoint != EndpointInfinite || !feed.IsUnavailable(err) {
		return false
	}
	writeFeedUnavailable(w, procedure, asDevalue)
	setOutcome(span, OutcomeFeedUnavailable)
	reason, detail := feedUnavailableCause(err)
	if span.IsRecording() {
		span.SetAttributes(attrReason.String(reason))
		span.AddEvent(OutcomeFeedUnavailable, trace.WithAttributes(attrReason.String(reason), attrDetail.String(detail)))
	}
	s.Metrics.FeedUnavailable.WithLabelValues(endpoint, reason, detail).Inc()
	s.Metrics.Requests.WithLabelValues(endpoint, "serve", OutcomeFeedUnavailable).Inc()
	tracing.Observe(ctx, s.Metrics.Duration.WithLabelValues(endpoint, "serve", OutcomeFeedUnavailable), time.Since(start).Seconds())
	return true
}

// writeFeedUnavailable writes the app's answer to image.getInfinite (procedure) when the feed failed:
// the tRPC error envelope of feedUnavailableError as the route writes it (trpc.WriteAppError: 503,
// Content-Type, Vary, the private Cache-Control, the body in the request's write format), after the
// next.config.mjs headers the router sets before any route (v1models.ConfigHeaders, as on the 451:
// testdata/golden/region-blocked captures them on this route). Not X-Handled-By (the app's pod name),
// nor the per-caller headers responseMeta may add (x-update-required, the site-alerts version, the
// rate-limit headers), as on every tRPC answer this service writes.
//
// Plus X-Feed-Go-Served: go, as on every answer this service writes.
func writeFeedUnavailable(w http.ResponseWriter, procedure string, asDevalue bool) {
	h := w.Header()
	for _, x := range v1models.ConfigHeaders() {
		h.Set(x.Name, x.Value)
	}
	h.Set(ServedByHeader, ServedByGo)
	e := feedUnavailableError
	trpc.WriteAppError(w, procedure, &e, asDevalue)
}
