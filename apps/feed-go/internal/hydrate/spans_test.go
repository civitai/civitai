package hydrate

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/jspack"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

// spanRecorder is a tracer whose ended spans are recorded (every span sampled).
func spanRecorder(t *testing.T) (trace.Tracer, *tracetest.SpanRecorder) {
	t.Helper()
	rec := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	return tp.Tracer("test"), rec
}

// spanAttrs is s's attributes, each value as a string.
func spanAttrs(s sdktrace.ReadOnlySpan) map[attribute.Key]string {
	out := map[attribute.Key]string{}
	for _, kv := range s.Attributes() {
		out[kv.Key] = kv.Value.String()
	}
	return out
}

// named is the ended spans called name.
func named(rec *tracetest.SpanRecorder, name string) []sdktrace.ReadOnlySpan {
	var out []sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		if s.Name() == name {
			out = append(out, s)
		}
	}
	return out
}

// unsampled is a context whose span does not record.
func unsampled() context.Context {
	return trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{0x4b, 0xf9}, SpanID: trace.SpanID{1}}))
}

// joinRace runs a leader (on leaderCtx) and a joiner (on joinerCtx) through one flight of the image
// frames cache: the joiner reaches the flight while the leader's lookup is held, and the lookup then
// answers err (nil: id 1's record).
func joinRace(leaderCtx, joinerCtx context.Context, t *testing.T, c *MissCompute, err error) {
	t.Helper()
	var entered atomic.Int32
	c.beforeFlight = func() { entered.Add(1) }
	t.Cleanup(func() { c.beforeFlight = nil })
	l := &countingLookup{gate: func() {
		for entered.Load() < 2 {
			time.Sleep(time.Millisecond)
		}
		// The joiner is past beforeFlight; give it time to be inside Do.
		time.Sleep(200 * time.Millisecond)
	}}
	lookup := l.lookup
	if err != nil {
		lookup = func(ctx context.Context, ids []int) (map[int]jspack.Obj, error) {
			recs, _ := l.lookup(ctx, ids)
			return recs, err
		}
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = c.lookupShared(leaderCtx, MissImageFrames, []int{1, 2}, lookup)
	}()
	// The leader is inside its lookup (so it, not the joiner, runs the flight) before the joiner starts.
	for l.calls.Load() < 1 {
		time.Sleep(time.Millisecond)
	}
	_, joinErr := c.lookupShared(joinerCtx, MissImageFrames, []int{2, 1}, lookup)
	wg.Wait()
	if got := l.calls.Load(); got != 1 {
		t.Fatalf("%d lookups, want 1 (the joiner shares the leader's)", got)
	}
	if (joinErr != nil) != (err != nil) {
		t.Fatalf("joiner err %v, want %v", joinErr, err)
	}
}

// A lookup that joins another caller's flight gets a `miss lookup join` span on its OWN request span,
// covering its wait, with the cache and shared=true; the caller that ran the flight gets none (its
// queries are spanned on its context). A failed flight is the joiner's error status.
//
// Fails on: the join span dropped or started on the leader's context (parent check); every caller
// spanned, not only joiners (count 1); the start taken after the wait (duration); the error not
// marked (status).
func TestJoinSpan(t *testing.T) {
	tracer, rec := spanRecorder(t)
	c := &MissCompute{WriteBack: true, Tracer: tracer}
	lctx, leader := tracer.Start(context.Background(), "serve leader")
	jctx, joiner := tracer.Start(context.Background(), "serve joiner")
	joinRace(lctx, jctx, t, c, nil)
	leader.End()
	joiner.End()

	spans := named(rec, "miss lookup join")
	if len(spans) != 1 {
		t.Fatalf("%d join spans, want 1 (the joiner's only)", len(spans))
	}
	s := spans[0]
	if s.Parent().SpanID() != joiner.SpanContext().SpanID() {
		t.Fatalf("join span's parent %v, want the joiner's request span %v", s.Parent().SpanID(), joiner.SpanContext().SpanID())
	}
	if want := map[attribute.Key]string{"feed_go.miss.cache": "image-frames", "feed_go.miss.shared": "true"}; !reflect.DeepEqual(spanAttrs(s), want) {
		t.Fatalf("join span attributes %v, want %v", spanAttrs(s), want)
	}
	if s.Status().Code != codes.Unset {
		t.Fatalf("join span status %+v, want unset", s.Status())
	}
	if d := s.EndTime().Sub(s.StartTime()); d < 150*time.Millisecond {
		t.Fatalf("join span lasts %v, want the joiner's whole wait (the lookup is held 200 ms)", d)
	}

	rec.Reset()
	lctx, leader = tracer.Start(context.Background(), "serve leader")
	jctx, joiner = tracer.Start(context.Background(), "serve joiner")
	joinRace(lctx, jctx, t, c, errors.New("lookup failed"))
	leader.End()
	joiner.End()
	spans = named(rec, "miss lookup join")
	if len(spans) != 1 {
		t.Fatalf("failed flight: %d join spans, want 1", len(spans))
	}
	if s := spans[0]; s.Parent().SpanID() != joiner.SpanContext().SpanID() || s.Status().Code != codes.Error ||
		s.Status().Description != "other" || spanAttrs(s)["error.type"] != "*errors.errorString" {
		t.Fatalf("failed flight: join span status %+v, attrs %v; want error `other`, error.type *errors.errorString, under the joiner",
			s.Status(), spanAttrs(s))
	}
}

