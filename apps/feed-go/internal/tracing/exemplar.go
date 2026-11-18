package tracing

import (
	"context"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/trace"
)

// ExemplarLabel is the exemplar label that carries the trace id (Grafana's default for a
// Prometheus-to-Tempo link).
const ExemplarLabel = "trace_id"

// Observe records v on o, with the trace id of ctx's span as an exemplar when that span is SAMPLED
// (only a sampled trace reaches the backend, so only it is worth linking). Without a sampled span it
// is o.Observe(v).
func Observe(ctx context.Context, o prometheus.Observer, v float64) {
	if sc := trace.SpanContextFromContext(ctx); sc.IsSampled() {
		if eo, ok := o.(prometheus.ExemplarObserver); ok {
			eo.ObserveWithExemplar(v, prometheus.Labels{ExemplarLabel: sc.TraceID().String()})
			return
		}
	}
	o.Observe(v)
}
