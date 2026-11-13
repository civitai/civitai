import type { IncomingMessage } from 'http';
import { SpanKind, trace, type Attributes, type Context, type Link } from '@opentelemetry/api';
import { SamplingDecision, type Sampler, type SamplingResult } from '@opentelemetry/sdk-trace-node';
import { rootPresampleState } from '~/server/otel-root-presample-state';

export { setRootPresampleGate } from '~/server/otel-root-presample-state';

/**
 * Root pre-sampling for inbound HTTP requests, behind the `otel-root-presample` Flipt flag.
 *
 * WHY. The head sampler (ParentBased over TraceIdRatio, src/instrumentation.node.ts) decides at the
 * request's root span, so an UNSAMPLED request still pays for everything that runs before and
 * around that decision: the HTTP instrumentation builds the full span attribute set (URL, headers,
 * user agent, net attributes), extracts context, starts the span, wires response listeners and
 * builds response attributes on close; and every Next.js and `withSpan` span under it still runs
 * the sampler and allocates ids. None of it is ever exported.
 *
 * WHAT. With the flag on, the HTTP instrumentation's `ignoreIncomingRequestHook` makes the same
 * decision FIRST, for a request that carries no `traceparent` (a new root):
 *   - unsampled (probability 1 - ratio): the request is IGNORED. The instrumentation then runs it
 *     under suppressed tracing, so no span is built for it and every span below it short-circuits
 *     in the SDK before the sampler.
 *   - sampled (probability ratio): the hook leaves a one-shot mark, and `PresampledRootSampler`
 *     answers RECORD_AND_SAMPLED for the root SERVER span the instrumentation starts next — in the
 *     same synchronous call, so nothing can come between them. The span, its name, its attributes
 *     and its children are exactly what the ratio sampler would have produced for a sampled trace.
 * The sampled share stays `ratio` (a uniform draw against `ratio` in place of a uniform trace-id
 * draw against `ratio`), so span-derived metrics, which count what reaches the collector, keep
 * their scale.
 *
 * NOT pre-sampled (the hook returns false, the mark stays clear, the normal sampler decides):
 *   - a request WITH a `traceparent` header: its decision is the remote-parent path of the
 *     ParentBased sampler, which this does not touch;
 *   - everything while the flag is off, unknown, or unreadable.
 *
 * What an unsampled request loses with the flag on (all were already non-exported): its log
 * records carry no trace/span id (there is no span to read them from), and `trace.getActiveSpan()`
 * reads undefined or invalid inside it. Outbound `traceContextHeaders()` still sends an unsampled
 * `traceparent` (see @civitai/telemetry/otel-helpers), so callees decide exactly as before.
 *
 * State (the gate and the one-shot mark) lives in ~/server/otel-root-presample-state, on
 * `globalThis`.
 */
function gateOn(): boolean {
  const gate = rootPresampleState.gate;
  if (gate === undefined) return false;
  try {
    return gate() === true;
  } catch {
    return false;
  }
}

/**
 * The HTTP instrumentation's `ignoreIncomingRequestHook`. Returns true (ignore: run the request
 * with tracing suppressed) only for an unsampled new-root request while the flag is on.
 */
export function createRootPresampleIgnoreHook(
  ratio: number,
  random: () => number = Math.random
): (request: IncomingMessage) => boolean {
  return (request) => {
    // Never let a mark from an earlier request survive into this one.
    rootPresampleState.pendingSampled = false;
    if (!gateOn()) return false;
    if (request.headers?.traceparent !== undefined) return false;
    if (random() < ratio) {
      rootPresampleState.pendingSampled = true;
      // The instrumentation starts the root span synchronously after this hook returns; a mark the
      // span never consumed (the instrumentation threw first) must not reach any later span.
      queueMicrotask(() => {
        rootPresampleState.pendingSampled = false;
      });
      return false;
    }
    return true;
  };
}

/**
 * Wraps the app's head sampler. Answers RECORD_AND_SAMPLED, once, for the root SERVER span of a
 * request the hook pre-sampled; delegates every other call unchanged (including the call that
 * consumes a mark it cannot apply).
 */
export class PresampledRootSampler implements Sampler {
  constructor(private readonly delegate: Sampler) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    if (rootPresampleState.pendingSampled) {
      rootPresampleState.pendingSampled = false;
      if (spanKind === SpanKind.SERVER && trace.getSpanContext(context) === undefined) {
        // The ratio sampler's sampled answer carries nothing else (no attributes, no trace state),
        // so the recorded span is the same as on the normal path.
        return { decision: SamplingDecision.RECORD_AND_SAMPLED };
      }
    }
    return this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `PresampledRoot{${this.delegate.toString()}}`;
  }
}

/** Tests only. */
export function resetRootPresampleForTests(): void {
  rootPresampleState.gate = undefined;
  rootPresampleState.pendingSampled = false;
}