// No join span when the joiner's request span does not record (unsampled, or none), or when tracing
// is off (no Tracer) under a recording one; and none for an answer kept in recent (write-back off):
// it is a map read, no wait.
//
// Fails on: the recording check dropped (the "no span" case: the joiner's span would be a sampled
// root); a span on the recent path. The "unsampled" case is an invariant guard only: under the
// parent-based sampler a span started under an unsampled parent does not record and never reaches
// the recorder, so it passes with the recording check dropped too.
func TestJoinSpanOnlyWhenTraced(t *testing.T) {
	tracer, rec := spanRecorder(t)
	lctx, leader := tracer.Start(context.Background(), "serve leader")
	for name, jctx := range map[string]context.Context{"unsampled": unsampled(), "no span": context.Background()} {
		rec.Reset()
		joinRace(lctx, jctx, t, &MissCompute{WriteBack: true, Tracer: tracer}, nil)
		if n := len(named(rec, "miss lookup join")); n != 0 {
			t.Fatalf("%s: %d join spans, want 0", name, n)
		}
	}
	rec.Reset()
	jctx, joiner := tracer.Start(context.Background(), "serve joiner")
	joinRace(lctx, jctx, t, &MissCompute{WriteBack: true}, nil)
	joiner.End()
	leader.End()
	if n := len(named(rec, "miss lookup join")); n != 0 {
		t.Fatalf("no Tracer: %d join spans, want 0", n)
	}

	rec.Reset()
	c := &MissCompute{Tracer: tracer} // write-back off: answers are kept
	l := &countingLookup{}
	ctx, req := tracer.Start(context.Background(), "serve")
	for range 2 {
		if _, err := c.lookupShared(ctx, MissImageFrames, []int{1, 2}, l.lookup); err != nil {
			t.Fatal(err)
		}
	}
	req.End()
	if l.calls.Load() != 1 {
		t.Fatalf("%d lookups, want 1 (the second answered from recent)", l.calls.Load())
	}
	if len(rec.Ended()) != 1 {
		t.Fatalf("%d spans, want only the request's (no join, no recent span)", len(rec.Ended()))
	}
}

// lockWait runs awaitMetricHashes over image 33, whose populate lock another process holds, under
// ctx: with fill its hash has landed by the first read; with keyErr reading it fails. It returns the
// wait's error.
func lockWait(ctx context.Context, t *testing.T, tracer trace.Tracer, fill, keyErr bool) error {
	t.Helper()
	s, r, _ := coldSources(false)
	s.Compute.Tracer = tracer
	r.SetString(metricLockKey(33), []byte("1"))
	if keyErr {
		r.KeyErr = func(key string) error {
			if key == metricHashKey(33) {
				return testkit.ErrDown
			}
			return nil
		}
	}
	if fill {
		r.SetHash(metricHashKey(33), map[string]string{"Heart": "8", "_populatedAt": "1"})
	}
	return s.awaitMetricHashes(ctx, []int{33}, map[int]jspack.Obj{})
}

