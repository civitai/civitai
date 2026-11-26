package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/apipolicy"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
	"github.com/civitai/civitai/apps/feed-go/internal/v1models"
)

// errRegionBlocked is a request from a region on REGION_BLOCK_CONFIG (apiRequestPolicy): the
// `region-blocked` fallback, or, with Server.AnswerRegionBlocked, the app's 451 written here.
var errRegionBlocked = fallback.New("region-blocked")

// OutcomeRegionBlocked is the feed_go_requests_total outcome of a request from a blocked region this
// service answered itself (Server.AnswerRegionBlocked): the app's 451, not a computed answer, so it is
// neither `served` (no feed was computed, and nothing was compared) nor `fallback` (nothing went to
// the app). Serve mode only.
const OutcomeRegionBlocked = "region_blocked"

// answerRegionBlocked writes the app's 451 for err when it is errRegionBlocked and AnswerRegionBlocked
// is on, counts it (outcome region_blocked, no fallback reason) and reports true; otherwise it does
// nothing and reports false, and the caller hands the request back as before. Every public route calls
// it at the point it would otherwise record a fallback.
func (s *Server) answerRegionBlocked(ctx context.Context, span trace.Span, start time.Time, w http.ResponseWriter, endpoint string, err error) bool {
	if !s.AnswerRegionBlocked || !errors.Is(err, errRegionBlocked) {
		return false
	}
	writeRegionBlocked(w)
	setOutcome(span, OutcomeRegionBlocked)
	s.Metrics.Requests.WithLabelValues(endpoint, "serve", OutcomeRegionBlocked).Inc()
	tracing.Observe(ctx, s.Metrics.Duration.WithLabelValues(endpoint, "serve", OutcomeRegionBlocked), time.Since(start).Seconds())
	return true
}

// writeRegionBlocked writes the response the app gives a blocked region on every route this service
// answers (testdata/golden/region-blocked/responses.json, captured from the real Node routes):
//
//   - the status, Content-Type and body of API_REGION_BLOCK (apipolicy.RegionBlockResponse, generated
//     from the Node module). On tRPC it is an HTTP-level answer, not a tRPC error envelope: the route
//     answers it before tRPC runs, a batch included;
//   - the next.config.mjs headers the router sets before any route (v1models.ConfigHeaders);
//   - nothing else: no Cache-Control or X-Handled-By (the policy returns before it sets them), no Vary
//     (tRPC never runs), no CORS headers (on /api/v1 the proxy answers before the endpoint wrapper),
//     no cookie.
//
// Plus X-Feed-Go-Served: go, as on every answer this service writes. Content-Length is transport.
func writeRegionBlocked(w http.ResponseWriter) {
	ans := apipolicy.RegionBlockResponse()
	h := w.Header()
	for _, x := range v1models.ConfigHeaders() {
		h.Set(x.Name, x.Value)
	}
	h.Set("Content-Type", ans.ContentType)
	h.Set("Content-Length", strconv.Itoa(len(ans.Body)))
	h.Set(ServedByHeader, ServedByGo)
	w.WriteHeader(ans.Status)
	_, _ = io.WriteString(w, ans.Body)
}
