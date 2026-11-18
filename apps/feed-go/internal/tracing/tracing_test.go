package tracing

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/civitai/civitai/apps/feed-go/internal/chread"
)

func traceID(t *testing.T, hex string) trace.TraceID {
	t.Helper()
	id, err := trace.TraceIDFromHex(hex)
	if err != nil && hex != "00000000000000000000000000000000" {
		t.Fatal(err)
	}
	return id
}

// The expected decisions are the JS sampler's own (@opentelemetry/sdk-trace-base 2.5.0 and 2.8.0,
// TraceIdRatioBasedSampler.shouldSample, run on these ids), not this package's arithmetic. Two rows
// are ids the Go SDK's TraceIDRatioBased decides the OTHER way at 0.1 (ffffffff… and …80000000 it
// keeps, 0577cd69… it drops): with it, feed-go would keep a different 10% of Node's traces.
func TestNodeRatioMatchesTheJSSampler(t *testing.T) {
	for _, c := range []struct {
		ratio float64
		id    string
		want  bool
	}{
		{0.1, "00000000000000000000000000000001", true},
		{0.1, "ffffffff000000000000000000000000", false},
		{0.1, "00000000000000000000000080000000", false},
		{0.1, "00000000000000000000000019999998", true},  // floor(0.1 × 0xffffffff) - 1
		{0.1, "00000000000000000000000019999999", false}, // the bound itself: strictly below
		{0.1, "4bf92f3577b34da6a3ce929d0e0e4736", false},
		{0.1, "0577cd69a35d1adc3df3616183b98451", true},
		{0.1, "15fc5729ed7bf127e34debbb0c53c56a", true},
		{0.1, "00000000000000000000000000000000", false}, // invalid id
		{0.5, "00000000000000000000000019999999", true},
		{0.5, "00000000000000000000000080000000", false},
		{1, "4bf92f3577b34da6a3ce929d0e0e4736", true},
		{1, "ffffffff000000000000000000000000", false}, // 0xffffffff is not below floor(1 × 0xffffffff)
		{0, "00000000000000000000000000000001", false},
		{-3, "00000000000000000000000000000001", false},
		{7, "4bf92f3577b34da6a3ce929d0e0e4736", true},
	} {
		got := NodeRatio(c.ratio).ShouldSample(sdktrace.SamplingParameters{
			ParentContext: context.Background(), TraceID: traceID(t, c.id),
		}).Decision == sdktrace.RecordAndSample
		if got != c.want {
			t.Errorf("NodeRatio(%v) on %s sampled = %v, want %v", c.ratio, c.id, got, c.want)
		}
	}
}

func parentCtx(t *testing.T, id string, sampled, remote bool) context.Context {
	t.Helper()
	cfg := trace.SpanContextConfig{TraceID: traceID(t, id), SpanID: trace.SpanID{0, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7}, Remote: remote}
	if sampled {
		cfg.TraceFlags = trace.FlagsSampled
	}
	return trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(cfg))
}