// The wait on another process's populate lock is one `metrics lock wait` span under the request's:
// the ids waited on, the Redis reads made and the outcome, exactly those attributes. Filled is unset
// status; exhausted (5 reads, 100 ms apart, over the default 500 ms lock-wait bound, nothing landed),
// the context's deadline or cancellation and a failed read are the error status, by class.
//
// Fails on: the span dropped or not under the request (count / parent); polls miscounted (1 / 5 / 0
// / 0 / 1; the bound reverted to 15 × 200 ms reads 15); an outcome misclassified, e.g. exhausted, a
// deadline or a cancellation read as read_error; the status not set on a failure.
func TestMetricsLockWaitSpan(t *testing.T) {
	tracer, rec := spanRecorder(t)
	for _, c := range []struct {
		name          string
		fill, keyErr  bool
		expired       bool
		cancelled     bool
		polls         string
		outcome       string
		code          codes.Code
		class, errTyp string
	}{
		{name: "filled", fill: true, polls: "1", outcome: "filled", code: codes.Unset},
		{name: "exhausted", polls: "5", outcome: "exhausted", code: codes.Error, class: "other", errTyp: "*errors.errorString"},
		{name: "deadline", expired: true, polls: "0", outcome: "ctx_done", code: codes.Error, class: "deadline"},
		{name: "cancelled", cancelled: true, polls: "0", outcome: "ctx_done", code: codes.Error, class: "canceled", errTyp: "*errors.errorString"},
		{name: "read error", keyErr: true, polls: "1", outcome: "read_error", code: codes.Error, class: "other", errTyp: "*errors.errorString"},
	} {
		rec.Reset()
		ctx, req := tracer.Start(context.Background(), "serve as-images")
		wctx, cancel := context.WithCancel(ctx)
		if c.expired {
			// Already past its deadline: the wait ends before its first read, deterministically.
			cancel()
			wctx, cancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
		}
		if c.cancelled {
			// Cancelled, not past a deadline: context.Canceled, before the first read.
			cancel()
		}
		err := lockWait(wctx, t, tracer, c.fill, c.keyErr)
		cancel()
		req.End()
		if (err == nil) != (c.code == codes.Unset) {
			t.Fatalf("%s: err %v", c.name, err)
		}
		spans := named(rec, "metrics lock wait")
		if len(spans) != 1 || spans[0].Parent().SpanID() != req.SpanContext().SpanID() {
			t.Fatalf("%s: %d wait spans, want one under the request", c.name, len(spans))
		}
		s := spans[0]
		want := map[attribute.Key]string{"feed_go.metrics.wait.ids": "1", "feed_go.metrics.wait.polls": c.polls,
			"feed_go.metrics.wait.outcome": c.outcome}
		if c.code == codes.Error {
			want["error.type"] = spanAttrs(s)["error.type"]
			if c.errTyp != "" && want["error.type"] != c.errTyp {
				t.Fatalf("%s: error.type %q, want %q", c.name, want["error.type"], c.errTyp)
			}
			if want["error.type"] == "" {
				t.Fatalf("%s: no error.type", c.name)
			}
		}
		if got := spanAttrs(s); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: attributes %v, want %v", c.name, got, want)
		}
		if s.Status().Code != c.code || s.Status().Description != c.class {
			t.Fatalf("%s: status %+v, want %v %q", c.name, s.Status(), c.code, c.class)
		}
	}
}

// No wait span without a recording request span, without a Tracer, or with nothing to wait on.
//
// Fails on: the recording check dropped (the "no span" case: the wait span would be a sampled root);
// the Tracer check dropped (a nil Tracer then panics); a span for an empty wait. The "unsampled" case
// is an invariant guard only, for the reason TestJoinSpanOnlyWhenTraced gives.
func TestMetricsLockWaitSpanOnlyWhenTraced(t *testing.T) {
	tracer, rec := spanRecorder(t)
	for name, ctx := range map[string]context.Context{"unsampled": unsampled(), "no span": context.Background()} {
		rec.Reset()
		if err := lockWait(ctx, t, tracer, true, false); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if n := len(rec.Started()); n != 0 {
			t.Fatalf("%s: %d spans started, want 0", name, n)
		}
	}
	rec.Reset()
	ctx, req := tracer.Start(context.Background(), "serve")
	if err := lockWait(ctx, t, nil, true, false); err != nil {
		t.Fatal(err)
	}
	s, _, _ := coldSources(false)
	s.Compute.Tracer = tracer
	if err := s.awaitMetricHashes(ctx, nil, map[int]jspack.Obj{}); err != nil {
		t.Fatal(err)
	}
	req.End()
	if len(rec.Ended()) != 1 {
		t.Fatalf("%d spans, want only the request's", len(rec.Ended()))
	}
}
