package main

import (
	"net/url"
	"time"

	"go.opentelemetry.io/otel/propagation"

	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

// newServeParity is the serve-side parity sampler (server.ServeParity, DESIGN.md §7.2) for
// FEED_GO_SERVE_PARITY_SAMPLE_RATE: nil (off) at a rate of 0, the default. Its replays reach target,
// the Node app the fallbacks are handed to (FEED_GO_FALLBACK_URL), through the fallback proxy code
// but their own instance with no error hook: a replay's failure is its outcome
// (feed_go_serve_parity_total), never a fallback proxy error.
func newServeParity(rate float64, workers int, timeout time.Duration, target *url.URL, prop propagation.TextMapPropagator) *server.ServeParity {
	if rate <= 0 || target == nil {
		return nil
	}
	return &server.ServeParity{
		Rate:     rate,
		Upstream: fallbackProxy(target, fallbackIdleTimeout, nil, prop),
		Queue:    make(chan struct{}, max(workers, 1)),
		Timeout:  timeout,
	}
}
