import { dbRead } from '~/server/db/client';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * WHY THIS IS ITS OWN MODULE rather than a private function inside
 * `block-scope.middleware.ts`: the TEST SEAM. It gives the existing `withBlockScope`
 * suites a single one-line `vi.mock` of this specifier — the same seam they already use
 * for `block-revocation.service`, which is the sibling check this one sits next to —
 * instead of reaching into the middleware's own module graph to stub a private function.
 *
 * 🔴 IT DOES **NOT** BUY LOAD-TIME ISOLATION FROM PRISMA, and an earlier version of this
 * docblock claimed it did. The claim was that a top-level `dbRead` import inside the
 * middleware would make a working Prisma client a load-time prerequisite for its pure
 * routing helpers (`normalizeEndpoint`, `enforceContextBinding`, `verifyBlockToken`),
 * the way `loadAllowedOrigins` avoids with a dynamic `await import`. That is false as
 * written, because `block-scope.middleware.ts` imports THIS module **statically**, and
 * this module imports `dbRead` statically one line above. MEASURED by walking the static
 * import graph (`import type` and `await import(` excluded, which are erased/deferred and
 * create no load-time edge): at HEAD there is a path
 *
 *     block-scope.middleware.ts → block-approval.service.ts → src/server/db/client.ts
 *
 * and with that one import line stripped from the middleware there is NO path at all
 * (37 files reached). So the edge this paragraph used to say the split avoided is the
 * edge the split INTRODUCED. The runtime impact is low — the middleware is server-only
 * and every real request path already has Prisma — but the sentence was a JUSTIFICATION,
 * and left standing it tells the next author that inlining the predicate would cost
 * something it would not.
 *
 * WHAT THAT MEANS IF YOU ARE CONSIDERING INLINING IT: the load-time argument is not a
 * reason to keep the split, and never was. The test seam is, and it is a real one — but
 * it is the whole case. If you want the middleware's pure helpers importable without
 * Prisma, moving this predicate back would not achieve it; the import in the middleware
 * would have to become dynamic, like `loadAllowedOrigins`'.
 */

