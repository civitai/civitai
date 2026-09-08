// Usage counter for the FALLBACK image-upload relay (`/api/v1/image-upload/relay`).
//
// WHY THIS EXISTS. The relay was shipped to rescue clients whose DNS cannot resolve
// the storage host, so the direct browser PUT fails at the network layer. It works —
// and a SUCCESSFUL relay is currently invisible. Three independent reasons, each
// verified against the code that produces the signal:
//
//  * The ingress access log is filtered to `4xx/5xx OR >5s`, so a fast 200 is never
//    written. The rejection branches (413/400/401/403/429) DO appear there, which
//    means today's only signal is biased entirely toward failure — the one outcome
//    that matters most is the one it cannot show.
//  * OTEL traces are head-sampled at 0.1 (`instrumentation.node.ts`), and this is a
//    rare event. At a handful of relays over months, "sampled zero" and "never
//    happened" are the same observation, indefinitely.
//  * The media-location registry records the same backend for a relayed and a direct
//    upload — same bucket, same backend, by design — so the registry cannot separate
//    them after the fact either.
//
// `civitai_app_http_errors_total` (`~/server/prom/http-errors`) is already wired on
// this route, but it counts ONLY `status >= 500`: it can see the store blowing up and
// nothing else. It is not a usage signal and was never meant to be one.
//
// WHAT ONE INCREMENT MEANS: exactly one invocation of the relay route handler, at the
// outcome it settled on. The handler records once per call, structurally — see
// `relay.ts`, where the response logic returns an outcome and the exported handler is
// the only thing that emits it. So `sum(civitai_image_upload_relay_total)` is the
// route's request count and `…{outcome="success"}` is the number of uploads it
// actually rescued.
//
// 🔴 ALERTING / READING: use `max_over_time(...[window])` or `sum(...)`, NOT `rate()`
// on a per-pod child. This is a RARE counter spread over a large pod fleet: a pod that
// relays once creates its child series at 1 and never touches it again, so `rate()` /
// `increase()` over that child is structurally 0 and a threshold keyed on it silently
// never fires — the counter would look healthy precisely because the event is rare,
// which is the ambiguity it exists to remove. (Same reasoning as
// `~/server/metrics/generation-model-substitution.metrics.ts`.)
//
// 🔴 CARDINALITY: ONE label over a code-owned union of 11 values, declared once below.
// 11 series, TOTAL, per pod — a fixed bound that no traffic can move. Deliberately NO
// user id, NO object key, NO bucket, NO host, NO path, NO content type, NO byte size:
// every one of those is caller-influenced or unbounded, and prom-client retains each
// distinct label set in the Node heap for the life of the process. Attribution for an
// individual relay belongs in the request log, not here — alert on the metric, then go
// look. The bound rests on the runtime narrowing in `recordImageUploadRelay`, on code
// rather than on erased types.
//
// prom-client GOTCHA (same as the neighbouring metric modules): Next can evaluate a
// module twice (HMR / route bundling) and prom-client throws on a duplicate name, so
// the getter below is get-or-create against the DEFAULT registry — the one
// `/api/metrics` scrapes.
//
// 🔴 REGISTRY GRAPH INVARIANT (see the note in `http-errors.ts`): import this module
// only from the REQUEST webpack graph (API routes / pages). prom-client keeps a
// per-graph default registry and `/api/metrics` scrapes the request graph's one; being
// pulled into the instrumentation graph first would register the counter somewhere
// nothing scrapes, and it would silently read as a permanent zero.
import client, { type Counter, type Registry } from 'prom-client';

/**
 * Every terminal outcome of one relay-route invocation.
 *
 * Ordered roughly as the handler reaches them. Kept as a `const` tuple so the union,
 * the runtime guard and the seeding loop below are all derived from ONE declaration —
 * a value added here is automatically seeded and automatically accepted, and one
 * removed stops being accepted, with no second list to forget.
 */
export const IMAGE_UPLOAD_RELAY_OUTCOMES = [
  /** 200 — bytes reached the store and the caller got a key. THE point of the route. */
  'success',
  /** 405 — not a POST. */
  'method_not_allowed',
  /** 403 — production cross-origin guard refused it before the session lookup. */
  'forbidden_origin',
  /** 401 — no session, or a banned user. */
  'unauthorized',
  /** 429 — the per-pod in-flight cap shed it. */
  'busy',
  /** 413 — over the size cap, refused either by declared length or by running total. */
  'too_large',
  /** 400 — the body ended short of its declared length; never stored. */
  'truncated',
  /** 400 — a zero-length body. */
  'empty',
  /** 400 — reading the body threw for some other reason. */
  'read_error',
  /** The store write threw. `handleEndpointError` answered (500, or 499 on a client
   *  disconnect mid-write — the two are NOT separated here, deliberately: the wire
   *  status already distinguishes them and splitting the label would buy a series
   *  whose only reader is the same dashboard panel). */
  'store_error',
  /** The response logic threw where nothing expected it to. Should be a permanent
   *  zero; a non-zero here is a bug in the route, not a property of the traffic. Its
   *  presence is what makes "one increment per invocation" hold unconditionally. */
  'handler_error',
] as const;

