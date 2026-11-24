package server

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// phaseRecorder is a tracer provider over an in-memory recorder with the given sampler.
func phaseRecorder(sampler sdktrace.Sampler) (*sdktrace.TracerProvider, *tracetest.SpanRecorder) {
	rec := tracetest.NewSpanRecorder()
	return sdktrace.NewTracerProvider(sdktrace.WithSampler(sampler), sdktrace.WithSpanProcessor(rec)), rec
}

func intAttr(sp sdktrace.ReadOnlySpan, k attribute.Key) (int64, bool) {
	for _, kv := range sp.Attributes() {
		if kv.Key == k {
			return kv.Value.AsInt64(), true
		}
	}
	return 0, false
}

// A sampled served request on each of the three routes records its CPU phases as spans in the
// request's trace: `decode hydrate` (with the ids hydrated), `build page` (with the rows built) and
// `encode devalue` (a direct child of the request span, with the payload's size). The names are
// literals: they are the contract a trace query reads.
func TestServedRequestRecordsPhaseSpans(t *testing.T) {
	for _, bc := range routeBenchCases {
		t.Run(bc.name, func(t *testing.T) {
			w := bc.world(t)
			tp, rec := phaseRecorder(sdktrace.AlwaysSample())
			ctx, root := tp.Tracer("test").Start(trpc.WithDevalueWrite(context.Background()), "serve "+bc.name)
			c, err := w.run(ctx)
			root.End()
			if err != nil {
				t.Fatal(err)
			}
			defer c.release()
			trace := root.SpanContext().TraceID()
			byName := map[string][]sdktrace.ReadOnlySpan{}
			for _, sp := range rec.Ended() {
				if sp.SpanContext().TraceID() != trace {
					t.Fatalf("span %q is outside the request's trace", sp.Name())
				}
				byName[sp.Name()] = append(byName[sp.Name()], sp)
			}
			for _, name := range []string{"decode hydrate", "build page", "encode devalue"} {
				if len(byName[name]) == 0 {
					t.Fatalf("no %q span; spans: %v", name, spanNames(rec))
				}
			}
			for _, sp := range byName["decode hydrate"] {
				if n, ok := intAttr(sp, "feed_go.items"); !ok || n <= 0 {
					t.Errorf("decode hydrate: feed_go.items %d (set %v), want > 0", n, ok)
				}
			}
			built := int64(0)
			for _, sp := range byName["build page"] {
				n, ok := intAttr(sp, "feed_go.items")
				if !ok {
					t.Errorf("build page without feed_go.items")
				}
				built += n
			}
			// The image and model pages build exactly their served rows (the publish filter drops none
			// of these worlds' images); a gallery builds its posts' images.
			if bc.name != "as-posts" && built != int64(bc.items) {
				t.Errorf("build page: %d rows built, want %d", built, bc.items)
			}
			enc := byName["encode devalue"]
			if len(enc) != 1 || enc[0].Parent().SpanID() != root.SpanContext().SpanID() {
				t.Fatalf("encode devalue: %d spans, want one child of the request span", len(enc))
			}
			if n, _ := intAttr(enc[0], "feed_go.response.bytes"); n != int64(len(c.payload)) {
				t.Errorf("encode devalue: feed_go.response.bytes %d, want the payload's %d", n, len(c.payload))
			}
		})
	}
}

// An answer that is not devalue (an unmarked request: the shadow's, or an older client's) records
// `encode superjson`.
func TestSuperjsonAnswerRecordsItsEncodeSpan(t *testing.T) {
	w := routeBenchCases[0].world(t)
	tp, rec := phaseRecorder(sdktrace.AlwaysSample())
	ctx, root := tp.Tracer("test").Start(context.Background(), "shadow")
	c, err := w.run(ctx)
	root.End()
	if err != nil {
		t.Fatal(err)
	}
	defer c.release()
	for _, sp := range rec.Ended() {
		if sp.Name() == "encode superjson" {
			if n, _ := intAttr(sp, "feed_go.response.bytes"); n != int64(len(c.payload)) {
				t.Fatalf("encode superjson: feed_go.response.bytes %d, want %d", n, len(c.payload))
			}
			return
		}
	}
	t.Fatalf("no `encode superjson` span; spans: %v", spanNames(rec))
}

// An unsampled request records nothing: no phase starts a span of its own (a root) when the request
// span is not recording.
func TestUnsampledRequestRecordsNoPhaseSpans(t *testing.T) {
	for _, bc := range routeBenchCases {
		t.Run(bc.name, func(t *testing.T) {
			w := bc.world(t)
			tp, rec := phaseRecorder(sdktrace.NeverSample())
			ctx, root := tp.Tracer("test").Start(trpc.WithDevalueWrite(context.Background()), "serve "+bc.name)
			c, err := w.run(ctx)
			root.End()
			if err != nil {
				t.Fatal(err)
			}
			c.release()
			if n := len(rec.Ended()); n != 0 {
				t.Fatalf("%d spans recorded for an unsampled request: %v", n, spanNames(rec))
			}
		})
	}
}

func spanNames(rec *tracetest.SpanRecorder) []string {
	ended := rec.Ended()
	out := make([]string, 0, len(ended))
	for _, sp := range ended {
		out = append(out, sp.Name())
	}
	return out
}
