import { context, trace } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type Sampler, WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_USER_AGENT_ORIGINAL,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import {
  FaroMetaAttributesSpanProcessor,
  FaroTraceExporter,
  getDefaultOTELInstrumentations,
  TracingInstrumentation,
  type TracingInstrumentationOptions,
} from '@grafana/faro-web-tracing';

/**
 * `TracingInstrumentation` that installs a GENUINE OTel `Sampler` on the browser
 * WebTracerProvider instead of Faro's default session-coupled sampler.
 *
 * Stock `@grafana/faro-web-tracing@2.8.2` hardcodes the provider sampler to
 * `{ shouldSample: () => getSamplingDecision(session) }` — a browser span is recorded iff
 * the *session* is sampled. With `sessionTracking.samplingRate = 1.0` that records ~100% of
 * browser traces, which is too much volume to widen RUM past the mod cohort. This subclass
 * swaps ONLY that sampler for a caller-supplied ratio sampler, so span volume drops to the
 * ratio while session sampling (and therefore errors + web-vitals + events + sessions) stays
 * at 100%. See `~/utils/faro/traceSampler`.
 *
 * IMPLEMENTATION NOTE (fragile — re-sync on any faro-web-tracing bump):
 * `TracingInstrumentationOptions` in 2.8.2 exposes no `sampler` option and the provider is
 * constructed + globally registered inside a single private `initialize()`, so the only way
 * to change the sampler is to reimplement that method. `initialize()` below is a faithful
 * 1:1 copy of `@grafana/faro-web-tracing@2.8.2` `dist/esm/instrumentation.js` — same resource
 * attributes, same `FaroMetaAttributesSpanProcessor(BatchSpanProcessor(FaroTraceExporter))`
 * chain, same W3C propagator, same default fetch/xhr instrumentations, same `initOTEL` — with
 * exactly one change: `sampler: options.sampler`. If faro-web-tracing is upgraded, diff its
 * `initialize()` against this and re-sync.
 */

// Incubating semantic-convention keys. faro-web-tracing copies these plain strings into its
// own codebase rather than importing `@opentelemetry/semantic-conventions/incubating` (which
// may break in minor bumps); we mirror that here. Kept byte-identical to
// `@grafana/faro-web-tracing@2.8.2` dist/esm/semconv.js.
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';
const ATTR_SERVICE_NAMESPACE = 'service.namespace';
const ATTR_PROCESS_RUNTIME_NAME = 'process.runtime.name';
const ATTR_PROCESS_RUNTIME_VERSION = 'process.runtime.version';
const ATTR_TELEMETRY_DISTRO_NAME = 'telemetry.distro.name';
const ATTR_TELEMETRY_DISTRO_VERSION = 'telemetry.distro.version';
const ATTR_BROWSER_BRANDS = 'browser.brands';
const ATTR_BROWSER_LANGUAGE = 'browser.language';
const ATTR_BROWSER_MOBILE = 'browser.mobile';
const ATTR_BROWSER_PLATFORM = 'browser.platform';

export interface SampledTracingInstrumentationOptions extends TracingInstrumentationOptions {
  /** Genuine OTel sampler applied at the browser tracer-provider (span) level. */
  sampler: Sampler;
}

export class SampledTracingInstrumentation extends TracingInstrumentation {
  // Own copy of the options — the parent stores them in a `private` field we can't read.
  private readonly sampledOptions: SampledTracingInstrumentationOptions;

  constructor(options: SampledTracingInstrumentationOptions) {
    super(options);
    this.sampledOptions = options;
  }

  override initialize(): void {
    const options = this.sampledOptions;
    const attributes: Attributes = {};

    if (this.config.app.name) {
      attributes[ATTR_SERVICE_NAME] = this.config.app.name;
    }
    if (this.config.app.namespace) {
      attributes[ATTR_SERVICE_NAMESPACE] = this.config.app.namespace;
    }
    if (this.config.app.version) {
      attributes[ATTR_SERVICE_VERSION] = this.config.app.version;
    }
    if (this.config.app.environment) {
      attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] = this.config.app.environment;
      // Deprecated key kept for compatibility, mirroring faro-web-tracing.
      attributes[SEMRESATTRS_DEPLOYMENT_ENVIRONMENT] = this.config.app.environment;
    }

    const browserMeta = this.metas.value.browser;
    if (Array.isArray(browserMeta?.brands)) {
      attributes[ATTR_BROWSER_BRANDS] = browserMeta.brands.map((entry) => entry.brand);
    }
    if (browserMeta?.language) {
      attributes[ATTR_BROWSER_LANGUAGE] = browserMeta.language;
    }
    if (typeof browserMeta?.mobile === 'boolean') {
      attributes[ATTR_BROWSER_MOBILE] = Boolean(browserMeta.mobile);
    }
    if (browserMeta?.os) {
      attributes[ATTR_BROWSER_PLATFORM] = browserMeta.os;
    }
    if (browserMeta?.userAgent) {
      attributes[ATTR_USER_AGENT_ORIGINAL] = browserMeta.userAgent;
    }

    attributes[ATTR_PROCESS_RUNTIME_NAME] = 'browser';
    attributes[ATTR_PROCESS_RUNTIME_VERSION] = this.metas.value.browser?.userAgent;
    attributes[ATTR_TELEMETRY_DISTRO_NAME] = 'faro-web-sdk';
    attributes[ATTR_TELEMETRY_DISTRO_VERSION] = this.version;

    Object.assign(attributes, options.resourceAttributes);

    const resource = defaultResource().merge(resourceFromAttributes(attributes));

    const provider = new WebTracerProvider({
      resource,
      // THE decoupling: a genuine span-level sampler, NOT faro's session-coupled default
      // (`{ shouldSample: () => getSamplingDecision(this.api.getSession()) }`). This is the
      // ONLY line that differs from stock faro-web-tracing@2.8.2 initialize().
      sampler: options.sampler,
      spanProcessors: [
        options.spanProcessor ??
          new FaroMetaAttributesSpanProcessor(
            new BatchSpanProcessor(new FaroTraceExporter({ api: this.api }), {
              scheduledDelayMillis: TracingInstrumentation.SCHEDULED_BATCH_DELAY_MS,
              maxExportBatchSize: 30,
            }),
            this.metas
          ),
      ],
    });

    provider.register({
      propagator: options.propagator ?? new W3CTraceContextPropagator(),
      contextManager: options.contextManager,
    });

    const { propagateTraceHeaderCorsUrls, fetchInstrumentationOptions, xhrInstrumentationOptions } =
      options.instrumentationOptions ?? {};

    registerInstrumentations({
      instrumentations:
        options.instrumentations ??
        getDefaultOTELInstrumentations({
          ignoreUrls: this.computeIgnoreUrls(),
          propagateTraceHeaderCorsUrls,
          fetchInstrumentationOptions,
          xhrInstrumentationOptions,
        }),
    });

    this.api.initOTEL(trace, context);
  }

  // Mirrors the parent's `private getIgnoreUrls()` (renamed to avoid clashing with the
  // parent's private member).
  private computeIgnoreUrls(): (string | RegExp)[] {
    return this.transports.transports.flatMap((transport) => transport.getIgnoreUrls());
  }
}