export type ImageUploadRelayOutcome = (typeof IMAGE_UPLOAD_RELAY_OUTCOMES)[number];

const OUTCOME_SET: ReadonlySet<string> = new Set(IMAGE_UPLOAD_RELAY_OUTCOMES);

export function isImageUploadRelayOutcome(value: unknown): value is ImageUploadRelayOutcome {
  return typeof value === 'string' && OUTCOME_SET.has(value);
}

export const IMAGE_UPLOAD_RELAY_METRIC = 'civitai_image_upload_relay_total';

const HELP =
  'Invocations of the FALLBACK image-upload relay route, by terminal outcome. ' +
  'The relay exists for clients that cannot reach the storage host directly, so a ' +
  'non-zero success count is the only evidence that fallback is rescuing real uploads: ' +
  'a relayed 200 is filtered out of the access-log stream, traces are head-sampled, and ' +
  'the media-location registry records the same backend for relayed and direct uploads. ' +
  'Exactly one increment per handler invocation. ' +
  'outcome: success = bytes stored and a key returned; method_not_allowed = not a POST; ' +
  'forbidden_origin = production cross-origin guard; unauthorized = no session or banned; ' +
  'busy = shed by the per-pod in-flight cap (429); too_large = over the size cap (413); ' +
  'truncated = body ended short of its declared Content-Length (400, never stored); ' +
  'empty = zero-length body (400); read_error = reading the body threw (400); ' +
  'store_error = the store write threw (500, or 499 on a client disconnect); ' +
  'handler_error = the route itself threw where it should not — expected to stay 0. ' +
  'RARE per-pod counter: read with sum()/max_over_time(), not rate() on a single child.';

/**
 * Seed all 11 series at 0.
 *
 * 🔴 NOT COSMETIC, AND THIS COUNTER IS THE CASE WHERE IT MATTERS MOST. prom-client only
 * materialises a child on its first `inc()`, so without this a pod exposes NOTHING for
 * an outcome until that outcome occurs on that pod. A PromQL read then returns `no
 * data`, which is indistinguishable from "the instrument was never wired" — and this
 * metric's entire job is to settle "has the relay ever helped anyone?". An absent
 * series would answer that question with the same shape as a broken deploy.
 *
 * The relay is expected to fire a handful of times across the whole fleet, so on nearly
 * every pod the honest, useful reading of this counter is a row of zeros. That reading
 * only exists if the zeros are emitted.
 *
 * Free by construction: 11 series is the counter's entire cardinality budget, so
 * seeding costs exactly what a fully-exercised pod already costs and cannot grow.
 *
 * 🔴 SEEDING ALONE IS NOT ENOUGH. Something must CALL this at scrape time or the module
 * is never evaluated on a pod that has not relayed — which is every pod, almost always.
 * The other half is the explicit call in `src/pages/api/metrics.ts`. Both halves are
 * required; neither works alone.
 *
 * Idempotent: get-or-create returns the existing counter, and `inc(…, 0)` is a no-op on
 * an already-materialised child, so calling this on every scrape cannot reset or
 * double-count anything.
 */
function seedAllSeries(counter: Counter<string>): void {
  for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) counter.inc({ outcome }, 0);
}

function getOrCreateCounter(reg: Registry): Counter<string> {
  const existing = reg.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({
    name: IMAGE_UPLOAD_RELAY_METRIC,
    help: HELP,
    labelNames: ['outcome'],
    registers: [reg],
  });
}

/**
 * Idempotent; safe to call on every request or scrape. Returns the counter from the
 * default registry that `/api/metrics` serves.
 */
export function ensureRegisterImageUploadRelayMetrics(reg: Registry = client.register): {
  imageUploadRelayTotal: Counter<string>;
} {
  const imageUploadRelayTotal = getOrCreateCounter(reg);
  seedAllSeries(imageUploadRelayTotal);
  return { imageUploadRelayTotal };
}

/**
 * Fail-soft emit of one relay outcome.
 *
 * 🔴 TOTAL, like every emitter in this directory. This instruments an UPLOAD path that
 * only runs after the user's direct upload has already failed — it is the last thing
 * standing between them and a broken upload. A registry collision or a label mismatch
 * must never propagate out of here, or observing the rescue would break it: the
 * observability turning a working request into the outage it was measuring.
 */
export function recordImageUploadRelay(outcome: ImageUploadRelayOutcome): void {
  try {
    // 🔴 The cardinality bound rests HERE, on code, not on the erased type above. An
    // unknown value is DROPPED — not passed through, and not relabelled to a plausible
    // default like `success` or `unknown`, either of which would make the fixed-series
    // claim a wish and could silently invent evidence that the relay worked.
    if (!isImageUploadRelayOutcome(outcome)) return;
    const { imageUploadRelayTotal } = ensureRegisterImageUploadRelayMetrics();
    imageUploadRelayTotal.inc({ outcome });
  } catch {
    /* instrument-only — never let a metrics error touch the upload path */
  }
}

/** Test-only: clear every child so a case starts from a known state. */
export function __resetImageUploadRelayMetricsForTest(): void {
  const existing = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as
    | Counter<string>
    | undefined;
  existing?.reset();
}
