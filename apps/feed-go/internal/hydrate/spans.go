package hydrate

import (
	"context"
	"errors"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The spans of the waits a miss computation spends on work it did not start: a lookup that joins
// another caller's in-flight lookup (lookupShared), and the metrics lookup's wait on a populate lock
// another process holds (awaitMetricHashes). The query a wait is for is spanned on the context of
// whoever runs it (pgx, Redis, ClickHouse spans), so without these a request that only waits shows a
// gap. Attributes are counts and closed labels only, never an id, a key or SQL.
var (
	attrMissCache   = attribute.Key("feed_go.miss.cache")
	attrMissShared  = attribute.Key("feed_go.miss.shared")
	attrWaitIDs     = attribute.Key("feed_go.metrics.wait.ids")
	attrWaitPolls   = attribute.Key("feed_go.metrics.wait.polls")
	attrWaitOutcome = attribute.Key("feed_go.metrics.wait.outcome")
	attrErrorType   = attribute.Key("error.type")
)

// The outcomes of a metrics lock wait (feed_go.metrics.wait.outcome).
const (
	waitFilled    = "filled"     // every waited hash landed
	waitExhausted = "exhausted"  // the last read still found one unfilled (errMetricsWaitExhausted)
	waitCtxDone   = "ctx_done"   // the lookup's context ended first
	waitReadError = "read_error" // a Redis read failed
)

// traced is whether c spans a wait on ctx: a tracer is set (tracing on) and ctx's span records. An
// unsampled request pays one context read.
func (c *MissCompute) traced(ctx context.Context) bool {
	return c != nil && c.Tracer != nil && trace.SpanFromContext(ctx).IsRecording()
}

// endWithError marks span failed by err, as the store spans do (tracing.PgxTracer): the status is its
// class (fallback.Class) and error.type its Go type, never its text.
func endWithError(span trace.Span, err error) {
	if err != nil {
		span.SetStatus(codes.Error, fallback.Class(err))
		span.SetAttributes(attrErrorType.String(fallback.Type(err)))
	}
	span.End()
}

// joinSpan records, on the joiner's own ctx, the wait of a lookup that joined another caller's flight
// of cache: from start (before it reached the flight) to now, failed by the flight's err.
func (c *MissCompute) joinSpan(ctx context.Context, cache string, start time.Time, err error) {
	_, span := c.Tracer.Start(ctx, "miss lookup join", trace.WithTimestamp(start), trace.WithAttributes(
		attrMissCache.String(cache), attrMissShared.Bool(true)))
	endWithError(span, err)
}

// waitOutcome is the feed_go.metrics.wait.outcome of a lock wait that returned err.
func waitOutcome(err error) string {
	switch {
	case err == nil:
		return waitFilled
	case errors.Is(err, errMetricsWaitExhausted):
		return waitExhausted
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return waitCtxDone
	default:
		return waitReadError
	}
}
