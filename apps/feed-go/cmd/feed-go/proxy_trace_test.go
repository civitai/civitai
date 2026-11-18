package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/tracing"
)

// With tracing on, the request the Node app receives carries the proxy hop's own trace context (the
// span in the request's context, which server.proxy starts), replacing the caller's traceparent, so
// Node's span is the hop's child. With tracing off (no propagator) the inbound traceparent passes
// through untouched, as before.
func TestFallbackProxyInjectsTheHopsTraceparent(t *testing.T) {
	const (
		inbound = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
		hop     = "00-0577cd69a35d1adc3df3616183b98451-0000000000000abc-01"
	)
	seen := make(chan string, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Traceparent")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	tid, _ := trace.TraceIDFromHex("0577cd69a35d1adc3df3616183b98451")
	sid, _ := trace.SpanIDFromHex("0000000000000abc")
	ctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: tid, SpanID: sid, TraceFlags: trace.FlagsSampled}))

	for _, c := range []struct {
		name string
		prop bool
		want string
	}{
		{"tracing on: the hop's context", true, hop},
		{"tracing off: the inbound header as it came", false, inbound},
	} {
		req := httptest.NewRequestWithContext(ctx, http.MethodGet, "http://green.example.test/api/trpc/image.getImagesAsPostsInfinite?input=%7B%7D", nil)
		req.Header.Set("traceparent", inbound)
		p := fallbackProxy(target, fallbackIdleTimeout, nil, nil)
		if c.prop {
			p = fallbackProxy(target, fallbackIdleTimeout, nil, tracing.Propagator())
		}
		p.ServeHTTP(httptest.NewRecorder(), req)
		if got := <-seen; got != c.want {
			t.Errorf("%s: upstream traceparent %q, want %q", c.name, got, c.want)
		}
	}
}

// onError receives the failed request, so its line can name the endpoint and the trace.
func TestFallbackProxyErrorHandsOverTheRequest(t *testing.T) {
	target, err := url.Parse("http://127.0.0.1:1") // nothing listens on port 1
	if err != nil {
		t.Fatal(err)
	}
	var gotPath, gotReason string
	var gotErr error
	p := fallbackProxy(target, fallbackIdleTimeout, func(r *http.Request, reason string, err error) {
		gotPath, gotReason, gotErr = r.URL.Path, reason, err
	}, nil)
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://green.example.test/api/trpc/model.getAll", nil))
	if w.Code != http.StatusBadGateway || gotPath != "/api/trpc/model.getAll" || gotReason != proxyErrorUpstream || gotErr == nil {
		t.Fatalf("code %d, onError(%q, %q, %v); want 502 and the request's path, upstream, an error", w.Code, gotPath, gotReason, gotErr)
	}
	if errors.Is(gotErr, context.Canceled) {
		t.Fatalf("a refused connection reported as canceled: %v", gotErr)
	}
}
