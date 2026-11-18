// Package tracing: API STUBS ONLY (signatures, no behaviour), so the tests compile and fail by name
// on the pre-change code. Replaced by the implementation in the next commit.
package tracing

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type Config struct {
	Enabled     bool
	Endpoint    string
	ServiceName string
	Ratio       float64
}

func FromEnv(func(string) string) Config { return Config{} }

func TracesURL(endpoint string) string { return endpoint }

type Provider struct {
	Tracer     trace.Tracer
	Propagator propagation.TextMapPropagator
	tp         *sdktrace.TracerProvider
}

func (p *Provider) Shutdown(ctx context.Context) error {
	if p == nil {
		return nil
	}
	return p.tp.Shutdown(ctx)
}

func Propagator() propagation.TextMapPropagator { return propagation.NewCompositeTextMapPropagator() }

func Setup(context.Context, Config) (*Provider, error) { return nil, nil }

func newProvider(_ Config, sp sdktrace.SpanProcessor) *Provider {
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sp))
	return &Provider{Tracer: tp.Tracer("stub"), Propagator: Propagator(), tp: tp}
}

// HeadSampler: stub (the SDK default sampler).
func HeadSampler(float64) sdktrace.Sampler { return sdktrace.ParentBased(sdktrace.AlwaysSample()) }

// NodeRatio: stub (the Go SDK's own ratio sampler).
func NodeRatio(ratio float64) sdktrace.Sampler { return sdktrace.TraceIDRatioBased(ratio) }

type PgxTracer struct{ Tracer trace.Tracer }

func (PgxTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	return ctx
}
func (PgxTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func Operation(string) string { return "" }
func QueryHash(string) string { return "" }

type RedisHook struct {
	Tracer trace.Tracer
	Client string
}

func (RedisHook) DialHook(next redis.DialHook) redis.DialHook                               { return next }
func (RedisHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook                      { return next }
func (RedisHook) ProcessPipelineHook(n redis.ProcessPipelineHook) redis.ProcessPipelineHook { return n }

func Observe(_ context.Context, o prometheus.Observer, v float64) { o.Observe(v) }
