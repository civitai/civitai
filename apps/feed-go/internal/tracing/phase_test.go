package tracing

import (
	"context"
	"maps"
	"runtime/pprof"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"

	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// Under a recording request span a phase is a child span of its name, with the attributes set on it,
// and its context carries the pprof label phase=<name>.
func TestStartPhaseSampled(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()), sdktrace.WithSpanProcessor(rec))
	ctx, root := tp.Tracer("test").Start(context.Background(), "serve as-posts")
	pctx, p := StartPhase(ctx, PhaseBuild)
	if !p.span.IsRecording() {
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
// attribute, and still carries the pprof label. An invariant guard: a non-recording SDK span never
// reaches the SpanRecorder, so this stays green without StartPhase's IsRecording check;
// TestStartPhaseUnsampledStartsNoSpan pins that check.
func TestStartPhaseUnsampled(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.NeverSample()), sdktrace.WithSpanProcessor(rec))
	for name, ctx := range map[string]context.Context{"unsampled": func() context.Context {
		ctx, _ := tp.Tracer("test").Start(context.Background(), "serve as-posts")
		return ctx
	}(), "no tracing": context.Background()} {
		pctx, p := StartPhase(ctx, PhaseEncodeDevalue)
		if p.span.IsRecording() {
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

// countingTracer counts the spans started through it.
type countingTracer struct {
	noop.Tracer
	starts *int
}

func (t countingTracer) Start(ctx context.Context, name string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	*t.starts++
	return t.Tracer.Start(ctx, name, opts...)
}

type countingProvider struct {
	noop.TracerProvider
	starts *int
}

func (p countingProvider) Tracer(string, ...trace.TracerOption) trace.Tracer {
	return countingTracer{starts: p.starts}
}

// fakeRequestSpan is a request span whose tracer provider counts the spans started from it.
type fakeRequestSpan struct {
	noop.Span
	tp        trace.TracerProvider
	recording bool
}

func (s fakeRequestSpan) TracerProvider() trace.TracerProvider { return s.tp }
func (s fakeRequestSpan) IsRecording() bool                    { return s.recording }

// A phase under a request span that is not recording asks its tracer for no span at all (the
// IsRecording check in StartPhase: without it every unsampled request would start, and allocate, a
// non-recording span per phase). Control: under a recording one it starts exactly one.
func TestStartPhaseUnsampledStartsNoSpan(t *testing.T) {
	for _, recording := range []bool{false, true} {
		starts := 0
		parent := fakeRequestSpan{tp: countingProvider{starts: &starts}, recording: recording}
		_, p := StartPhase(trace.ContextWithSpan(context.Background(), parent), PhaseHydrate)
		p.End()
		want := 0
		if recording {
			want = 1
		}
		if starts != want {
			t.Fatalf("recording parent %v: %d spans started, want %d", recording, starts, want)
		}
	}
}

// goroutineLabels is the running goroutine's pprof labels (what a CPU profile records for its work).
func goroutineLabels(t *testing.T) map[string]string {
	t.Helper()
	l, ok := testkit.GoroutineLabels()
	if !ok {
		t.Fatal("the goroutine profile has no record of this goroutine")
	}
	return l
}

// The goroutine itself (not only the context) runs a phase under phase=<name> next to the request's
// labels, and End puts the request's labels back, so the next phase never carries the previous one's.
func TestPhaseSetsGoroutineLabels(t *testing.T) {
	before := goroutineLabels(t)
	request := map[string]string{"feed_endpoint": "as-posts", "mode": "serve"}
	pprof.Do(context.Background(), pprof.Labels("feed_endpoint", "as-posts", "mode", "serve"), func(ctx context.Context) {
		check := func(when string, want map[string]string) {
			t.Helper()
			if got := goroutineLabels(t); !maps.Equal(got, want) {
				t.Fatalf("%s: goroutine labels %v, want %v", when, got, want)
			}
		}
		check("before any phase", request)
		for _, name := range []string{PhaseHydrate, PhaseBuild, PhaseEncodeDevalue} {
			_, p := StartPhase(ctx, name)
			in := maps.Clone(request)
			in["phase"] = name
			check("in "+name, in)
			p.End()
			check("after "+name, request)
		}
	})
	if got := goroutineLabels(t); !maps.Equal(got, before) {
		t.Fatalf("after the request: goroutine labels %v, want %v", got, before)
	}
}
