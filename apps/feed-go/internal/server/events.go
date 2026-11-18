package server

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// DefaultErrorLogPerMinute is EventLog.ErrorPerMinute's default.
const DefaultErrorLogPerMinute = 60

// maxEventKeys bounds the limiter's keys; past it, new keys share one overflow bucket per kind.
const maxEventKeys = 1024

// overflowReason is the reason of the shared bucket past maxEventKeys.
const overflowReason = "(overflow)"

// EventLog writes the per-request lines (DESIGN.md §10.3): one per fallback, per compute error and per
// fallback-proxy error, each with the trace and span ids when the request has a span, rate-limited
// per (kind, mode, endpoint, reason) by a token bucket of PerMinute lines (refilled continuously, burst
// PerMinute). A line carries `suppressed`, the lines that key dropped since its last one; nothing else
// reports drops, and nothing is lost to them: feed_go_errors_total and feed_go_fallback_total count
// every event.
//
// Only safe fields are written: the reason (a fixed label), the fallback's SafeDetail, an error's
// Class and Type — never an error's text, the request input, a cookie or an id.
type EventLog struct {
	Log *slog.Logger
	// FallbackPerMinute is FEED_GO_FALLBACK_LOG_PER_MIN: fallback lines per key per minute; 0 = none.
	FallbackPerMinute int
	// ErrorPerMinute is FEED_GO_ERROR_LOG_PER_MIN: error lines per key per minute (<= 0 =
	// DefaultErrorLogPerMinute). Errors are always logged, as before the limiter.
	ErrorPerMinute int
	// Now is the clock (nil = time.Now).
	Now func() time.Time

	mu      sync.Mutex
	buckets map[eventKey]*eventBucket
}

type eventKey struct{ kind, mode, endpoint, reason string }

type eventBucket struct {
	tokens     float64
	last       time.Time
	suppressed int
}

// Event kinds (part of the limiter's key).
const (
	eventFallback   = "fallback"
	eventError      = "error"
	eventProxyError = "proxy_error"
)

func (l *EventLog) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

// allow takes a token from k's bucket. It reports whether the line is written and, when it is, how
// many lines k dropped since its last one (then reset).
func (l *EventLog) allow(k eventKey, perMinute int) (bool, int) {
	if perMinute <= 0 {
		return false, 0
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets == nil {
		l.buckets = map[eventKey]*eventBucket{}
	}
	b := l.buckets[k]
	if b == nil {
		if len(l.buckets) >= maxEventKeys {
			k = eventKey{kind: k.kind, reason: overflowReason}
			b = l.buckets[k]
		}
		if b == nil {
			b = &eventBucket{tokens: float64(perMinute), last: now}
			l.buckets[k] = b
		}
	}
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = min(float64(perMinute), b.tokens+elapsed.Minutes()*float64(perMinute))
	}
	b.last = now
	if b.tokens < 1 {
		b.suppressed++
		return false, 0
	}
	b.tokens--
	n := b.suppressed
	b.suppressed = 0
	return true, n
}

// traceAttrs are the trace and span ids of ctx's span, when it has a valid one.
func traceAttrs(ctx context.Context, attrs []any) []any {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		attrs = append(attrs, "trace_id", sc.TraceID().String(), "span_id", sc.SpanID().String())
	}
	return attrs
}

// Fallback logs one fallback: mode, endpoint, reason and the safe detail (omitted when empty).
func (l *EventLog) Fallback(ctx context.Context, mode, endpoint string, err error) {
	reason := fallback.Reason(err)
	ok, suppressed := l.allow(eventKey{eventFallback, mode, endpoint, reason}, l.FallbackPerMinute)
	if !ok {
		return
	}
	attrs := []any{"mode", mode, "endpoint", endpoint, "reason", reason}
	if d := fallback.SafeDetail(err); d != "" {
		attrs = append(attrs, "detail", d)
	}
	attrs = traceAttrs(ctx, attrs)
	if suppressed > 0 {
		attrs = append(attrs, "suppressed", suppressed)
	}
	l.Log.InfoContext(ctx, "fallback", attrs...)
}

// Error logs a compute error (an error that is not a fallback) at level: its class and type, never
// its text.
func (l *EventLog) Error(ctx context.Context, level slog.Level, msg, mode, endpoint string, err error) {
	perMinute := l.ErrorPerMinute
	if perMinute <= 0 {
		perMinute = DefaultErrorLogPerMinute
	}
	ok, suppressed := l.allow(eventKey{eventError, mode, endpoint, "error"}, perMinute)
	if !ok {
		return
	}
	attrs := []any{"mode", mode, "endpoint", endpoint, "err_class", fallback.Class(err), "err_type", fallback.Type(err)}
	attrs = traceAttrs(ctx, attrs)
	if suppressed > 0 {
		attrs = append(attrs, "suppressed", suppressed)
	}
	l.Log.Log(ctx, level, msg, attrs...)
}

// ProxyError logs a fallback the proxy answered 502 (reason upstream | canceled): Warn for upstream,
// Debug for canceled (the client left; as before, not visible at the default level).
func (l *EventLog) ProxyError(ctx context.Context, endpoint, reason string, err error) {
	perMinute := l.ErrorPerMinute
	if perMinute <= 0 {
		perMinute = DefaultErrorLogPerMinute
	}
	ok, suppressed := l.allow(eventKey{eventProxyError, "serve", endpoint, reason}, perMinute)
	if !ok {
		return
	}
	level := slog.LevelWarn
	if reason != "upstream" {
		level = slog.LevelDebug
	}
	attrs := []any{"endpoint", endpoint, "reason", reason, "err_class", fallback.Class(err), "err_type", fallback.Type(err)}
	attrs = traceAttrs(ctx, attrs)
	if suppressed > 0 {
		attrs = append(attrs, "suppressed", suppressed)
	}
	l.Log.Log(ctx, level, "fallback proxy: the Node app did not answer", attrs...)
}