// ParentBased over the ratio, the ratio applied to remote sampled parents too (Node's
// remoteParentSampled): a `-01` traceparent alone does not force sampling (a caller-chosen low-XOR
// trace id does, as in Node); a remote unsampled parent is
// dropped whatever the ratio says; a local parent's decision is inherited.
func TestHeadSamplerHonoursTheParentAndTheRatio(t *testing.T) {
	const in, out = "0577cd69a35d1adc3df3616183b98451", "4bf92f3577b34da6a3ce929d0e0e4736" // in / out of 0.1
	s := HeadSampler(0.1)
	for _, c := range []struct {
		name string
		ctx  context.Context
		id   string
		want bool
	}{
		{"root, in the ratio", context.Background(), in, true},
		{"root, out of the ratio", context.Background(), out, false},
		{"remote sampled parent, in the ratio", parentCtx(t, in, true, true), in, true},
		{"remote sampled parent, out of the ratio: not forced", parentCtx(t, out, true, true), out, false},
		{"remote unsampled parent, in the ratio: dropped", parentCtx(t, in, false, true), in, false},
		{"local sampled parent, out of the ratio: inherited", parentCtx(t, out, true, false), out, true},
		{"local unsampled parent, in the ratio: inherited", parentCtx(t, in, false, false), in, false},
	} {
		got := s.ShouldSample(sdktrace.SamplingParameters{ParentContext: c.ctx, TraceID: traceID(t, c.id)}).Decision == sdktrace.RecordAndSample
		if got != c.want {
			t.Errorf("%s: sampled = %v, want %v", c.name, got, c.want)
		}
	}
}

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestFromEnv(t *testing.T) {
	for _, c := range []struct {
		name string
		env  map[string]string
		want Config
	}{
		{"nothing set: off", nil, Config{ServiceName: "feed-go", Ratio: 0.1}},
		{"the app's OTEL_ENABLED alone does not turn it on", map[string]string{
			"OTEL_ENABLED": "true", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector.example:4318", "SERVICE_NAME": "node-pool",
		}, Config{Endpoint: "http://collector.example:4318", ServiceName: "feed-go", Ratio: 0.1}},
		{"switch without an endpoint: off", map[string]string{"FEED_GO_OTEL_ENABLED": "true"},
			Config{ServiceName: "feed-go", Ratio: 0.1}},
		{"on", map[string]string{
			"FEED_GO_OTEL_ENABLED": "TRUE", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector.example:4318",
			"OTEL_SERVICE_NAME": "civitai-feed-go", "OTEL_TRACES_SAMPLE_RATIO": "0.25",
		}, Config{Enabled: true, Endpoint: "http://collector.example:4318", ServiceName: "civitai-feed-go", Ratio: 0.25}},
		{"ratio above 1: the default", map[string]string{"OTEL_TRACES_SAMPLE_RATIO": "1.5"}, Config{ServiceName: "feed-go", Ratio: 0.1}},
		{"ratio negative: the default", map[string]string{"OTEL_TRACES_SAMPLE_RATIO": "-0.2"}, Config{ServiceName: "feed-go", Ratio: 0.1}},
		{"ratio junk: the default", map[string]string{"OTEL_TRACES_SAMPLE_RATIO": "lots"}, Config{ServiceName: "feed-go", Ratio: 0.1}},
		{"ratio 0 is kept", map[string]string{"OTEL_TRACES_SAMPLE_RATIO": "0"}, Config{ServiceName: "feed-go", Ratio: 0}},
	} {
		if got := FromEnv(env(c.env)); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestTracesURL(t *testing.T) {
	for in, want := range map[string]string{
		"http://collector.example:4318":  "http://collector.example:4318/v1/traces",
		"http://collector.example:4318/": "http://collector.example:4318/v1/traces",
	} {
		if got := TracesURL(in); got != want {
			t.Errorf("TracesURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSetupOffIsNil(t *testing.T) {
	p, err := Setup(context.Background(), Config{Endpoint: "http://collector.example:4318"})
	if p != nil || err != nil {
		t.Fatalf("Setup(off) = %v, %v; want nil, nil", p, err)
	}
	if err := p.Shutdown(context.Background()); err != nil {
		t.Fatalf("nil Shutdown = %v", err)
	}
}

// recorder is a provider over the head sampler at ratio 1 whose spans are recorded in memory.
func recorder(t *testing.T) (*Provider, *tracetest.SpanRecorder) {
	t.Helper()
	rec := tracetest.NewSpanRecorder()
	p := newProvider(Config{ServiceName: "feed-go", Ratio: 1}, rec)
	t.Cleanup(func() { _ = p.Shutdown(context.Background()) })
	return p, rec
}

func attrs(s sdktrace.ReadOnlySpan) map[attribute.Key]string {
	out := map[attribute.Key]string{}
	for _, kv := range s.Attributes() {
		out[kv.Key] = kv.Value.String()
	}
	return out
}

const sentinel = "SENTINEL_USER_42"

// A query span names the statement (operation, hash of the SQL), never a bind value; under an
// unsampled request no span is started.
func TestPgxTracer(t *testing.T) {
	p, rec := recorder(t)
	pt := PgxTracer{Tracer: p.Tracer}
	ctx, parent := p.Tracer.Start(context.Background(), "serve as-posts")
	const sql = `SELECT id FROM "User" WHERE username = $1 LIMIT 1`
	qctx := pt.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: sql, Args: []any{sentinel}})
	pt.TraceQueryEnd(qctx, nil, pgx.TraceQueryEndData{CommandTag: pgconn.NewCommandTag("SELECT 1")})
	qctx = pt.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: "  -- lead\n/* c */ with x as (select 1) select * from x", Args: []any{sentinel}})
	pt.TraceQueryEnd(qctx, nil, pgx.TraceQueryEndData{Err: &pgconn.PgError{Code: "22P02", Message: "invalid input syntax: " + sentinel}})
	parent.End()

	ended := rec.Ended()
	if len(ended) != 3 {
		t.Fatalf("%d spans, want 2 queries + the parent", len(ended))
	}
	q := ended[0]
	if q.Name() != "pgx SELECT" || q.SpanKind() != trace.SpanKindClient || q.Parent().SpanID() != parent.SpanContext().SpanID() {
		t.Fatalf("query span %q kind %v parent %v", q.Name(), q.SpanKind(), q.Parent().SpanID())
	}
	want := map[attribute.Key]string{
		"db.system.name": "postgresql", "db.operation.name": "SELECT", "db.query.hash": "5e0991a9515536ee",
		"db.response.rows_affected": "1",
	}
	if got := attrs(q); len(got) != len(want) {
		t.Fatalf("attributes %v, want %v", got, want)
	} else {
		for k, v := range want {
			if got[k] != v {
				t.Fatalf("attribute %s = %q, want %q (all: %v)", k, got[k], v, got)
			}
		}
	}
	e := ended[1]
	if e.Name() != "pgx WITH" || e.Status().Code != codes.Error || e.Status().Description != "pg_22" || attrs(e)["error.type"] != "*pgconn.PgError" {
		t.Fatalf("error span %q status %+v attrs %v", e.Name(), e.Status(), attrs(e))
	}
	for _, s := range ended {
		for _, kv := range s.Attributes() {
			if strings.Contains(kv.Value.String(), sentinel) {
				t.Fatalf("span %q attribute %s carries the bind value / error text", s.Name(), kv.Key)
			}
		}
	}

	// Unsampled request: nothing started, and End finds nothing to end.
	rec.Reset()
	uctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID(t, "4bf92f3577b34da6a3ce929d0e0e4736"), SpanID: trace.SpanID{1}}))
	qctx = pt.TraceQueryStart(uctx, nil, pgx.TraceQueryStartData{SQL: sql})
	pt.TraceQueryEnd(qctx, nil, pgx.TraceQueryEndData{})
	if n := len(rec.Started()); n != 0 {
		t.Fatalf("%d spans started under an unsampled request, want 0", n)
	}
}

