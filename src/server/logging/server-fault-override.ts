/**
 * Registry of thrown values that must be classified as a SERVER fault even though
 * their tRPC code is one of the CLIENT-fault 4xx codes.
 *
 * WHY THIS EXISTS
 * ---------------
 * `classifyErrorFault` keys severity off the tRPC code, which is normally the right
 * signal: a BAD_REQUEST means the caller sent something invalid, which is routine
 * user feedback and must not pollute the error stream.
 *
 * But a handful of failures are BAD_REQUEST *to the caller* while being a
 * SERVER-side fault in origin — the caller did nothing wrong and there is nothing
 * they can do differently. The motivating case is an UPSTREAM dependency returning
 * something unusable (an HTML interstitial instead of JSON, a 5xx): we still answer
 * the caller 400 because the request genuinely cannot be completed and we must fail
 * closed, but an operator needs to see it as an incident, not as user feedback.
 *
 * Marking the thrown error keeps the two axes independent:
 *   - HTTP status stays whatever the tRPC code says (no caller-visible change)
 *   - log SEVERITY becomes `type:'error'`, so the failure lands in the normal
 *     `detected_level="error"` stream that people actually watch
 *
 * WHY A SEPARATE MODULE (and not `logging/client.ts`)
 * --------------------------------------------------
 * Two reasons, both load-bearing:
 *
 *  1. ONE registry instance has to be shared by the code that MARKS an error and
 *     the code that CLASSIFIES it. Keeping the WeakSet here, with `logging/client`
 *     importing the predicate, means neither side owns it.
 *
 *  2. The unit-test setup (`src/__tests__/setup.ts`) mocks `~/server/logging/client`
 *     WHOLESALE, exporting only `logToAxiom`. Any thrower importing `escalateToServerFault`
 *     from there would receive `undefined` under test and blow up at the call — the
 *     stale-wholesale-mock failure mode. This module is not mocked, so throwers get
 *     the real implementation and tests observe real behaviour.
 *
 * A WeakSet (rather than a property on the error) keeps the marker off the object,
 * so it can never leak into a serialized log payload, and lets GC reclaim entries.
 *
 * NAMING (load-bearing, not taste)
 * --------------------------------
 * `logging/client.ts` already exports `markServerFaultLogged` / `wasServerFaultLogged`,
 * a DIFFERENT registry with the OPPOSITE effect: it records that a fault was already
 * logged, and `[trpc].ts` gates the central log on `!wasServerFaultLogged(error)` — so
 * calling it SUPPRESSES the central line entirely. A `markServerFault*` name here would
 * sit one word away from it, and picking the wrong one silences the log instead of
 * escalating it. Hence `escalateToServerFault` / `isEscalatedServerFault`: no shared
 * prefix with the suppression pair, and the verb states the direction of the effect.
 */
const serverFaultOverrides = new WeakSet<object>();

/**
 * Escalate a thrown value to a SERVER fault regardless of its tRPC code.
 *
 * Returns the value so it can be thrown inline:
 *   `throw escalateToServerFault(new TRPCError({ code: 'BAD_REQUEST', message }));`
 *
 * Non-object values (a thrown string/number) are returned untouched — they are
 * already classified as server faults, since there was no deliberate rejection.
 *
 * NOT to be confused with `markServerFaultLogged` in `logging/client.ts`, which
 * SUPPRESSES the central log line rather than escalating its severity.
 */
export function escalateToServerFault<T>(e: T): T {
  if (e !== null && typeof e === 'object') serverFaultOverrides.add(e as object);
  return e;
}

/** Whether `escalateToServerFault` was called on this value. */
export function isEscalatedServerFault(e: unknown): boolean {
  return e !== null && typeof e === 'object' && serverFaultOverrides.has(e as object);
}