/**
 * THE APPROVED-STATUS PREDICATE for the App Blocks runtime. ONE lookup and ONE
 * comparison, for BOTH halves of the runtime: `withBlockScope` (REST) and
 * `assertAppBlockApproved` in `block-bridge-auth.service.ts` (the tRPC bridge) both
 * resolve their verdict here.
 *
 * 🔴 IT RESOLVES A VERDICT; IT DOES NOT DECIDE A RESPONSE, and that split is deliberate
 * rather than incidental. The two callers have DIFFERENT policies on a missing row — REST
 * SERVES it, the bridge answers `NOT_FOUND` — so sharing the response mapping would
 * silently move one of them. What is shared is the part that must never disagree: which
 * row is read, from which claims, and what counts as approved. What is NOT shared is what
 * each caller does about it. See `resolveRestApprovalVerdict` below for the REST policy
 * and `assertAppBlockApproved` for the bridge's.
 *
 * WHY IT EXISTS. `verifyBlockToken` answers ONE question — is this a token we signed,
 * for this issuer/audience, not yet expired. Revocation — the check that runs one step
 * before this one at the call site in `withBlockScope` — answers a second: has the
 * INSTALL been torn down. Neither can see a MODERATOR SUSPENSION, because the two
 * takedown signals are deliberately disjoint:
 *
 *   - REVOCATION is written by uninstall and toggle-off only (`block-registry.service`).
 *   - `app_blocks.status` is flipped by mod delist and owner unpublish
 *     (`flipBackingBlockStatus`, `offsite-moderation.service`), which writes NO
 *     revocation marker — and must not, because conflating a moderator action with a
 *     user action would change uninstall semantics.
 *
 * So until this gate existed, a suspended app kept serving every `withBlockScope`
 * route for the remaining life of any already-minted token, while the tRPC bridge
 * refused.
 *
 * THE SIZE OF THAT, and the two claims are of DIFFERENT strengths — stated separately
 * because merging them would overstate the weaker one:
 *   - TRACED, by reading each call graph at the commit that added this: of the 13 page
 *     routes that wrap `withBlockScope`, 11 have nothing anywhere below them that reads
 *     `app_blocks.status`. The two that do — `shared-storage/top` and
 *     `shared-storage/increment` — refuse INCIDENTALLY, because they delegate to
 *     `resolveSharedContext`, which reads the status itself. They now refuse here first,
 *     one step earlier and for the stated reason.
 *   - EXECUTED, in `src/tests/api/v1/blocks/suspended-app-rest-refusal.test.ts`, on the
 *     two that carry a real side effect: at the base revision, a suspended app driving
 *     `POST /api/v1/blocks/tip` CALLED `createBuzzTipTransactionHandler`, and one driving
 *     `POST /api/v1/blocks/collections/:id/follow` CALLED `addContributorToCollection`.
 *     Not inferred from the wrapper — the spies recorded the calls.
 *
 * THE WINDOW THIS CLOSES IS BOUNDED, AND SAYING SO IS PART OF THE JUSTIFICATION. The
 * mint endpoint already requires `status === 'approved'`
 * (`src/pages/api/v1/block-tokens/index.ts` — "Block is not approved"), so a
 * suspended app can never obtain a NEW token. What was open was the tail of the tokens it
 * already held.
 *
 * 🔴 THE TAIL THIS GATE CLOSES NOW INCLUDES MOST OF THE DEV ONE. It used to close only
 * the non-dev tail — 900s default and 300s settings-scoped
 * (`src/server/services/block-token-lifetimes.ts`) — because `claims.dev === true`
 * short-circuited the whole check, leaving the 4-HOUR DEV TOKEN, the longest-lived token
 * there is, entirely outside it: 16× the default window, on the class with the widest
 * scopes. Fifteen minutes of Buzz leaving an account through an app a moderator has just
 * taken down is the case this gate was built for; four hours of the same on a dev token
 * was the case it did not reach (clawgate #571). The exemption is now conditioned rather
 * than unconditional — see the predicate.
 *
 * 🔴 THE EXEMPTION, AND WHY IT IS THREE CASES RATHER THAN ONE BOOLEAN. `dev: true` is
 * stamped in exactly one place (`signDevScopedPageToken`) and reached by six mint paths,
 * so the bare claim says only "one of six things". Three of those must bypass approval
 * and three must not, and the guard now separates them:
 *
 *   BYPASS — (i) the moderator run-for-real review sandbox, which carries its own signed
 *   `reviewRunForReal` claim and is the one population that must run a non-approved app
 *   while not owning it; (ii) every synthetic-id mint (`pubreq_…`, `page_local_…`,
 *   `ephemeral-…`), which has no backing row to be approved; (iii) the owner dev-tunnel
 *   mint (#3285), which signs a REAL `apb_` id for an app that is deliberately
 *   suspended/pending/deprecated — but only while the two preconditions ITS mint enforces
 *   still hold (owner, active tunnel), re-derived here rather than assumed.
 *
 *   REFUSED — a `dev:live` token minted against an APPROVED app whose status has since
 *   flipped. Its mint required `approved`, so it never had a claim on a non-approved app;
 *   it simply outlived the approval by up to four hours.
 *
 * 🔴 WHAT THIS DELIBERATELY DOES NOT RE-CHECK, so the justification is not overstated
 * again. The mint-time belts also include the author / dev-tunnel Flipt flags, forced-SFW,
 * the dev budget cap, and the clamp of scopes to the last moderator-approved snapshot
 * (`approvedScopes`). NONE of those are re-evaluated here. They bound what a stale dev
 * token can DO — self-bound spend, capped per call and per day, and a never-approved app
 * cannot obtain `ai:write:budgeted` at all because `clampTunnelDeclaredScopes([])` cannot
 * invent it — but they are not what this gate decides. Two belts are re-checked; the rest
 * are containment, and are described here as containment rather than as this gate's
 * reasoning. Dev tokens also remain revocable, which is a separate check at each call site
 * and was never exempted.
 *
 * 🔴 HOW THIS RECONCILES WITH THE OTHER TWO RESOLVERS, which apply visibly different
 * rules — they are not three policies, they are one policy plus two structural
 * narrowings, and reading them as policy disagreements is the mistake to avoid. The gap
 * NARROWED with clawgate #571: this predicate now answers `reviewRunForReal` FIRST, which
 * is `resolveStorageContext`'s entire rule, so the three no longer disagree about the
 * review sandbox — only about how much more they refuse beyond it.
 *   - `resolveStorageContext` (apps.router) exempts ONLY `reviewRunForReal`, not `dev`
 *     generally. Per-user KV has to resolve to a real Postgres SCHEMA; a plain dev token
 *     names no schema that exists, so there is nothing a wider exemption could route to.
 *     It is therefore STRICTER than this gate by exactly the owner-dev-tunnel case, and
 *     that is correct for its target: a suspended app's owner debugging in their tunnel
 *     has a page to render, not a per-user KV schema to write.
 *   - `resolveSharedContext` (apps-shared.router) exempts nothing. Shared storage is
 *     cross-user, app-global state, and run-for-real never grants
 *     `apps:storage:shared:*` at all — so again there is no case to exempt.
 * Both are STRICTER than this gate for a reason about their target, not about approval,
 * and each is ledgered with that rationale in
 * `src/server/services/__tests__/no-unguarded-block-rest-token.test.ts`.
 *
 * 🔴 POSTURE, and it is NOT uniform — read the two cases separately, because a single
 * "fail-closed" sentence over both was wrong in the direction that costs availability.
 *
 *   - THE READ FAILED (`lookup_failed`) → FAIL-CLOSED, 503 on REST. A replica we cannot
 *     reach leaves us unable to establish that the app is allowed to run at all. That is
 *     the OPPOSITE of the revocation check one step earlier, deliberately:
 *     `BlockRevocation.isRevoked` fails OPEN by construction — a Redis incident must not
 *     take every block down, and the exposure is bounded by the token lifetime instead of
 *     by Redis recovery time. Two checks, two postures, on one path; that is a property
 *     of the primitives, not an inconsistency.
 *   - THE READ SUCCEEDED AND FOUND NOTHING (`not_found`) → REST SERVES. See the next
 *     paragraph; this is the case where "fail-closed" would be refusing a HEALTHY app.
 *
 * 🔴 WHY A MISSING ROW IS SERVED ON REST, which is the sharpest decision in this file.
 * Every moderator takedown leaves a row — `flipBackingBlockStatus` and
 * `offsite-moderation.service` WRITE a status, they do not delete the row. So 100% of
 * this gate's protective value lives in the `not_approved` branch, and `not_found` is a
 * different animal entirely: a signature-valid, non-dev token whose `(appId, blockId)`
 * resolves to nothing is a row deleted or re-keyed mid-session, blockId drift, or an
 * id-minting bug — a HEALTHY app. Refusing on it would 404 a live public endpoint, on
 * deploy, with no flag to pull, in exchange for closing no takedown path that the
 * `not_approved` branch does not already close. So it carries all of the false-positive
 * risk and none of the value, and the gate does not take it: the request is SERVED, the
 * verdict is counted under `reason="not_found"`, and the caller logs the ids. That makes
 * the false-positive rate a series someone can read rather than a support-ticket pattern.
 * 🔴 THE BRIDGE DOES NOT FOLLOW THIS. `assertAppBlockApproved` still answers `NOT_FOUND`
 * on a missing row — its callers are a first-party postMessage bridge, not a public REST
 * surface, and that behaviour predates this decision and was left exactly as it was. The
 * two policies differ ON PURPOSE, which is why this module hands back a VERDICT.
 *
 * COST: one indexed `dbRead.appBlock.findUnique` on the `(appId, blockId)` unique, on
 * the replica, per block-JWT REST request. The tRPC bridge already pays exactly this per
 * bridge call including `pollWorkflow`, so this is the same bill on a lower-volume
 * surface, not a new class of cost.
 * ⚠️ "A DEV TOKEN SKIPS IT ENTIRELY" WAS TRUE UNTIL clawgate #571 AND IS NOT NOW. A dev
 * token now pays the same read as every other token — the skip WAS the hole, because
 * skipping the read is what made the verdict independent of the row's status. Two things
 * still short-circuit ahead of it: a `reviewRunForReal` token (answered from the claim),
 * and nothing else. The read itself grew one selected column (`app.userId`), which is a
 * join on the FK, not a second query. The genuinely new cost is the dev-tunnel lookup —
 * two sysRedis GETs — and it is reached ONLY on the dev + real-row + NOT-approved path,
 * so no approved app and no non-dev token pays it.
 *
 * WHAT IT DOES NOT BUY, stated because the gate is uniform and the value is not. The
 * clearest case is `/api/v1/models/:id`: it is dual-auth, and the block-JWT branch
 * differs from the anonymous one ONLY in skipping the origin cache — same builder, same
 * arguments, same body. Refusing a suspended app there removes NO exposure, because an
 * unauthenticated caller can already fetch that body. It inherits the gate to keep ONE
 * rule at ONE place, not because it was leaking. The unscoped catalog routes are the
 * same argument one step weaker — their bodies are public but maturity-clamped per
 * token, so a block does not get strictly nothing extra there.
 */
