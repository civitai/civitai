import type { SessionUser } from '~/types/session';
import { logToAxiom } from '~/server/logging/client';
import { isConfirmedNonApprovedAppBlockId } from '~/server/services/blocks/known-app-blocks.service';

/**
 * Is this host mount a PRIVATE RUN, and therefore invisible to the app's owner in
 * analytics? Called by BOTH `blockRenders` writers to skip the insert.
 *
 * Mechanism, the shape that was rejected, the over-filtering bound and the acceptance
 * step are recorded ONCE, at the read site: `blocks/app-views.service.ts`. What follows
 * is only what a future edit to THIS file needs.
 *
 * 🔴 THE SIGNAL IS DERIVED, NEVER SUPPLIED. Both writers are public — a `privateRun`
 * field on the beacon would let ANY viewer suppress their own impressions, which is a
 * larger defect than the leak. The only body-derived input is `appBlockId`, and it cannot
 * suppress on its own: suppression also requires THIS SESSION to resolve to a private-run
 * audience for THAT app, from the database.
 *
 * 🔴 IT CALLS THE REAL `resolvePrivateRunAccess`, NOT A CHEAPER LOOKALIKE. A hand-rolled
 * "owner of a non-approved app" drifts the moment the predicate gains a refusal the copy
 * lacks — `not-deployed`, `owner-banned` and `no-iframe-src` each describe a mount that
 * is NOT a private run, and admitting them would delete real impressions.
 *
 * 🔴 ITS OWN MODULE BECAUSE THE LEDGER MUST SEE IT. `private-run-access.call-site-ledger`
 * excludes a symbol's DEFINING file from its caller set, so defining this inside
 * `private-run-access.service.ts` would have made the third consumer structurally
 * invisible and left the ledger reporting "exactly two callers" while being wrong.
 *
 * ── THE GATE ORDER IS THE COST DESIGN, NOT A DETAIL ──────────────────────────
 * This sits on a beacon that fires once per host mount and exists to avoid per-call
 * middleware, while the predicate costs 4–9 single-row queries (one on the WRITE
 * PRIMARY). So the gates run cheapest-first and each must SHORT-CIRCUIT the next; the
 * suite asserts that by call counts, so a reordering is a red test rather than a latency
 * mystery. Two hazards the code cannot state itself:
 *
 *   · Gate 2 uses `isConfirmedNonApprovedAppBlockId`, NEVER `!isKnownAppBlockId` — the
 *     approved-id cache fails safe to an EMPTY set, so the negation would read a database
 *     outage as "every app is non-approved" and send every signed-in beacon into the
 *     expensive path during exactly that incident. Correctness at gate 2 is not required
 *     in either direction; the predicate re-checks status authoritatively.
 *   · That cache has a 5-MINUTE TTL, so a JUST-APPROVED app falls through gate 2 for up
 *     to that long — precisely its hottest window.
 *   · Gate 3.5 — the per-viewer cost ceiling — sits AFTER the flag and BEFORE the
 *     predicate, and both halves of that position are load-bearing. After the flag: the
 *     limiter then costs ZERO Redis calls for anonymous viewers, for approved apps, and for
 *     every viewer the flag does not admit — which is every caller in production today,
 *     since the flag is base-off. Before the predicate: gate 4 is the only expensive gate,
 *     and bounding it is the entire point. Its own reasoning, its key, both fail directions
 *     and the cost arithmetic live in `~/server/utils/private-run-impression-rate-limit`.
 *
 * 🔴 WHICH BRANCH RUNS IS CHOSEN BY THE CALLER, NOT BY A MOUNT. `appBlockId` comes out of
 * the request body, so "an app confirmed not approved" is any string a signed-in caller
 * cares to send, and the common beacon path did ZERO Postgres queries before this. That
 * is a COST property, not an authorization one — and it is what gate 3.5 below bounds.
 * ⚠️ The flag's precondition block used to carry "this route has no rate limit" as a gate
 * on widening; that item is now SATISFIED and the residual it does NOT cover is recorded
 * there. Read it there, not here — one home for the ledger.
 *
 * 🔴 ONE LIMITER FOR BOTH WRITERS, INSIDE THE GATE — NOT ONE PER WRITER. The requirement
 * was to settle the cost for BOTH `blockRenders` writers, and the shared predicate covers
 * both BY CONSTRUCTION: `block-render-writer.call-site-ledger.test.ts` fails if a writer is
 * added, removed, or stops calling this function, so "both" is structural rather than a
 * claim asserted twice in two files that can drift. Two copies of one cost predicate is the
 * shape that regenerates the same bug at every site.
 *
 * 🔴 AN ABSENT FLAG KEY THROWS: it bypasses the eval cache (only successful evaluations
 * are cached) and logs on every reaching call. The key must EXIST, base-off, before this
 * path takes traffic. Read its live state from Flipt, never from a comment.
 *
 * KNOWN SIDE-EFFECT: the dev tunnel also mounts a non-approved app for its OWNER, so with
 * the flag on their own dev-tunnel mounts stop appearing in their own impressions —
 * self-affecting, on an app with no public audience. Discriminating the two would need a
 * trusted per-mount signal, which is exactly what does not exist.
 *
 * NOT suppressed: the prom render counter and launch histograms. Internal-only, app id
 * clamped to 'other'. Hiding the owner-visible rail is the decision; blinding ourselves
 * is not — and it is why the fix is here rather than a client-side skip, which the tRPC
 * writer would bypass entirely.
 */