func TestOperation(t *testing.T) {
	for in, want := range map[string]string{
		"select 1":                       "SELECT",
		"\n\t  UPDATE x SET y = 1":       "UPDATE",
		"-- c\nWITH a AS (SELECT 1) x":   "WITH",
		"/* SELECT */ delete from t":     "DELETE",
		"(SELECT 1)":                     "OTHER",
		"":                               "OTHER",
		"/* unterminated":                "OTHER",
		"abcdefghijklmnopqrstuvwxyz foo": "ABCDEFGHIJKLMNOP",
	} {
		if got := Operation(in); got != want {
			t.Errorf("Operation(%q) = %q, want %q", in, got, want)
		}
	}
}

// A command span carries its name, never its key or arguments; a miss (redis.Nil) is not an error;
// a pipeline is one span with its command count.
func TestRedisHook(t *testing.T) {
	p, rec := recorder(t)
	h := RedisHook{Tracer: p.Tracer, Client: "cache"}
	ctx, parent := p.Tracer.Start(context.Background(), "serve as-posts")
	miss := h.ProcessHook(func(context.Context, redis.Cmder) error { return redis.Nil })
	if err := miss(ctx, redis.NewStringCmd(ctx, "get", "session:"+sentinel)); !errors.Is(err, redis.Nil) {
		t.Fatalf("hook changed the error: %v", err)
	}
	fail := h.ProcessHook(func(context.Context, redis.Cmder) error { return errors.New("dial tcp: " + sentinel) })
	_ = fail(ctx, redis.NewStringCmd(ctx, "hget", "user:"+sentinel, "f"))
	pipe := h.ProcessPipelineHook(func(context.Context, []redis.Cmder) error { return nil })
	_ = pipe(ctx, []redis.Cmder{redis.NewStringCmd(ctx, "get", "a"), redis.NewStringCmd(ctx, "get", "b"), redis.NewStringCmd(ctx, "get", "c")})
	parent.End()

	ended := rec.Ended()
	if len(ended) != 4 {
		t.Fatalf("%d spans, want 3 + the parent", len(ended))
	}
	if s := ended[0]; s.Name() != "redis get" || s.Status().Code != codes.Unset ||
		attrs(s)["db.operation.name"] != "get" || attrs(s)["feed_go.redis"] != "cache" || attrs(s)["db.system.name"] != "redis" {
		t.Fatalf("miss span %q status %+v attrs %v", s.Name(), s.Status(), attrs(s))
	}
	if s := ended[1]; s.Name() != "redis hget" || s.Status().Code != codes.Error || s.Status().Description != "other" {
		t.Fatalf("error span %q status %+v", s.Name(), s.Status())
	}
	if s := ended[2]; s.Name() != "redis pipeline" || attrs(s)["db.operation.batch.size"] != "3" {
		t.Fatalf("pipeline span %q attrs %v", s.Name(), attrs(s))
	}
	for _, s := range ended {
		if strings.Contains(s.Status().Description, sentinel) {
			t.Fatalf("span %q status carries the error text", s.Name())
		}
		for _, kv := range s.Attributes() {
			if strings.Contains(kv.Value.String(), sentinel) {
				t.Fatalf("span %q attribute %s carries a key or argument", s.Name(), kv.Key)
			}
		}
	}

	rec.Reset()
	calls := 0
	plain := h.ProcessHook(func(context.Context, redis.Cmder) error { calls++; return nil })
	_ = plain(context.Background(), redis.NewStringCmd(context.Background(), "get", "a"))
	if calls != 1 || len(rec.Started()) != 0 {
		t.Fatalf("no request span: calls=%d spans=%d, want 1 and 0", calls, len(rec.Started()))
	}
}

