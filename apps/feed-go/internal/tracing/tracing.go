// Package tracing is feed-go's OpenTelemetry tracing: the exporter, the head sampler, the W3C trace
// context propagator, the pgx, go-redis and ClickHouse (chread) child spans, and the trace-id
// exemplars on the latency histograms (DESIGN.md §10.3).
//
// It mirrors the Node app's setup (src/instrumentation.node.ts) so one configuration drives both and a
// trace continues across browser → feed-go → Node: OTLP over HTTP/protobuf to
// `<OTEL_EXPORTER_OTLP_ENDPOINT>/v1/traces`, W3C `traceparent` (+ `baggage`) propagation, and
// ParentBased over a trace-id ratio of OTEL_TRACES_SAMPLE_RATIO (default 0.1) applied to remote
// sampled parents too, with the SAME trace-id → decision function as the JS sampler (NodeRatio), so
// both sides keep or drop the same traces.
//
// Off unless FEED_GO_OTEL_ENABLED=true and OTEL_EXPORTER_OTLP_ENDPOINT is set. Off, Setup returns nil
// and nothing in the service starts a span, extracts or injects a header, or attaches an exemplar.
package tracing

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// DefaultRatio is the Node app's default head-sampling ratio (OTEL_TRACES_SAMPLE_RATIO unset or invalid).
const DefaultRatio = 0.1

// DefaultServiceName is service.name when OTEL_SERVICE_NAME is unset.
const DefaultServiceName = "feed-go"

// TracerName is the instrumentation scope of every span this service starts.
const TracerName = "github.com/civitai/civitai/apps/feed-go"

// Config is the tracing environment.
type Config struct {
	// Enabled: FEED_GO_OTEL_ENABLED=true and Endpoint set. FEED_GO_OTEL_ENABLED is feed-go's own switch,
	// not the app's OTEL_ENABLED: feed-go's environment includes the shared app config, so a switch
	// read from there would turn tracing on with no change to feed-go's own deployment.
	Enabled bool
	// Endpoint is OTEL_EXPORTER_OTLP_ENDPOINT, the collector's base URL (as the Node app's): spans go to
	// <Endpoint>/v1/traces over HTTP/protobuf.
	Endpoint string
	// ServiceName is OTEL_SERVICE_NAME, else DefaultServiceName. The app's SERVICE_NAME is NOT read (the
	// Node app falls back to it): the shared app config carries the Node pool's, which is not this
	// service.
	ServiceName string
	// Ratio is OTEL_TRACES_SAMPLE_RATIO when it parses as a number in [0, 1], else DefaultRatio (the
	// Node app's rule).
	Ratio float64
}

// FromEnv reads Config through getenv (os.Getenv in production).
func FromEnv(getenv func(string) string) Config {
	c := Config{
		Endpoint:    strings.TrimSpace(getenv("OTEL_EXPORTER_OTLP_ENDPOINT")),
		ServiceName: strings.TrimSpace(getenv("OTEL_SERVICE_NAME")),
		Ratio:       DefaultRatio,
	}
	if c.ServiceName == "" {
		c.ServiceName = DefaultServiceName
	}
	if r, err := strconv.ParseFloat(strings.TrimSpace(getenv("OTEL_TRACES_SAMPLE_RATIO")), 64); err == nil && r >= 0 && r <= 1 {
		c.Ratio = r
	}
	c.Enabled = strings.EqualFold(strings.TrimSpace(getenv("FEED_GO_OTEL_ENABLED")), "true") && c.Endpoint != ""
	return c
}

// TracesURL is the OTLP/HTTP traces endpoint for a collector base URL, as the Node app builds it.
func TracesURL(endpoint string) string {
	return strings.TrimRight(endpoint, "/") + "/v1/traces"
}

// Provider is tracing when on: the tracer every span is started from, the propagator for inbound
// extraction and outbound injection, and Shutdown (flushes the batch exporter).
type Provider struct {
	Tracer     trace.Tracer
	Propagator propagation.TextMapPropagator
	tp         *sdktrace.TracerProvider
}