export type AppBlockApprovalVerdict = 'ok' | 'dev_exempt' | 'not_approved' | 'not_found';

/**
 * THE PREDICATE. The only place in the App Blocks runtime that resolves the backing
 * `app_blocks` row from token claims and decides whether it is approved.
 *
 * 🔴 IT DOES NOT CATCH. A failed read propagates, so each caller keeps its OWN answer to
 * "what does an unreachable replica mean here" rather than inheriting one: REST converts
 * it to a 503 in `resolveRestApprovalVerdict` below, and the bridge lets it propagate as
 * it always has. Catching HERE would have silently changed the bridge's behaviour on a
 * replica incident — from the raw error it surfaces today to a swallowed one plus a log
 * line the bridge never emitted — which is exactly the kind of drift consolidating two
 * copies is supposed to prevent, not introduce.
 */
export async function resolveAppBlockApprovalVerdict(
  claims: BlockTokenClaims
): Promise<AppBlockApprovalVerdict> {
  // POPULATION F′ — the moderator run-for-real review sandbox. The ONE population with a
  // purpose-built discriminator, and the ONE that must run a non-approved app while NOT
  // being its owner. Answered before the read for the same reason `resolveStorageContext`
  // answers it first: a review token names a `pubreq_` id that resolves to no row, so the
  // read could only ever return `not_found`.
  if (claims.reviewRunForReal === true) return 'dev_exempt';

  const block = await dbRead.appBlock.findUnique({
    where: { appId_blockId: { appId: claims.appId, blockId: claims.blockId } },
    // `app.userId` is the app's OWNER (AppBlock → OauthClient → user). Selected, not
    // joined for its own sake: it is the ownership belt re-checked below, and reading it
    // here costs one column on a lookup this path already performs rather than a second
    // query. `resolveOwnedNonApprovedPageBlock` (block-registry.service.ts) enforces the
    // SAME `app.userId` at mint — this is that check, re-run at point of use.
    select: { status: true, app: { select: { userId: true } } },
  });

  // POPULATIONS B / C / D / F — the synthetic-id mints (`pubreq_…`, `page_local_…`,
  // `ephemeral-…`). They sign an `appId` that is not an `OauthClient.id`, so the unique
  // resolves to nothing and there is no row to be approved. A non-dev token reaching
  // `not_found` is the separate false-positive channel documented above; it is unchanged.
  if (!block) return claims.dev === true ? 'dev_exempt' : 'not_found';

  if (block.status === 'approved') return 'ok';

  // From here the row EXISTS and is NOT approved.
  if (claims.dev !== true) return 'not_approved';

  // 🔴 POPULATION A vs POPULATION E — the whole point of this function, and the one split
  // the `dev` boolean cannot make on its own. Both sign the app's REAL ids, both carry
  // `dev: true`, and their claim sets are otherwise identical:
  //
  //   A — `/api/v1/blocks/dev-token` in approved mode. The mint REQUIRES
  //       `status === 'approved'` (that file's "has no live deployment" refusal), so a
  //       token of this class reaching a NON-approved row means the status flipped AFTER
  //       it was minted — i.e. a moderator suspension, an owner unpublish, or a
  //       re-submission. It has no standing claim on a non-approved app and must be
  //       REFUSED. This is the 4h window this function exists to close.
  //   E — `tryDevTunnelOwnedNonApprovedMint` (`/api/v1/block-tokens`). The mint
  //       DELIBERATELY resolves `status: { not: 'approved' }`, so its whole purpose is to
  //       keep a suspended / pending / deprecated app runnable by its OWNER inside the
  //       OWNER'S OWN dev tunnel, to diagnose it back into review. It must keep working.
  //
  // What separates them is not the token — it is the two preconditions E's mint enforces
  // and A's does not. So this re-checks exactly those two, rather than trusting that they
  // held at mint time for a token that may be four hours old:
  //
  //   1. OWNERSHIP — the subject IS the app's owner. Free (the column above). Not merely
  //      defensive: app ownership can TRANSFER, and a transferred-away app must not stay
  //      drivable by the previous owner's outstanding dev token.
  //   2. AN ACTIVE DEV TUNNEL for (owner, blockId) — the precondition that makes E a
  //      dev-tunnel affordance rather than a general un-suspend, and the only one of the
  //      mint's belts that is both cheap to re-derive and actually discriminating. It
  //      expires on its own (30m idle / 8h hard), so a token outliving the debugging
  //      session it was minted for stops being exempt.
  //
  // Compared against the canonical subject encoding rather than parsed: `sub` is built as
  // `user:<id>` by the single mint-side encoder (`block-token.service.ts`'s
  // `input.userId == null ? 'anon' : \`user:${input.userId}\``), and comparing forward
  // avoids importing the parser from `block-scope.middleware`, which imports THIS module
  // (the cycle the module docblock above is careful about). `anon` can never match.
  // `block.app` is optional-chained so a caller stubbing a partial row fails CLOSED.
  const ownerUserId = block.app?.userId;
  if (ownerUserId == null || claims.sub !== `user:${ownerUserId}`) return 'not_approved';

  // Dynamic import, deliberately: `dev-tunnel.service` pulls the k8s control-plane client
  // and the sysRedis surface, and this module is imported STATICALLY by the REST
  // middleware. Loading it lazily keeps that graph off every non-dev request — the same
  // reason `tryDevTunnelOwnedNonApprovedMint` imports it this way. Reached only on the
  // dev + real-row + NOT-approved path, which is rare by construction.
  const { getActiveDevTunnel } = await import('~/server/services/blocks/dev-tunnel.service');
  // 🔴 FAILS CLOSED, and that posture is the OPPOSITE of the revocation check one step
  // earlier — deliberately, and for a different reason than the `lookup_failed` note
  // above. `getActiveDevTunnel` already swallows a Redis error into `null`, so a cache
  // incident resolves "no tunnel" and this branch refuses. The population that loses is
  // owners debugging an app that is ALREADY suspended or pending; nothing user-facing is
  // served by a non-approved app either way, so the cost of failing closed here is a
  // degraded developer surface during an incident, not an outage.
  const tunnel = await getActiveDevTunnel(ownerUserId, claims.blockId);
  return tunnel ? 'dev_exempt' : 'not_approved';
}

