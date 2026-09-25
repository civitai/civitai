/**
 * WHICH CLIENT produced a fallback relay upload (`/api/v1/image-upload/relay`).
 *
 * WHY THIS EXISTS. The relay has TWO callers — the single-PUT path in
 * `src/hooks/useCFImageUpload.tsx` and the multipart path in `src/hooks/useS3Upload.tsx`
 * (via `relayImageFallback` in `src/utils/upload-settlement.ts`) — and until this module
 * existed `civitai_image_upload_relay_total` counted route invocations BY OUTCOME ONLY.
 * The single-PUT caller shipped first and has been live long enough to have rescued real
 * uploads, so the counter reads a non-zero `success` that is entirely attributable to it.
 * Anyone grading the newer multipart path on that counter reads someone else's rescues as
 * their own — a confident false positive, from a green-looking signal.
 *
 * MECHANISM: a REQUEST HEADER, not a query parameter and not a body field. The body of
 * that route IS the file (`bodyParser: false`), so there is nowhere in it to put a field;
 * a query parameter would land in the URL and therefore in any access log and any
 * referrer, for a value that is pure telemetry. A header is also free of the route's
 * own overwrite guard reasoning — it names the CALLER, never the object key, so nothing a
 * caller writes here can address another user's object.
 *
 * 🔴 THIS IS CALLER-SUPPLIED INPUT AND IT BECOMES A PROMETHEUS LABEL. Every value that
 * reaches the counter must come from `sanitizeImageUploadRelayProducer` below, which
 * rebuilds it from scratch against a closed set rather than passing it through — the same
 * shape as `sanitizeClientFailure` in `src/pages/api/upload/abort.ts`. Without that, a
 * caller could mint an unbounded number of label values, and prom-client retains every
 * distinct label set in the Node heap for the life of the process.
 */

/**
 * The header both callers send and the route reads.
 *
 * Lowercase because Node lowercases every incoming header name, so this constant can be
 * used verbatim as a `req.headers[...]` key. `fetch` normalises the outgoing name itself,
 * so the same spelling works on both sides and there is no second literal to drift.
 */
export const IMAGE_UPLOAD_RELAY_PRODUCER_HEADER = 'x-civitai-upload-producer';

/**
 * The CLOSED set of producer label values.
 *
 * Kept as a `const` tuple so the union, the runtime guard and the metric's seeding loop
 * are all derived from ONE declaration — exactly as `IMAGE_UPLOAD_RELAY_OUTCOMES` is in
 * `src/server/prom/image-upload-relay.metrics.ts`. A value added here is automatically
 * seeded and automatically accepted; one removed stops being accepted.
 *
 * snake_case, deliberately, to match the outcome vocabulary on the SAME metric
 * (`method_not_allowed`, `too_large`, `store_error`, …). A reader filtering that counter
 * should not have to remember that one label uses hyphens and the other underscores.
 */
export const IMAGE_UPLOAD_RELAY_PRODUCERS = [
  /** `useCFImageUpload` — the single-PUT path. Live in production well before the
   *  multipart one, so it owns every relay success recorded before this label existed. */
  'single_put',
  /** `useS3Upload` -> `relayImageFallback` — the multipart path. */
  'multipart',
  /**
   * 🔴 FIRST-CLASS, NOT A GAP. Three distinct populations land here and all three are
   * legitimate readings rather than errors — note that a crafted value only lands here
   * if it is OUTSIDE the set; an in-set value asserted by a caller is taken at face
   * value, see the note on `sanitizeImageUploadRelayProducer`:
   *
   *  * A browser running an older cached bundle, which sends no header at all. Expect
   *    this to DOMINATE for as long as stale bundles are in circulation after the
   *    deploy that adds the header — a rising `single_put`/`multipart` share against a
   *    falling `unknown` is what rollout looks like here, and it is the only way to
   *    read it.
   *  * A caller that sent something unrecognised — a future producer talking to an old
   *    server, or a client that got the spelling wrong.
   *  * A crafted value. It is bucketed rather than rejected, because the route's own
   *    invocation count must stay equal to the sum of this metric; dropping the
   *    increment would make a hostile caller able to hide its requests from the counter.
   */
  'unknown',
] as const;