export async function isPrivateRunImpression(args: {
  /** The app the impression is attributed to. Client-chosen; see the derivation note. */
  appBlockId: string;
  /** The SERVER-RESOLVED session user. Never anything parsed from the request body. */
  viewer: SessionUser | undefined | null;
}): Promise<boolean> {
  const { appBlockId, viewer } = args;

  // (1) FREE. Anonymous viewers are the majority of impressions and can never privately
  // run: every private-run audience is a named relationship to the app, or a moderator.
  if (!viewer || typeof viewer.id !== 'number') return false;

  try {
    // (2) CACHED. Confirmed-non-approved only — never the negation; see the docblock.
    if (!(await isConfirmedNonApprovedAppBlockId(appBlockId))) return false;

    // (3) THE KILL-SWITCH, evaluated FOR THIS VIEWER because that is what the predicate
    // requires and refuses to do itself.
    //
    // ⚠️ DEFERRED, AND THE REASON WRITTEN HERE WAS WRONG. It said the deferral keeps the
    // beacon route's import graph from "eagerly pulling Flipt in to do nothing".
    // `~/server/flipt/client` is ALREADY eager on that route — `block-render.ts` imports
    // `~/server/clickhouse/client`, which re-exports `./tracker`, which value-imports
    // `isFlipt` from it. What this deferral actually keeps out, measured over the route's
    // static closure with type-only edges excluded, is 9 modules (this flag service and
    // its own dependencies) plus `@civitai/flipt/context` and `slugify` — real, but not
    // the thing the comment named. See the note on gate 3.5 for why the number is quoted
    // rather than the mechanism.
    const { isAppBlocksPrivateRunEnabled } = await import('~/server/services/app-blocks-flag');
    const privateRunEnabled = await isAppBlocksPrivateRunEnabled({ user: viewer });
    if (!privateRunEnabled) return false;

    // (3.5) THE COST CEILING on the one expensive gate.
    //
    // 🔴 DEFERRED LIKE ITS NEIGHBOURS, AND THIS ONE HAS NO GRAPH REASON AT ALL — said
    // plainly rather than replaced with a better-sounding one. The comment here claimed the
    // deferral keeps "the Redis client" out of the beacon route's eager graph. Both things
    // it could have meant are already eager on that route: `~/server/redis/client` arrives
    // via `get-server-auth-session` → `auth/session-client`, and `prom-client` via the
    // route's own static import of `~/server/metrics/app-block-runtime.metrics`. Measured
    // over the route's static closure with type-only edges excluded, converting THIS
    // `await import` to a top-level one would add exactly ONE module — the limiter itself —
    // and zero packages. (Contrast gate 4, which keeps 23 modules and `jose` out; that one
    // is load-bearing.) It stays deferred because it is harmless and consistent with its
    // two neighbours, NOT because it buys anything measurable, and the `await import` COUNT
    // asserted in `block-render-writer.call-site-ledger.test.ts` is what actually guards
    // gate 3.5 against removal.
    //
    // 🔴 REFUSED ⇒ `false` ⇒ THE IMPRESSION IS RECORDED. Never `true`: `true` means
    // "suppress", so refusing that way would let any viewer hide their own impressions by
    // deliberately exhausting their own window — a client-settable suppression, which this
    // file's own docblock calls a LARGER defect than the leak. It also matches the `catch`
    // below: FAIL TOWARD RECORDING THE IMPRESSION.
    //
    // ⚠️ THE COST OF THAT, STATED: above the ceiling a real reviewer's private-run
    // impressions ARE recorded and therefore become visible to the app's owner, so the
    // invisibility guarantee — not the cost bound — is what degrades. Hence a ceiling far
    // above any real review session's mount rate, and a prom counter on the refusal so the
    // degradation is observable rather than silent.
    //
    // A limiter failure FAILS OPEN INSIDE THE LIMITER (it returns `allowed`), so a Redis
    // incident removes the cost bound rather than the protection — see its docblock. Its
    // BODY is total: a throwing `multi()`, a rejecting `exec` and a malformed reply all
    // answer `allowed` rather than reaching the catch below, so none of them can be
    // mistaken for a gate failure by anything reading the fail-open log. ⚠️ The one thing
    // that CAN reach that catch is the dynamic import itself failing, which is a gate
    // failure like any other and is handled as one.
    const { checkPrivateRunImpressionRateLimit } = await import(
      '~/server/utils/private-run-impression-rate-limit'
    );
    const withinCeiling = await checkPrivateRunImpressionRateLimit(viewer.id);
    if (!withinCeiling.allowed) return false;

    // (4) THE REAL PREDICATE. `db: 'read'` — the default, and the replica is right here:
    // this is not a security gate, and a lag window can only mis-decide ONE impression
    // row in either direction. (The predicate still reads the viewer row from the
    // primary itself; that is its own, deliberate, security-shaped divergence.)
    const { resolvePrivateRunAccess } = await import(
      '~/server/services/blocks/private-run-access.service'
    );
    const access = await resolvePrivateRunAccess({
      by: { appBlockId },
      viewer,
      db: 'read',
      privateRunEnabled,
    });
    // ONLY an outright grant suppresses. Every refusal — including `approved`,
    // `not-deployed`, `owner-banned` and `no-iframe-src` — means this mount is not a
    // private run, so the impression is real and must be recorded.
    return access.allowed === true;
  } catch (err) {
    // 🔴 FAIL TOWARD RECORDING THE IMPRESSION. `blockRenders` has no status column and
    // the beacon is fire-and-forget, so a wrongly-dropped row is silent and permanent,
    // while a wrongly-kept one is at worst one review visible to one owner.
    reportGateFailure(err);
    return false;
  }
}