/**
 * THE REST POLICY over that verdict: identical, plus a fail-closed `lookup_failed` for a
 * read that threw. `withBlockScope` maps the result onto status codes, and the mapping is
 * not "ok passes, everything else refuses": `ok` and `dev_exempt` serve, `not_approved`
 * (403) and `lookup_failed` (503) refuse, and `not_found` is counted and SERVED. The
 * mapping lives at that call site rather than here, because the bridge maps the same
 * verdicts onto a different policy.
 */
export async function resolveRestApprovalVerdict(
  claims: BlockTokenClaims
): Promise<AppBlockApprovalVerdict | 'lookup_failed'> {
  try {
    return await resolveAppBlockApprovalVerdict(claims);
  } catch (err) {
    warnLookupFailed(err);
    return 'lookup_failed';
  }
}

/**
 * 🔴 THROTTLED, BECAUSE THE FAILURE THIS LOGS IS FLEET-WIDE AND SIMULTANEOUS. An
 * unreachable read replica does not fail one request — it fails EVERY block REST request
 * on every pod at once, for as long as the incident lasts. An unthrottled `console.warn`
 * here is therefore not "a log line per error", it is a log line per REST request at full
 * rate, i.e. the incident's own second-order cost: the logging pipeline gets the load
 * spike at exactly the moment someone needs to read it.
 *
 * TIME-BASED, NOT SAMPLED, and the difference matters for an incident log. Sampling at
 * 1-in-N drops the FIRST occurrence with probability (N-1)/N, so the thing you most want —
 * when did this start — is the thing sampling is worst at. This logs the first failure
 * IMMEDIATELY (`lastLoggedAt === 0`), then at most one line per window, and every line
 * carries `droppedSinceLastLog` so the rate is recoverable from the log itself rather than
 * being silently discarded. Same shape, and the same field name, as the per-pod limiter in
 * `~/server/logging/trpc-serialize-log`.
 *
 * ⚠️ PER POD, per process, in memory — like that limiter. With many replicas the fleet-wide
 * line rate is this rate times the pod count, which is the intended bound (a per-pod signal
 * is what tells you whether the incident is partial or total), not an oversight.
 *
 * 🔴 THE COUNT IS NOT THE ALERTING SIGNAL. `civitai_app_block_rest_approval_verdicts_total{reason="lookup_failed"}`
 * is, and it is UNTHROTTLED — every failure increments it. This throttle only bounds the
 * prose. Do not add a metric here and do not read a suppressed log as a suppressed verdict.
 */
