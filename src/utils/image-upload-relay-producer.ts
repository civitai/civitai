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
 * `src/server/prom/image-upload-relay.metrics.ts`.
 *
 * ⚠ A value added here is automatically seeded and automatically EMITTABLE. It is NOT
 * automatically ACCEPTED from a client — that is `CLIENT_DECLARABLE_PRODUCERS` below, and
 * a label missing from that tuple is refused with `other`. Removing a value here does NOT
 * silently change what is emitted — it breaks whichever declaration depends on it: the two
 * client-declarable values break the `satisfies` clause below, and the two server buckets
 * break their own typed constants. (Two corrections in one paragraph, a round apart. It
 * first claimed adding a value made it "automatically accepted", pointing a future edit at
 * the wrong one of two tuples that are confusable by construction; the sentence replacing
 * that then described removal as a silent re-bucketing, which stopped being true in the
 * same commit that added the `satisfies` clause. A correction is a claim like any other.)
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
   * FOUR populations land here. Three are client-side: a client we shipped that got the
   * spelling wrong or is newer than this server, a client that computed an EMPTY value, and
   * a caller sending something crafted (including one declaring a SERVER bucket — see
   * `CLIENT_DECLARABLE_PRODUCERS`). All are bucketed rather than dropped, because the
   * route's invocation count must stay equal to the sum of this metric, and dropping the
   * increment would let a hostile caller hide its requests.
   *
   * 🔴 The fourth is OURS: a value reaching the metric's emitter that is not one of the four
   * labels at all. That is a defect in our own derivation, and it lands here rather than in
   * `unknown` because `unknown` is a claim about the REQUEST — that it carried no header —
   * and the row a rollout is graded on must not absorb our bugs. Unreachable today (the
   * route is the only emitter and always passes the sanitiser's total output), but it is
   * what someone reading a moving `other` should be able to rule in or out.
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

/**
 * The producers a CLIENT may declare — the two real upload paths, and nothing else.
 *
 * 🔴 A STRICT SUBSET OF THE LABEL SET, AND THE DISTINCTION IS LOAD-BEARING. `unknown` and
 * `other` are the SERVER's buckets: `unknown` means "no header arrived", `other` means
 * "something arrived that is not a declarable producer". A caller declaring either would be
 * asserting a fact about the server's own reading, and `unknown` in particular is the row
 * a rollout is graded on — `HELP` tells the reader to read a falling `unknown` as stale
 * bundles clearing, so a client able to write to it can make a rollout look finished.
 *
 * ⚠ IT WAS NOT ALWAYS A SUBSET. The request parameter used to be typed to the full label
 * union, so `postImageUploadRelay(file, { producer: 'unknown' })` type-checked and a
 * request carrying `x-civitai-upload-producer: unknown` was accepted verbatim onto that
 * row — while three comments and the ledger's own docstring claimed a new call site is
 * "FORCED to reuse single_put or multipart to compile". It was not.
 */
/**
 * 🔴 `satisfies` IS THE GUARD, NOT DECORATION — the subset above was stated as load-bearing
 * and enforced by nothing. Measured: adding a value to THIS tuple alone left the whole
 * relay suite green while `sanitizeImageUploadRelayProducer` returned it verbatim, typed as a label it
 * is not; it then went into the log event's `producer` field as-is, and the counter bucketed
 * it to `other` — so the new caller was silently mis-attributed, forever, on the row it was
 * added to be graded on. The `as ImageUploadRelayProducer` cast in the sanitiser is what
 * launders it, and the cast cannot be removed (the `Set` erases the narrowing). This
 * annotation makes the compiler check what the cast asserts.
 */
export const CLIENT_DECLARABLE_PRODUCERS = [
  'single_put',
  'multipart',
] as const satisfies readonly ImageUploadRelayProducer[];

export type ClientDeclarableProducer = (typeof CLIENT_DECLARABLE_PRODUCERS)[number];

/**
 * The bucket for a request that carried NO header.
 *
 * Named rather than inlined so the sanitiser's two return paths read as two decisions, and
 * so a test can assert against the constant rather than re-typing the string. (It said
 * "named so no call site spells it twice", which was a claim about a second production call
 * site that has never existed — its sibling `OTHER_…` has one, this does not.)
 */
export const UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER: ImageUploadRelayProducer = 'unknown';

/** The bucket for a header that arrived and was not recognised. */
export const OTHER_IMAGE_UPLOAD_RELAY_PRODUCER: ImageUploadRelayProducer = 'other';

/**
 * A `Set`, not an object literal, for the same reason `sanitizeClientFailure` rebuilds
 * its result: an object lookup would answer truthy for `toString`, `constructor` and
 * `__proto__`, which are exactly the strings a caller would try.
 *
 * 🔴 Built from the CLIENT-DECLARABLE subset, not from the full label set — see that
 * constant. The label set is what gets SEEDED; this is what gets ACCEPTED.
 */
const CLIENT_DECLARABLE_SET: ReadonlySet<string> = new Set(CLIENT_DECLARABLE_PRODUCERS);

/** The full LABEL set — what may be EMITTED, as opposed to what may be DECLARED. */
const PRODUCER_LABEL_SET: ReadonlySet<string> = new Set(IMAGE_UPLOAD_RELAY_PRODUCERS);

/**
 * Is this one of the metric's four label values?
 *
 * 🔴 NOT the same question as `sanitizeImageUploadRelayProducer`, and conflating them is a
 * live defect rather than a style point. That function narrows CLIENT input, so it refuses
 * the server's own buckets. This one narrows a value our OWN code already derived — which
 * legitimately IS `unknown` whenever no header arrived. Running the client narrowing over
 * it converted every stale-bundle rescue into `other`, i.e. it emptied the row the rollout
 * is graded on. Measured the moment the client subset was introduced.
 */
export function isImageUploadRelayProducer(value: unknown): value is ImageUploadRelayProducer {
  return typeof value === 'string' && PRODUCER_LABEL_SET.has(value);
}

/**
 * Narrow a caller-supplied header value to the closed set above.
 *
 * 🔴 TOTAL, and never `undefined`. Returning `undefined` for the absent case would let the
 * label be omitted, which in Prometheus creates a DIFFERENT series (one with no `producer`
 * label) — the opposite of the closed bound this module exists to hold.
 *
 * 🔴 TWO REJECTION BUCKETS, NOT ONE, AND THE SPLIT IS THE POINT. Nothing ARRIVED (no
 * header, a non-string, an array with no usable first element) -> `unknown`; something
 * arrived and is not a member -> `other`. Those are different populations — stale bundles
 * versus a client that got it wrong or a caller probing the route — and folding them puts
 * two causes behind one number, on the row the rollout is graded on, which is the exact
 * defect the producer label exists to remove.
 *
 * ⚠ AN EMPTY STRING IS `other`, NOT `unknown` — it is a header that ARRIVED carrying
 * nothing, which is a client computing a bad value, not a client too old to send one. An
 * earlier revision put it in `unknown` while three separate comments and the `HELP` string
 * all said `unknown` meant "no header at all", and while `boundedClientLabel` — the sibling
 * this module cites AS the model for the split — maps `''` to its own `other`. Citing a
 * sibling for a decision and then diverging from it on that decision's boundary is how the
 * two copies drift.
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
 * its method check, its origin guard and its session lookup, so a caller who never
 * authenticates still chooses which producer series moves for every outcome that does not
 * require a session — `method_not_allowed`, `forbidden_origin`, `unauthorized`, and
 * `handler_error`, which an unauthenticated caller can drive because the session lookup
 * itself can throw on a caller-supplied bearer token (see `handler_error` in
 * `~/server/prom/image-upload-relay.metrics`). In production the origin guard runs before
 * the session lookup, so a CROSS-ORIGIN caller is refused at `forbidden_origin` and never
 * reaches it. (It is not the FIRST of the three — the method check is, so a cross-origin
 * GET is `method_not_allowed`. Guard ORDER is the axis that has now produced four wrong
 * revisions of this paragraph, so it is stated rather than summarised.)
 *
 * ⚠ Three revisions, each wrong differently, which is why the mechanism is spelled out
 * rather than summarised. The first omitted the method check. The second added it and then
 * said "an unauthenticated CROSS-ORIGIN caller … for every outcome reachable before that
 * lookup" — which named a population that cannot reach `unauthorized` at all in production,
 * while listing `unauthorized`, an outcome returned FROM the lookup's result rather than
 * before it. Both still omitted `handler_error`. A correction is a claim like any other. That is
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
  // Nothing arrived at all — the stale-bundle population. An empty STRING is not this: it
  // arrived, so it belongs in `other` with the rest of the unrecognised values.
  if (typeof value !== 'string') return UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER;
  // Something arrived and is not a value a client may declare. A DIFFERENT fact from
  // "nothing arrived", so a different bucket — and note the membership test is against the
  // CLIENT-DECLARABLE subset, not the label set, so a caller sending the server's own
  // `unknown` or `other` lands in `other` rather than writing to a server bucket.
  return CLIENT_DECLARABLE_SET.has(value)
    ? (value as ImageUploadRelayProducer)
    : OTHER_IMAGE_UPLOAD_RELAY_PRODUCER;
}
