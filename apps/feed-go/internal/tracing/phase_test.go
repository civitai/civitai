package tracing

import (
	"context"
	"runtime/pprof"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// Under a recording request span a phase is a child span of its name, with the attributes set on it,
// and its context carries the pprof label phase=<name>.
func TestStartPhaseSampled(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()), sdktrace.WithSpanProcessor(rec))
	ctx, root := tp.Tracer("test").Start(context.Background(), "serve as-posts")
	pctx, p := StartPhase(ctx, PhaseBuild)
	if !p.Recording() {
		t.Fatal("a phase under a recording span does not record")
	}
	if v, _ := pprof.Label(pctx, "phase"); v != "build page" {
		t.Fatalf("phase label %q, want %q", v, "build page")
	}
	p.SetInt(AttrItems, 42)
	p.End()
	root.End()
	ended := rec.Ended()
	if len(ended) != 2 || ended[0].Name() != "build page" || ended[0].Parent().SpanID() != root.SpanContext().SpanID() {
		t.Fatalf("spans %v, want `build page` under the request span", ended)
	}
	if kv := ended[0].Attributes(); len(kv) != 1 || kv[0].Key != "feed_go.items" || kv[0].Value.AsInt64() != 42 {
		t.Fatalf("attributes %v, want feed_go.items=42", kv)
	}
}

// Without a recording span (unsampled, or no tracing at all) a phase starts no span and sets no
// attribute, and still carries the pprof label.
func TestStartPhaseUnsampled(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.NeverSample()), sdktrace.WithSpanProcessor(rec))
	for name, ctx := range map[string]context.Context{"unsampled": func() context.Context {
		ctx, _ := tp.Tracer("test").Start(context.Background(), "serve as-posts")
		return ctx
	}(), "no tracing": context.Background()} {
		pctx, p := StartPhase(ctx, PhaseEncodeDevalue)
		if p.Recording() {
			t.Fatalf("%s: the phase records", name)
		}
		if v, _ := pprof.Label(pctx, "phase"); v != "encode devalue" {
			t.Fatalf("%s: phase label %q", name, v)
		}
		p.SetInt(AttrResponseBytes, 1)
		p.End()
	}
	if n := len(rec.Ended()); n != 0 {
		t.Fatalf("%d spans recorded, want none", n)
	}
}