export type ImageUploadRelayProducer = (typeof IMAGE_UPLOAD_RELAY_PRODUCERS)[number];

/** The bucket every unrecognised value lands in. Named so no call site spells it twice. */
export const UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER: ImageUploadRelayProducer = 'unknown';

/**
 * A `Set`, not an object literal, for the same reason `sanitizeClientFailure` rebuilds
 * its result: an object lookup would answer truthy for `toString`, `constructor` and
 * `__proto__`, which are exactly the strings a caller would try.
 */
const PRODUCER_SET: ReadonlySet<string> = new Set(IMAGE_UPLOAD_RELAY_PRODUCERS);

/**
 * Narrow a caller-supplied header value to the closed set above.
 *
 * 🔴 TOTAL, and never `undefined`. Absent, unknown, malformed, a non-string, or a crafted
 * value ALL become `unknown`. Returning `undefined` for the absent case would let the
 * label be omitted, which in Prometheus creates a DIFFERENT series (one with no `producer`
 * label) — the opposite of the closed bound this module exists to hold.
 *
 * An ARRAY takes its first element, matching `firstValue`/`boundedClientLabel` in
 * `src/server/prom/trpc-batch.metrics.ts` — the closest sibling in this repo, which does
 * the same job (a caller-supplied header narrowed to a bounded Prometheus label) and
 * already settled this question. ⚠ An earlier draft bucketed any array to `unknown` on
 * "ambiguous provenance" grounds; that diverged from three existing normalisers here and
 * it diverged in the harmful direction — `unknown` is the row the rollout is GRADED on,
 * so demoting a legitimate `multipart` rescue into it corrupts the one signal that can
 * answer the question. It buys no safety either: the closed-set test below is what bounds
 * the label, and a caller that can send the header twice can equally send it once.
 *
 * 🔴 THE BOUND IS THIS SET, NOT THE ROUTE'S AUTH. The relay sanitises the header before
 * its origin guard and session lookup, so an unauthenticated or cross-origin caller still
 * chooses which producer series moves for `forbidden_origin` / `unauthorized`. That is
 * harmless only while the set is closed and every pair is pre-seeded. Anyone widening this
 * to a prefix match, a pattern, or a length-bounded passthrough would be letting
 * unauthenticated input drive cardinality on a public route — do not.
 *
 * ⚠ AND THE LABEL IS SELF-DECLARED. This rejects values outside the set; it cannot check
 * that an in-set value is TRUE. Any same-origin logged-in caller can assert `multipart`.
 * That grants nothing new — the same access already moved the undifferentiated counter —
 * but it means the label records which caller CLAIMS to have produced the relay. When
 * grading a path on it, corroborate against the `image-upload-relayed` events, which carry
 * `userId` and can show whether the rescues belong to a plausible population.
 *
 * Contrast with `isImageUploadRelayOutcome`, which DROPS the increment on an unrecognised
 * value. The asymmetry is deliberate and the two inputs are not alike: an outcome is
 * code-owned, so an unrecognised one is a defect in our own emitter and inventing a
 * plausible label there could fabricate evidence that the relay rescued an upload. A
 * producer is caller-owned, so an unrecognised one is EXPECTED traffic, and dropping it
 * would cost the invocation count the counter's "one increment per invocation" property
 * rests on.
 */
export function sanitizeImageUploadRelayProducer(input: unknown): ImageUploadRelayProducer {
  const value = Array.isArray(input) ? input[0] : input;
  if (typeof value !== 'string') return UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER;
  return PRODUCER_SET.has(value)
    ? (value as ImageUploadRelayProducer)
    : UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER;
}
