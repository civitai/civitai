package server

// API STUBS ONLY (signatures, no behaviour), so the tests compile and fail by name on the pre-change
// code. Replaced by the implementation in the next commit.

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const maxEventKeys = 1024

const overflowReason = "(overflow)"

const eventFallback = "fallback"

type EventLog struct {
	Log               *slog.Logger
	FallbackPerMinute int
	ErrorPerMinute    int
	Now               func() time.Time

	mu      sync.Mutex
	buckets map[eventKey]*eventBucket
}

type eventKey struct{ kind, mode, endpoint, reason string }

type eventBucket struct{}

func (l *EventLog) Fallback(context.Context, string, string, error)                  {}
func (l *EventLog) Error(context.Context, slog.Level, string, string, string, error) {}
func (l *EventLog) ProxyError(context.Context, string, string, error)                {}
func (l *EventLog) FlushSuppressed()                                                 {}
func (l *EventLog) Run(context.Context, time.Duration)                               {}
func (s *Server) NoteProxyError(*http.Request, string, error)                        {}
func MetricsHandler(g prometheus.Gatherer, _ bool) http.Handler {
	return promhttp.HandlerFor(g, promhttp.HandlerOpts{})
}