// Shutdown flushes and stops the exporter. Safe on nil.
func (p *Provider) Shutdown(ctx context.Context) error {
	if p == nil {
		return nil
	}
	return p.tp.Shutdown(ctx)
}

// Propagator is W3C trace context plus baggage: the Node SDK's default propagators.
func Propagator() propagation.TextMapPropagator {
	return propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{})
}

// Setup builds the provider for cfg, or returns nil when tracing is off. The exporter connects lazily:
// an unreachable collector costs dropped batches, never a failed start.
func Setup(ctx context.Context, cfg Config) (*Provider, error) {
	if !cfg.Enabled {
		return nil, nil
	}
	exp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(TracesURL(cfg.Endpoint)))
	if err != nil {
		return nil, fmt.Errorf("otlp trace exporter: %w", err)
	}
	return newProvider(cfg, sdktrace.NewBatchSpanProcessor(exp)), nil
}

// newProvider is Setup over any span processor (a test passes a recorder).
func newProvider(cfg Config, sp sdktrace.SpanProcessor) *Provider {
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(HeadSampler(cfg.Ratio)),
		sdktrace.WithSpanProcessor(sp),
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", cfg.ServiceName))),
	)
	return &Provider{Tracer: tp.Tracer(TracerName), Propagator: Propagator(), tp: tp}
}

// HeadSampler is the Node app's buildHeadSampling sampler: ParentBased over NodeRatio(ratio), with
// the ratio applied to remote SAMPLED parents too, so a `-01` traceparent alone does not force
// sampling; a remote unsampled parent is dropped, a local parent's decision is inherited. The ratio
// caps sampling for honest callers only: the decision is a function of the trace id, so a caller who
// picks a trace id whose words XOR low is sampled every time. Node's buildHeadSampling has the same
// property (parity, not a defence).
func HeadSampler(ratio float64) sdktrace.Sampler {
	r := NodeRatio(ratio)
	return sdktrace.ParentBased(r, sdktrace.WithRemoteParentSampled(r))
}

// NodeRatio is @opentelemetry/sdk-trace-base's TraceIdRatioBasedSampler, decision for decision: the
// four 32-bit big-endian words of the trace id XORed together, sampled when below
// floor(ratio × 0xffffffff). The Go SDK's TraceIDRatioBased reads the low 8 bytes instead, so for the
// same trace id and ratio it keeps a DIFFERENT 10%: a trace Node sampled would then continue in
// feed-go only at random. A ratio outside [0, 1] is clamped; NaN is 0 (as the JS sampler's).
func NodeRatio(ratio float64) sdktrace.Sampler {
	switch {
	case math.IsNaN(ratio) || ratio <= 0:
		ratio = 0
	case ratio >= 1:
		ratio = 1
	}
	return nodeRatio{bound: uint32(math.Floor(ratio * 0xffffffff)), desc: fmt.Sprintf("NodeTraceIdRatioBased{%g}", ratio)}
}

type nodeRatio struct {
	bound uint32
	desc  string
}

func (s nodeRatio) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
	res := sdktrace.SamplingResult{Decision: sdktrace.Drop, Tracestate: trace.SpanContextFromContext(p.ParentContext).TraceState()}
	if p.TraceID.IsValid() && accumulate(p.TraceID) < s.bound {
		res.Decision = sdktrace.RecordAndSample
	}
	return res
}

func (s nodeRatio) Description() string { return s.desc }

// accumulate is the JS sampler's _accumulate: the XOR of the trace id's four big-endian uint32 words.
func accumulate(id trace.TraceID) uint32 {
	return binary.BigEndian.Uint32(id[0:4]) ^ binary.BigEndian.Uint32(id[4:8]) ^
		binary.BigEndian.Uint32(id[8:12]) ^ binary.BigEndian.Uint32(id[12:16])
}