/**
 * The fail-open health signal. Never throws, never rejects, never awaited.
 *
 * 🔴 ITS OWN try/catch BECAUSE A THROW INSIDE A `catch` BLOCK IS NOT CAUGHT BY THAT
 * BLOCK. Inlined, a logging client that failed SYNCHRONOUSLY would escape the gate — and
 * `block-render.ts` awaits it with no try/catch of its own, so that is a 500 on a public
 * beacon AND a lost impression. ⚠️ NOT REACHABLE TODAY: `logToAxiom` is an `async
 * function`, which converts a sync throw into a rejection, so this half is an invariant
 * guard against a future non-async logger rather than a fix for a live escape. Cheap
 * enough to keep; do not cite it as a bug that was found.
 *
 * 🔴 THE `.catch` IS A DIFFERENT MECHANISM, NOT THE ASYNC HALF OF THE SAME ONE. Nobody
 * awaits this promise, so a rejection would not reach the gate at all — it would be an
 * UNHANDLED REJECTION. `packages/civitai-axiom` records what that costs: its own client
 * is called without awaiting by the background jobs pods, and an unhandled rejection
 * there exited the process — all three pods died at once. ⚠️ THAT INCIDENT PREDATES THE
 * CONTAINMENT THAT SHIPPED IN THAT CLIENT, so today's `logToAxiom` cannot realistically
 * reject either: this half is an invariant guard too, exactly like the `try` above. Do
 * not cite it as a live hazard — that package's own docblock retracts the adjacent
 * theory about its own race, and labels the test that appears to cover it an invariant
 * guard for the same reason.
 *
 * 🔴 BUT NOT SILENT. A gate that fails open without a trace means the leak is reopened
 * and nothing says so — the reassuring-zero shape. Bounded: reachable only on the rare
 * path (a signed-in viewer, an app confirmed NOT approved, the flag on), so it cannot
 * become a per-impression flood.
 *
 * 🔴 THE ERROR CLASS, NEVER THE MESSAGE. A `PrismaClientValidationError` renders the
 * failing invocation INCLUDING ITS ARGUMENTS, and the invocation inside the try is
 * `user.findUnique({ where: { id: <viewer.id> } })` — so a message would carry the
 * viewer's id onto a public write path's log. This is a health signal, not a second audit
 * trail; the identifiers live in the mint's audit line.
 */
function reportGateFailure(err: unknown): void {
  try {
    logToAxiom(
      {
        name: 'private-run-impression-gate-failed',
        type: 'error',
        message: 'private-run impression gate failed open; the impression WAS recorded',
        errorClass: err instanceof Error ? err.name : typeof err,
      },
      'clickhouse'
    ).catch(() => undefined);
  } catch {
    // A synchronously-throwing log client must not reach the caller. See above.
  }
}
