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
   * 🔴 NO HEADER AT ALL — FIRST-CLASS, NOT A GAP.
   *
   * A browser running a bundle older than the deploy that added the header sends nothing,
   * so expect this to DOMINATE for as long as stale bundles are in circulation. A rising
   * `single_put`/`multipart` share against a falling `unknown` is what rollout looks like
   * here, and it is the only way to read it. An absent value must therefore be a readable
   * row rather than a dropped label or a skipped increment, either of which would make
   * "an old client rescued this upload" and "the discriminator was never wired" the same
   * observation.
   */
  'unknown',
  /**
   * 🔴 A HEADER ARRIVED AND WAS NOT RECOGNISED — kept SEPARATE from `unknown`, which is
   * this label's whole reason for existing applied to itself.
   *
   * Two populations land here: a client we shipped that got the spelling wrong or is
   * newer than this server, and a caller sending something crafted. Both are bucketed
   * rather than dropped, because the route's invocation count must stay equal to the sum
   * of this metric — dropping the increment would let a hostile caller hide its requests.
   *
   * ⚠ IT USED TO BE FOLDED INTO `unknown`, AND THE REASONING FOR THAT WAS UNFALSIFIABLE.
   * The argument was "the unrecognised population is negligible during the window that
   * matters, and we can split it later if that stops holding". But nothing could ever
   * reveal that it had stopped holding: the sanitiser discards the raw value, the
   * `image-upload-relayed` event is success-only and carries the already-sanitised
   * producer, and there is no log line on this branch. The trigger for the deferred fix
   * was unobservable, which makes it not a deferral but a permanent blind spot — on the
   * row the rollout is graded on, and fed by input that reaches the sanitiser BEFORE the
   * origin guard and the session lookup (see the note below), so its size is
   * caller-controlled rather than bounded by our expectations.
   *
   * `boundedClientLabel` in `src/server/prom/trpc-batch.metrics.ts` — the sibling this
   * module follows on the array question — splits its own equivalent the same way
   * (`none` / `other`). The cost is 11 more fixed series, which is the same cheap price
   * the rest of this counter's cardinality is argued on.
   */
  'other',
] as const;

export type ImageUploadRelayProducer = (typeof IMAGE_UPLOAD_RELAY_PRODUCERS)[number];

/** The bucket for a request that carried NO header. Named so no call site spells it twice. */
export const UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER: ImageUploadRelayProducer = 'unknown';

/** The bucket for a header that arrived and was not recognised. */
export const OTHER_IMAGE_UPLOAD_RELAY_PRODUCER: ImageUploadRelayProducer = 'other';

/**
 * A `Set`, not an object literal, for the same reason `sanitizeClientFailure` rebuilds
 * its result: an object lookup would answer truthy for `toString`, `constructor` and
 * `__proto__`, which are exactly the strings a caller would try.
 */
const PRODUCER_SET: ReadonlySet<string> = new Set(IMAGE_UPLOAD_RELAY_PRODUCERS);

/**
 * Narrow a caller-supplied header value to the closed set above.
 *
 * 🔴 TOTAL, and never `undefined`. Returning `undefined` for the absent case would let the
 * label be omitted, which in Prometheus creates a DIFFERENT series (one with no `producer`
 * label) — the opposite of the closed bound this module exists to hold.
 *
 * 🔴 TWO REJECTION BUCKETS, NOT ONE, AND THE SPLIT IS THE POINT. Nothing present (absent
 * header, a non-string, an array with no usable first element) -> `unknown`; something
 * present but not a member -> `other`. Those are different populations — stale bundles
 * versus a client that got it wrong or a caller probing the route — and folding them puts
 * two causes behind one number, on the row the rollout is graded on, which is the exact
 * defect the producer label exists to remove.
 *
 * An ARRAY takes its first element, matching `firstValue`/`boundedClientLabel` in
 * `src/server/prom/trpc-batch.metrics.ts` — the closest sibling in this repo, which does
 * the same job (a caller-supplied header narrowed to a bounded Prometheus label) and
 * already settled this question. ⚠ An earlier draft bucketed any array to `unknown` on
 * "ambiguous provenance" grounds; that diverged from three existing normalisers here and
 * it diverged in the harmful direction — `unknown` is the row the rollout is GRADED on,
 * so demoting a legitimate `multipart` rescue into it corrupts the one signal that can
 * answer the question (it would land in `other` now, which is no better — that row is read
 * as "a client got it wrong"). It buys no safety either: the closed-set test below is what bounds
 * the label, and a caller that can send the header twice can equally send it once.
 *
 * ⚠ AND THE BRANCH IS DEFENSIVE AGAINST THE TYPE, NOT AGAINST A BEHAVIOUR THIS HEADER HAS.
 * Node joins duplicate headers with `', '` and returns an array only for `set-cookie`, so a
 * genuinely repeated `x-civitai-upload-producer` arrives as the single string
 * `"multipart, single_put"` — which is outside the set and becomes `other` either way.
 * `IncomingHttpHeaders` still types the value `string | string[]`, so the branch has to
 * exist; do not reason from it that duplicate custom headers reach us as arrays.
 *
 * 🔴 THE BOUND IS THIS SET, NOT THE ROUTE'S AUTH. The relay sanitises the header before
 * its origin guard and session lookup, so an unauthenticated or cross-origin caller still
 * chooses which producer series moves for `forbidden_origin` / `unauthorized`. That is
 * harmless only while the set is closed and every pair is pre-seeded. Anyone widening this
 * to a prefix match, a pattern, or a length-bounded passthrough would be letting
 * unauthenticated input drive cardinality on a public route — do not.
 *
 * ⚠ AND THE LABEL IS SELF-DECLARED. This rejects values outside the set; it cannot check
 * that an in-set value is TRUE. Any same-origin logged-in caller can assert `multipart`,
 * so the label records which caller CLAIMS to have produced the relay.
 *
 * The new capability that buys them is MISATTRIBUTION, not inflation — say that precisely,
 * because "the same access already moved the undifferentiated counter" is only half true:
 * before this label they could move one aggregate number, and now they can move a NAMED
 * path's row, which is the number a rollout decision rests on. To corroborate, read the
 * `userId`s on the `image-upload-relayed` events and check the rescues belong to a
 * plausible population. 🔴 Do NOT corroborate against those events' own `producer` field:
 * the route feeds ONE derivation into both signals deliberately, so they agree by
 * construction and the check cannot fail. Note also that those events are emitted on a
 * SUCCESSFUL relay only, so the refusal outcomes have no corroborating event at all.
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
  // Nothing usable arrived at all — the stale-bundle population.
  if (typeof value !== 'string' || value.length === 0) return UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER;
  // Something arrived and was not a member. A DIFFERENT fact, so a different bucket.
  return PRODUCER_SET.has(value)
    ? (value as ImageUploadRelayProducer)
    : OTHER_IMAGE_UPLOAD_RELAY_PRODUCER;
}