const LOOKUP_FAILURE_LOG_WINDOW_MS = 60_000;
let lookupFailureLastLoggedAt = 0;
let lookupFailureDroppedSinceLastLog = 0;

function warnLookupFailed(err: unknown): void {
  const now = Date.now();
  if (
    lookupFailureLastLoggedAt !== 0 &&
    now - lookupFailureLastLoggedAt < LOOKUP_FAILURE_LOG_WINDOW_MS
  ) {
    lookupFailureDroppedSinceLastLog++;
    return;
  }
  const droppedSinceLastLog = lookupFailureDroppedSinceLastLog;
  lookupFailureDroppedSinceLastLog = 0;
  lookupFailureLastLoggedAt = now;
  // eslint-disable-next-line no-console
  console.warn(
    `[block-scope] approved-status lookup failed: ${
      err instanceof Error ? err.message : String(err)
    } droppedSinceLastLog=${droppedSinceLastLog} windowMs=${LOOKUP_FAILURE_LOG_WINDOW_MS}`
  );
}

/** TEST-ONLY: reset the per-pod log-throttle window so tests don't share state. */
export function __resetApprovalLookupFailureLogThrottleForTests(): void {
  lookupFailureLastLoggedAt = 0;
  lookupFailureDroppedSinceLastLog = 0;
}
