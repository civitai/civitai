package main

import (
	"net/url"

	"go.opentelemetry.io/otel/propagation"

	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

// newServeParity is the serve-side parity sampler (server.ServeParity, DESIGN.md §7.2) for
// FEED_GO_SERVE_PARITY_SAMPLE_RATE: nil (off) at a rate of 0, the default, or with neither upstream.
// Its replays reach the Node app each route hands its fallbacks to: target (FEED_GO_FALLBACK_URL) for
// the tRPC routes, v1Target (FEED_GO_V1_FALLBACK_URL) for the public model routes; a nil one leaves
// its routes unreplayed. Each goes through the fallback proxy code but its own instance with no error
// hook: a replay's failure is its outcome (feed_go_serve_parity_total), never a fallback proxy error.
func newServeParity(rate float64, target, v1Target *url.URL, prop propagation.TextMapPropagator) *server.ServeParity {
	if rate <= 0 || (target == nil && v1Target == nil) {
		return nil
	}
	p := &server.ServeParity{
		Rate:    rate,
		Queue:   make(chan struct{}, server.DefaultServeParityWorkers),
		Timeout: server.DefaultServeParityTimeout,
	}
	if target != nil {
		p.Upstream = fallbackProxy(target, fallbackIdleTimeout, nil, prop)
	}
	if v1Target != nil {
		p.V1Upstream = fallbackProxy(v1Target, fallbackIdleTimeout, nil, prop)
	}
	return p
}

// withImagesParity adds the public images route's replay upstream (FEED_GO_SERVE_PARITY_V1_IMAGES) to
// the sampler p: its own proxy instance to target (FEED_GO_V1_IMAGES_FALLBACK_URL, the Node app the
// route hands back to), with no error hook, as newServeParity's. p nil (the sampler off) stays nil:
// the switch turns on no sampler of its own.
func withImagesParity(p *server.ServeParity, target *url.URL, prop propagation.TextMapPropagator) *server.ServeParity {
	if p == nil || target == nil {
		return p
	}
	p.V1ImagesUpstream = fallbackProxy(target, fallbackIdleTimeout, nil, prop)
	return p
}
