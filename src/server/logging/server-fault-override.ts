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
 * One reason, load-bearing:
 *
 *   The unit-test setup (`src/__tests__/setup.ts`) mocks `~/server/logging/client`
 *   WHOLESALE, exporting only `logToAxiom`. Any thrower importing `escalateToServerFault`
 *   from there would receive `undefined` under test and blow up at the call — the
 *   stale-wholesale-mock failure mode. This module is not mocked, so throwers get
 *   the real implementation and tests observe real behaviour.
 *
 * Note what a separate module does NOT buy: it does not make the registry a
 * singleton. See the 🔴 block below.
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHY globalThis, and not a module-scope WeakSet
 * ---------------------------------------------------------------------------
 * The registry has to be ONE object shared by the code that MARKS an error
 * (`~/server/recaptcha/client`) and the code that CLASSIFIES it
 * (`~/server/logging/client` → `classifyErrorFault`). A module-scope `const` does
 * not give you that here.
 *
 * Turbopack merges source modules into larger runtime modules, so one `.ts` file is
 * routinely inlined into many of them. Each emitted copy carries its own top-level
 * bindings, so a module-scope `new WeakSet()` here is N independent WeakSets: the
 * marker is added to one, the predicate is asked of another, and
 * `isEscalatedServerFault` returns `false` forever.
 *
 * MEASURED, not theorised. On a production `next build` of this tree, with the
 * module-scope version of this file: **10 emitted copies, 0 of them sharing state**.
 * With the `globalThis` version below: **12 emitted copies, all 12 sharing one
 * WeakSet**. (The copy COUNT shifts between builds — the bundler's merge decisions
 * depend on module content — so do not treat any particular number as fixed. The
 * invariant is that it is >1, and that every copy must reach the same object.)
 * For reference, `src/server/logging/client.ts`, the module that READS this
 * registry, was inlined into 13 chunks in the same build.
 *
 * That failure has no error, no counter and no symptom — the escalation simply never
 * happens, and every gate stays green. It is not hypothetical: it is exactly how the
 * OTel logs bridge shipped delivering 1.3% of records. See
 * `./structured-log-sink.ts`, which carries the full measurement and the same idiom,
 * and `scripts/check-server-graph-singletons.mjs`, which gates it — this module is on
 * that WATCHLIST under the `SHARED_STATE` rule.
 *
 * `globalThis` is the one thing every emitted copy genuinely shares: the real V8
 * global of the single Node process, indifferent to how the bundler splits or
 * duplicates modules.
 *
 * 🔴 No test in this repo can catch a regression here — vitest loads each module
 * exactly once, so a module-scope WeakSet looks like a singleton under test. The
 * build-output gate is the only thing that can see it.
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
declare global {
  // eslint-disable-next-line no-var
  var __civitaiServerFaultOverrides: WeakSet<object> | undefined;
}

/**
 * The ONE override registry, shared by every emitted copy of every module that
 * marks or reads it.
 *
 * `??=` rather than a plain assignment: the second (third, fourteenth) copy of this
 * module to evaluate must ADOPT the existing WeakSet, not replace it — replacing it
 * would discard the marks already recorded by whichever copy ran first, which is the
 * original bug wearing a different hat.
 */
const serverFaultOverrides: WeakSet<object> = (globalThis.__civitaiServerFaultOverrides ??=
  new WeakSet<object>());

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