// A ClickHouse read through chread is one client span under the request's, `clickhouse query`, with
// the system, operation and row count only: never the SQL (the metrics read inlines its ids), the
// request URL (it carries the query) or the login. A failure is the error status (its class) and
// error.type, never the exception text (it quotes the query); a timeout is `deadline`. Under an
// unsampled request, or none, no span is started. Only the no-span case fails with the recording
// check dropped (the read's span would be a sampled root); the unsampled case is an invariant guard,
// since under the parent-based sampler a span started under an unsampled parent does not record.
func TestClickHouseTracer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Query().Get("query"), "fail"):
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("Code: 241. DB::Exception: memory limit exceeded in query " + sentinel))
		case strings.Contains(r.URL.Query().Get("query"), "hang"):
			<-r.Context().Done()
		default:
			_, _ = w.Write([]byte("{\"entityId\":8001,\"value\":5}\n{\"entityId\":8002,\"value\":7}\n"))
		}
	}))
	t.Cleanup(srv.Close)
	p, rec := recorder(t)
	c, err := chread.New(chread.Config{URL: srv.URL + "/metricsdb", Username: "reader", Password: sentinel + "-pw",
		HTTP: srv.Client(), Tracer: ClickHouseTracer{Tracer: p.Tracer}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, parent := p.Tracer.Start(context.Background(), "serve as-images")
	if rows, err := c.Query(ctx, "\n  SELECT entityId FROM m WHERE entityId IN (8001, "+sentinel+")", nil); err != nil || len(rows) != 2 {
		t.Fatalf("ok read: %d rows, %v", len(rows), err)
	}
	if _, err := c.Query(ctx, "SELECT fail /* "+sentinel+" */", nil); err == nil {
		t.Fatal("failing read: no error")
	}
	tctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	_, err = c.Query(tctx, "SELECT hang", nil)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("hanging read: %v, want the deadline", err)
	}
	parent.End()

	ended := rec.Ended()
	if len(ended) != 4 {
		t.Fatalf("%d spans, want 3 reads + the parent", len(ended))
	}
	for _, s := range ended[:3] {
		if s.Name() != "clickhouse query" || s.SpanKind() != trace.SpanKindClient || s.Parent().SpanID() != parent.SpanContext().SpanID() {
			t.Fatalf("read span %q kind %v parent %v; want `clickhouse query`, client, under the request", s.Name(), s.SpanKind(), s.Parent().SpanID())
		}
	}
	want := map[attribute.Key]string{"db.system.name": "clickhouse", "db.operation.name": "SELECT", "db.response.returned_rows": "2"}
	if got := attrs(ended[0]); !reflect.DeepEqual(got, want) {
		t.Fatalf("ok read attributes %v, want %v", got, want)
	}
	if s := ended[0]; s.Status().Code != codes.Unset {
		t.Fatalf("ok read status %+v, want unset", s.Status())
	}
	if s := ended[1]; s.Status().Code != codes.Error || s.Status().Description != "http_5xx" ||
		!reflect.DeepEqual(attrs(s), map[attribute.Key]string{"db.system.name": "clickhouse", "db.operation.name": "SELECT", "error.type": "*chread.ServerError"}) {
		t.Fatalf("failed read status %+v attrs %v; want error http_5xx, error.type *chread.ServerError", s.Status(), attrs(s))
	}
	if s := ended[2]; s.Status().Code != codes.Error || s.Status().Description != "deadline" || attrs(s)["error.type"] == "" {
		t.Fatalf("timed-out read status %+v attrs %v; want error deadline with an error.type", s.Status(), attrs(s))
	}
	host := strings.TrimPrefix(srv.URL, "http://")
	for _, s := range ended {
		texts := []string{s.Status().Description}
		for _, kv := range s.Attributes() {
			texts = append(texts, kv.Value.String())
		}
		for _, e := range s.Events() {
			texts = append(texts, e.Name)
			for _, kv := range e.Attributes {
				texts = append(texts, kv.Value.String())
			}
		}
		for _, txt := range texts {
			for _, banned := range []string{sentinel, host, "metricsdb", "FROM", "entityId", "fail", "hang"} {
				if strings.Contains(txt, banned) {
					t.Fatalf("span %q carries %q (in %q): the SQL, URL or login", s.Name(), banned, txt)
				}
			}
		}
	}

	// No recording request span (unsampled, or none at all): the read runs, nothing is started. The
	// root (context.Background) case is the one that catches a dropped recording check.
	rec.Reset()
	uctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID(t, "4bf92f3577b34da6a3ce929d0e0e4736"), SpanID: trace.SpanID{1}}))
	for _, ctx := range []context.Context{uctx, context.Background()} {
		if rows, err := c.Query(ctx, "SELECT 1", nil); err != nil || len(rows) != 2 {
			t.Fatalf("untraced read: %d rows, %v", len(rows), err)
		}
	}
	if n := len(rec.Started()); n != 0 {
		t.Fatalf("%d spans started without a recording request span, want 0", n)
	}
}

