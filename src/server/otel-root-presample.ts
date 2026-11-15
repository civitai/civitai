import type { IncomingMessage } from 'http';
import { ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import {
  ParentBasedSampler,
  RandomIdGenerator,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type IdGenerator,
  type Sampler,
} from '@opentelemetry/sdk-trace-node';
import { rootPresampleState } from '~/server/otel-root-presample-state';

export { setRootPresampleGate } from '~/server/otel-root-presample-state';

/**
 * Root pre-sampling for inbound HTTP requests, behind the `otel-root-presample` Flipt flag.
 *
 * Before any span work, the hook draws a new-root request's trace id and asks the ratio sampler:
 * unsampled runs with tracing suppressed; sampled hands that id to its root span, so the decision
 * stays a function of the trace id and a downstream hop re-applying the ratio keeps the trace.
 *
 * NOT pre-sampled (the hook returns false, draws nothing, and the normal sampler decides):
 *   - a request WITH a `traceparent` header: its decision is the remote-parent path of the
 *     ParentBased sampler, which this does not touch;
 *   - everything while the flag is off, unknown, or unreadable.
 *
 * What an unsampled request loses with the flag on (all were already non-exported): its log
 * records carry no trace/span id (there is no span to read them from), and `trace.getActiveSpan()`
 * reads undefined or invalid inside it. Outbound `traceContextHeaders()` still sends an unsampled
 * `traceparent` (see @civitai/telemetry/otel-helpers), so callees decide exactly as before.
 *
 * ⚠ One loss is NOT trace-only: the HTTP instrumentation records its own server duration metric
 * (`http.server.duration` / `http.server.request.duration`) only when it closes the request's
 * span, which an ignored request never has. In a process that exports OTel metrics, those
 * histograms then cover only the pre-sampled requests plus those with a `traceparent`, an
 * undercount with no error. Check that nothing reads them before turning the flag on.
 *
 * State (the gate and the stashed trace id) lives in ~/server/otel-root-presample-state, on
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
 * with tracing suppressed) only for an unsampled new-root request while the flag is on. For a
 * sampled one it stashes the drawn trace id for the root span and returns false.
 *
 * `rootSampler` must be the sampler the app applies to parentless spans, so the hook and the
 * tracer cannot disagree; `buildHeadSampling` wires both from one instance.
 */
export function createRootPresampleIgnoreHook(
  rootSampler: Sampler,
  generateTraceId: () => string
): (request: IncomingMessage) => boolean {
  return (request) => {
    // Never let an id stashed for an earlier request reach this one.
    rootPresampleState.pendingTraceId = undefined;
    if (!gateOn()) return false;
    if (request.headers?.traceparent !== undefined) return false;
    const traceId = generateTraceId();
    const { decision } = rootSampler.shouldSample(
      ROOT_CONTEXT,
      traceId,
      '',
      SpanKind.SERVER,
      {},
      []
    );
    if (decision !== SamplingDecision.RECORD_AND_SAMPLED) return true;
    rootPresampleState.pendingTraceId = traceId;
    // The instrumentation starts the root span synchronously after this hook returns; an id the
    // span never took (the instrumentation threw first) must not reach any later span.
    queueMicrotask(() => {
      if (rootPresampleState.pendingTraceId === traceId)
        rootPresampleState.pendingTraceId = undefined;
    });
    return false;
  };
}

/**
 * The tracer's id generator. Hands out the trace id the hook stashed, once, to the next span that
 * asks for a trace id (the tracer asks only for a span WITHOUT a parent, and the next one after
 * the hook is the instrumentation's root SERVER span). Everything else is the delegate's.
 */
export class PresampledRootIdGenerator implements IdGenerator {
  constructor(private readonly delegate: IdGenerator) {}

  generateTraceId(): string {
    const stashed = rootPresampleState.pendingTraceId;
    if (stashed !== undefined) {
      rootPresampleState.pendingTraceId = undefined;
      return stashed;
    }
    return this.delegate.generateTraceId();
  }

  generateSpanId(): string {
    return this.delegate.generateSpanId();
  }
}

/**
 * The app's head sampling, in one place so the pre-sample hook and the tracer share ONE ratio
 * sampler: ParentBased over TraceIdRatio(ratio), the id generator, and the ignore hook for the
 * HTTP instrumentation. Used by src/instrumentation.node.ts and by the tests.
 */
export function buildHeadSampling(
  ratio: number,
  baseIdGenerator: IdGenerator = new RandomIdGenerator()
): {
  sampler: Sampler;
  idGenerator: IdGenerator;
  ignoreIncomingRequestHook: (request: IncomingMessage) => boolean;
} {
  const ratioSampler = new TraceIdRatioBasedSampler(ratio);
  return {
    sampler: new ParentBasedSampler({
      root: ratioSampler,
      // This is a PUBLIC API with no traceparent stripping at the edge, so an
      // untrusted client could send `traceparent: ...-01` to force a sampled
      // decision. ParentBased's default `remoteParentSampled` is AlwaysOn, which
      // would let any client defeat the sampling cap and re-saturate CPU. Apply the
      // ratio to remote parents too. Local parents still inherit, so intra-process
      // traces stay coherent.
      remoteParentSampled: ratioSampler,
    }),
    idGenerator: new PresampledRootIdGenerator(baseIdGenerator),
    ignoreIncomingRequestHook: createRootPresampleIgnoreHook(ratioSampler, () =>
      baseIdGenerator.generateTraceId()
    ),
  };
}

/** Tests only. */
export function resetRootPresampleForTests(): void {
  rootPresampleState.gate = undefined;
  rootPresampleState.pendingTraceId = undefined;
}
