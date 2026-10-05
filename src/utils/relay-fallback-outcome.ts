/**
 * What happened to the multipart upload's relay rescue (`relayImageFallback` in
 * `src/utils/upload-settlement.ts`), as the client reports it to `/api/upload/abort`.
 *
 * The relay's server-side counter records `outcome="success"` the moment the route stores the
 * bytes, so it counts a rescue the browser could not use — it OVERSTATES user-visible rescues,
 * and by how much was unmeasurable while every client-side failure collapsed into one value.
 *
 * 🔴 Caller-supplied input that becomes a log field, so every value must come from
 * `sanitizeRelayFallbackOutcome` below — the same closed-set rebuild as
 * `sanitizeImageUploadRelayProducer` in `src/utils/image-upload-relay-producer.ts`.
 */

export const RELAY_FALLBACK_FAILURE_REASONS = [
  /** `fetch` rejected — the request never reached our origin. */
  'transport_error',
  /** The person cancelled DURING the fallback, which is not a failure of the relay. */
  'aborted',
  'non_2xx',
  /** 🔴 The mode the server-side counter gets wrong: a 2xx we cannot read, or with no id. */
  'bad_body',
] as const;
export type RelayFallbackFailureReason = (typeof RELAY_FALLBACK_FAILURE_REASONS)[number];

// Spread, not restated: a value added to a lower tier cannot go missing from a higher one.
export const CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES = [
  ...RELAY_FALLBACK_FAILURE_REASONS,
  'rescued',
  /** `shouldRelayOnPartFailure` (`~/utils/upload-retry`) returned false; see its clauses. */
  'not_attempted',
] as const;
export type ClientDeclarableRelayFallbackOutcome =
  (typeof CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES)[number];

/** The full field vocabulary — what may be LOGGED, as against what a client may DECLARE. */
export const RELAY_FALLBACK_OUTCOMES = [
  ...CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES,
  /**
   * No outcome was sent. Two populations deliberately share this row — a bundle predating the
   * field, and an abort from a path that never reaches the relay decision (a failed `complete`,
   * the store client) — because neither is a statement about the relay.
   */
  'unknown',
  /** Arrived and not declarable, as distinct from `unknown`, which is a claim about the REQUEST. */
  'other',
] as const;
export type RelayFallbackOutcome = (typeof RELAY_FALLBACK_OUTCOMES)[number];

export const UNKNOWN_RELAY_FALLBACK_OUTCOME: RelayFallbackOutcome = 'unknown';
export const OTHER_RELAY_FALLBACK_OUTCOME: RelayFallbackOutcome = 'other';

/** A `Set`, not an object literal, which would answer truthy for `toString` and `__proto__`. */
const CLIENT_DECLARABLE_SET: ReadonlySet<string> = new Set(
  CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES
);

/**
 * ⚠ Only `undefined` reads as absent, unlike the producer header's sanitiser which maps every
 * non-string that way: this value arrives in a JSON body, where a present non-string is a client
 * computing a bad value rather than one too old to send anything.
 */
export function sanitizeRelayFallbackOutcome(input: unknown): RelayFallbackOutcome {
  if (input === undefined) return UNKNOWN_RELAY_FALLBACK_OUTCOME;
  if (typeof input !== 'string') return OTHER_RELAY_FALLBACK_OUTCOME;
  return CLIENT_DECLARABLE_SET.has(input)
    ? (input as RelayFallbackOutcome)
    : OTHER_RELAY_FALLBACK_OUTCOME;
}