// exemplars reads the bucket exemplars of h's one series.
func exemplars(t *testing.T, h prometheus.Histogram) []string {
	t.Helper()
	var m dto.Metric
	if err := h.Write(&m); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, b := range m.GetHistogram().GetBucket() {
		if e := b.GetExemplar(); e != nil {
			for _, l := range e.GetLabel() {
				out = append(out, l.GetName()+"="+l.GetValue())
			}
		}
	}
	return out
}

func TestObserveExemplarOnlyForASampledSpan(t *testing.T) {
	newH := func() prometheus.Histogram {
		return prometheus.NewHistogram(prometheus.HistogramOpts{Name: "h", Buckets: []float64{1}})
	}
	const id = "4bf92f3577b34da6a3ce929d0e0e4736"
	h := newH()
	Observe(parentCtx(t, id, true, false), h, 0.5)
	if got := exemplars(t, h); len(got) != 1 || got[0] != "trace_id="+id {
		t.Fatalf("sampled span: exemplars %v, want [trace_id=%s]", got, id)
	}
	for name, ctx := range map[string]context.Context{
		"unsampled span": parentCtx(t, id, false, false),
		"no span":        context.Background(),
	} {
		h := newH()
		Observe(ctx, h, 0.5)
		var m dto.Metric
		_ = h.Write(&m)
		if got := exemplars(t, h); len(got) != 0 || m.GetHistogram().GetSampleCount() != 1 {
			t.Fatalf("%s: exemplars %v count %d, want none and 1", name, got, m.GetHistogram().GetSampleCount())
		}
	}
}
