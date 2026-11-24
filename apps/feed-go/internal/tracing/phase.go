package tracing

import (
	"context"
	"runtime/pprof"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// The CPU phases of a served answer, by name: the span of each (a child of the request span, only on a
// sampled request) and the value of the pprof label PhaseLabel while it runs, so a trace's phase and a
// CPU profile's `-tagfocus phase=<name>` are the same slice of work.
const (
	// PhaseHydrate is a page's hydration: its cache reads (their own redis / pgx spans as children)
	// and the decode of every entry.
	PhaseHydrate = "decode hydrate"
	// PhaseBuild is the per-item build of the answer from the rows and their hydration (filtering
	// included).
	PhaseBuild = "build page"
	// PhaseEncodeDevalue and PhaseEncodeSuperjson are the write of the answer's payload.
	PhaseEncodeDevalue   = "encode devalue"
	PhaseEncodeSuperjson = "encode superjson"
)

// PhaseLabel is the pprof label a phase runs under (next to the request's feed_endpoint and mode).
const PhaseLabel = "phase"

// Phase span attributes.
var (
	// AttrItems is the number of items a phase works on (ids hydrated, rows built).
	AttrItems = attribute.Key("feed_go.items")
	// AttrResponseBytes is the size of the payload an encode phase wrote.
	AttrResponseBytes = attribute.Key("feed_go.response.bytes")
)

// Phase is one running phase (StartPhase); End it exactly once.
type Phase struct {
	span    trace.Span
	restore context.Context
}

// noSpan is the span of a phase on a request that is not sampled: a no-op.
var noSpan = trace.SpanFromContext(context.Background())

// StartPhase starts the phase name under ctx. On a sampled request (ctx's span is recording) it
// starts a child span of that name, from the request span's own tracer provider; otherwise no span
// and no attribute is made. Either way the goroutine runs under the pprof label PhaseLabel=name until
// End, and the returned context carries it, so goroutines the phase starts inherit it.
func StartPhase(ctx context.Context, name string) (context.Context, Phase) {
	p := Phase{span: noSpan, restore: ctx}
	ctx = pprof.WithLabels(ctx, pprof.Labels(PhaseLabel, name))
	pprof.SetGoroutineLabels(ctx)
	if parent := trace.SpanFromContext(ctx); parent.IsRecording() {
		ctx, p.span = parent.TracerProvider().Tracer(TracerName).Start(ctx, name)
	}
	return ctx, p
}

// SetInt sets an integer attribute on the phase's span (nothing on a request that is not sampled).
func (p Phase) SetInt(k attribute.Key, v int) {
	if p.span.IsRecording() {
		p.span.SetAttributes(k.Int(v))
	}
}

// End ends the phase: its span, and the goroutine's labels back to those of the context it started
// under.
func (p Phase) End() {
	p.span.End()
	pprof.SetGoroutineLabels(p.restore)
}
