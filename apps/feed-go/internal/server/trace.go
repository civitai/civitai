package server

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The request span attributes (DESIGN.md §10.3).
var (
	attrEndpoint     = attribute.Key(EndpointLabel)
	attrMode         = attribute.Key("feed_go.mode")
	attrOutcome      = attribute.Key("feed_go.outcome")
	attrReason       = attribute.Key("feed_go.fallback.reason")
	attrDetail       = attribute.Key("feed_go.fallback.detail")
	attrShadowResult = attribute.Key("feed_go.shadow.result")
	attrErrClass     = attribute.Key("feed_go.error.class")
	attrErrType      = attribute.Key("error.type")
)

// startSpan starts the server span of one request (`<mode> <endpoint>`), as a child of the caller's
// `traceparent` when it carries one (the sampler then decides: HeadSampler). With tracing off
// (Tracer nil) it starts nothing and returns ctx with whatever span it holds (none: a no-op span).
func (s *Server) startSpan(ctx context.Context, h http.Header, mode, endpoint string) (context.Context, trace.Span) {
	if s.Tracer == nil {
		return ctx, trace.SpanFromContext(ctx)
	}
	if s.Propagator != nil {
		ctx = s.Propagator.Extract(ctx, propagation.HeaderCarrier(h))
	}
	ctx, span := s.Tracer.Start(ctx, mode+" "+endpoint, trace.WithSpanKind(trace.SpanKindServer))
	if span.IsRecording() {
		span.SetAttributes(attrEndpoint.String(endpoint), attrMode.String(mode))
	}
	return ctx, span
}

// setOutcome records the request's outcome on its span.
func setOutcome(span trace.Span, outcome string) {
	if span.IsRecording() {
		span.SetAttributes(attrOutcome.String(outcome))
	}
}

// events is the EventLog (Server.Events, else one over Log with fallback lines off).
func (s *Server) events() *EventLog {
	s.eventsOnce.Do(func() {
		s.ev = s.Events
		if s.ev == nil {
			s.ev = &EventLog{Log: s.Log}
		}
	})
	return s.ev
}

// noteFallback records a fallback on the request's span (reason attribute, a `fallback` event with
// the safe detail) and its log line.
func (s *Server) noteFallback(ctx context.Context, mode, endpoint string, err error) {
	if span := trace.SpanFromContext(ctx); span.IsRecording() {
		reason := fallback.Reason(err)
		span.SetAttributes(attrReason.String(reason))
		span.AddEvent("fallback", trace.WithAttributes(attrReason.String(reason), attrDetail.String(fallback.SafeDetail(err))))
	}
	s.events().Fallback(ctx, mode, endpoint, err)
}

// noteError records a compute error (not a fallback) on the request's span (error status with its
// class, an `error` event with class and type — never the text), its count (feed_go_errors_total)
// and its log line.
func (s *Server) noteError(ctx context.Context, level slog.Level, msg, mode, endpoint string, err error) {
	if span := trace.SpanFromContext(ctx); span.IsRecording() {
		class := fallback.Class(err)
		span.SetStatus(codes.Error, class)
		span.AddEvent("error", trace.WithAttributes(attrErrClass.String(class), attrErrType.String(fallback.Type(err))))
	}
	if s.Metrics != nil {
		s.Metrics.ObserveError(endpoint, mode, err)
	}
	s.events().Error(ctx, level, msg, mode, endpoint, err)
}

// NoteProxyError is the fallback proxy's onError: the error on the proxy hop's span, its count
// (feed_go_errors_total, mode proxy) and its log line, under the endpoint of the request's path.
func (s *Server) NoteProxyError(r *http.Request, reason string, err error) {
	ctx := r.Context()
	if span := trace.SpanFromContext(ctx); span.IsRecording() {
		span.SetStatus(codes.Error, reason)
		span.AddEvent("error", trace.WithAttributes(attrErrClass.String(fallback.Class(err)), attrErrType.String(fallback.Type(err))))
	}
	endpoint := PublicEndpoint(r.URL.Path)
	if s.Metrics != nil {
		s.Metrics.ObserveError(endpoint, "proxy", err)
	}
	s.events().ProxyError(ctx, endpoint, reason, err)
}

// PublicEndpoint is the feed_endpoint of a public path ("" for any other).
func PublicEndpoint(path string) string {
	switch {
	case path == V1ModelsPath:
		return EndpointV1Models
	case strings.HasPrefix(path, V1ModelsPath+"/"):
		return EndpointV1ModelsID
	case path == V1ImagesPath:
		return EndpointV1Images
	}
	switch strings.TrimPrefix(path, "/api/trpc/") {
	case Procedure:
		return EndpointAsPosts
	case ProcedureModelGetAll:
		return EndpointModelGetAll
	case ProcedureInfinite:
		return EndpointInfinite
	}
	return ""
}

// proxy hands r to the fallback proxy, inside a client span `fallback-proxy <endpoint>` when tracing
// is on, so the proxy's injected traceparent makes the Node app's span its child.
func (s *Server) proxy(w http.ResponseWriter, r *http.Request, endpoint string) {
	s.proxyVia(s.Fallback, w, r, endpoint)
}

// proxyVia is proxy to upstream (Fallback, or V1Fallback for the REST model routes).
func (s *Server) proxyVia(upstream http.Handler, w http.ResponseWriter, r *http.Request, endpoint string) {
	if s.Tracer == nil {
		upstream.ServeHTTP(w, r)
		return
	}
	ctx, span := s.Tracer.Start(r.Context(), "fallback-proxy "+endpoint, trace.WithSpanKind(trace.SpanKindClient))
	defer span.End()
	upstream.ServeHTTP(w, r.WithContext(ctx))
}
