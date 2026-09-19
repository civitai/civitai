import { dbRead } from '~/server/db/client';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import { subjectForUserId } from '~/server/services/block-token-subject';

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
 * stamped in exactly one place — `signDevScopedPageToken`, UNCONDITIONALLY — and that
 * function is reached by six mint paths, so the bare claim says only "one of six things".
 * The letters below are used by name in the code; this is their key, and it is the
 * population table the rest of this file refers to:
 *
 *   ID  MINT                                              appId / appBlockId       ROW?  MINT NEEDS approved?  VERDICT
 *   A   `dev-token` approved mode (`dev:live`)            real / real `apb_`       yes   YES                   `ok` while approved; REFUSED once it is not, unless owner+tunnel
 *   B   `dev-token` pending mode                          `pending-…` / `pubreq_…` no    n/a                   exempt — no row
 *   C   `dev-token` local-manifest mode                   `local-…` / `page_local_…` no  n/a                   exempt — no row
 *   D   `tryDevTunnelScopedMint` (ephemeral tunnel)       `ephemeral-…` (both)     no    n/a                   exempt — no row
 *   E   `tryDevTunnelOwnedNonApprovedMint`                real / real `apb_`       yes   NO — requires NOT approved  exempt IFF owner AND active tunnel
 *   F   `mintReviewBlockToken` (render-only)              `pending-…` / `pubreq_…` no    requires `pending`    exempt — no row
 *   F′  `mintReviewBlockToken` (run-for-real)             as F, + `reviewRunForReal`  no  requires `pending`   exempt — from the claim, pre-read
 *
 * A and E are CLAIM-IDENTICAL: same id shapes, same `dev: true`, both owner-held, no
 * distinguishing field. What separates them is not the token but the preconditions their
 * mints enforce — E requires an ACTIVE dev tunnel, A does not — which is why the guard
 * re-derives those rather than reading a flag.
 *
 * ⚠️ ONE CASE THE TABLE DOES NOT CAPTURE: an A-class token held by an owner who happens to
 * have a live tunnel for the same slug IS exempted. That is the deliberate mirror (the
 * same owner could mint an E token for the same app in the same state), but A and E are
 * not scope-identical — A clamps against `DEV_TOKEN_SCOPE_ALLOWLIST`, which includes
 * `apps:storage:read|write`, while E's tunnel allowlist withholds them. The delta is
 * closed one layer down rather than here: `resolveStorageContext` exempts only
 * `reviewRunForReal`, so those storage scopes stay inert on a non-approved app.
 *
 * 🔴 WHAT THIS DELIBERATELY DOES NOT RE-CHECK, so the justification is not overstated
 * again. The mint-time belts also include the author / dev-tunnel Flipt flags, forced-SFW,
 * the dev budget cap, and the clamp of scopes to the last moderator-approved snapshot
 * (`approvedScopes`). NONE of those are re-evaluated here. Two belts are re-checked; the
 * rest are containment, and are named as containment rather than as this gate's reasoning.
 *
 * ⚠️ AND THE CONTAINMENT CLAIM IS SCOPED, because an earlier draft of this paragraph
 * overstated it in exactly the way the card warned about. *For population E*, a
 * never-approved app cannot obtain `ai:write:budgeted`: its only scope source is
 * `clampTunnelDeclaredScopes(app.approvedScopes)`, `approvedScopes` is written only by the
 * mod-approval flow, and clamping `[]` cannot invent a scope. That is an E-path invariant,
 * NOT a property of dev tokens. B and C source the un-reviewed pending manifest and the
 * RAW CLIENT REQUEST BODY respectively, and D sources the tunnel session's declared
 * grants; none is clamped to any moderator-approved snapshot, and D's brand-new branch
 * strips spend only while `app-blocks-dev-tunnel-unsubmitted-spend` is OFF. Those three
 * are bounded instead by the bearer's own `AIServicesWrite` entitlement, self-bound spend,
 * the per-call dev cap and the per-user daily cap — and they are also the populations this
 * gate still exempts unconditionally, because they have no row an APPROVAL gate could ever
 * have decided on. That is the residual surface; it is not closed here and is not claimed
 * to be. Dev tokens remain revocable regardless — a separate check at each call site,
 * never exempted.
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
 * skipping the read is what made the verdict independent of the row's status. Exactly one
 * thing short-circuits ahead of it: a run-for-real review token, answered from its claims.
 * The read itself is UNCHANGED — still `select: { status: true }` — and that is
 * deliberate: the owner column is resolved inside the rare branch instead, because a
 * nested relation select would have been a second round trip on every request rather than
 * a wider row (no `relationJoins`; see the predicate). So the new cost is TWO lookups —
 * one `OauthClient` primary-key read and two sysRedis GETs — both reached ONLY on the dev
 * + real-row + NOT-approved path. No approved app and no non-dev token pays either.
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
 * 🔴 IT DOES NOT CATCH **THE ROW READS**. A failed `appBlock` or `oauthClient` read
 * propagates, so each caller keeps its OWN answer to "what does an unreachable replica
 * mean here" rather than inheriting one: REST converts it to a 503 in
 * `resolveRestApprovalVerdict` below, and the bridge lets it propagate as it always has.
 * Catching those HERE would silently change the bridge's behaviour on a replica incident —
 * from the raw error it surfaces today to a swallowed one plus a log line the bridge never
 * emitted — which is exactly the kind of drift consolidating two copies is supposed to
 * prevent, not introduce.
 *
 * ⚠️ THE DEV-TUNNEL RE-CHECK IS THE ONE EXCEPTION, AND THIS HEADING USED TO DENY IT
 * BLANKET-STYLE. That leg (clawgate #571) IS wrapped, and it does exactly what the
 * paragraph above calls the anti-pattern: swallows, logs a line the bridge never emitted,
 * and answers a verdict. The difference that makes it the right call there and the wrong
 * one here is the SUBJECT: an unreachable replica means "we cannot establish whether this
 * app may run at all", which is a different question per caller; an unreachable dev-tunnel
 * cache means "this owner has no live tunnel", which is the same answer everywhere and is
 * the fail-closed one. The exception is deliberate, it is argued at the `catch` itself,
 * and it is scoped to that one call — do not widen it to the reads.
 */
export async function resolveAppBlockApprovalVerdict(
  claims: BlockTokenClaims
): Promise<AppBlockApprovalVerdict> {
  // POPULATION F′ — the moderator run-for-real review sandbox. The ONE population with a
  // purpose-built discriminator, and the ONE that must run a non-approved app while NOT
  // being its owner. Answered before the read because the review mint signs
  // `appId: pending-<ULID>`, which is not an `OauthClient.id` and so resolves to no row —
  // the read could only ever return `not_found`. (The `pubreq_` id everyone reaches for
  // when explaining this is the `appBlockId`, which this lookup never touches.)
  //
  // 🔴 `dev` IS REQUIRED ALONGSIDE IT, even though every mint that stamps
  // `reviewRunForReal` also stamps `dev`. The card this change answers is about keying
  // authorization on one signed boolean without narrowing it; taking `reviewRunForReal`
  // alone would be the same mistake one field over, and would make the exemption WIDER
  // than the one it replaced. `BlockTokenService.sign` accepts the field independently,
  // so the pairing is the only thing that closes that dimension, and it costs nothing.
  if (claims.dev === true && claims.reviewRunForReal === true) return 'dev_exempt';

  const block = await dbRead.appBlock.findUnique({
    where: { appId_blockId: { appId: claims.appId, blockId: claims.blockId } },
    select: { status: true },
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
  // 🔴 THE OWNER IS RESOLVED HERE, IN THE BRANCH, AND NOT AS A NESTED SELECT ON THE READ
  // ABOVE. The obvious spelling — `select: { status: true, app: { select: { userId } } }`
  // — reads like one widened row and is NOT: the schema's generator block enables only
  // `previewFeatures = ["metrics"]`, with no `relationJoins`, so Prisma has no join
  // strategy available and resolves a nested relation with a SECOND round trip. `appId`
  // is a REQUIRED relation, so unlike a nullable FK that second query cannot be skipped —
  // it would fire for every token whose row exists, i.e. on every bridge call including
  // the timer-driven `pollWorkflow` and on every block-JWT REST request, to read a column
  // only this branch consults. `claims.appId` IS the `OauthClient.id` (it is the FK the
  // unique is keyed on), so doing it here is the same primary-key lookup Prisma would
  // have issued, issued only when it is needed. The identical measurement for this
  // mechanism is recorded in `src/server/selectors/reaction.selector.ts`.
  const app = await dbRead.oauthClient.findUnique({
    where: { id: claims.appId },
    select: { userId: true },
  });
  // Compared against the canonical subject encoding rather than parsed. `subjectForUserId`
  // is the encoder the MINT itself uses, so the guard and the token are the same string by
  // construction rather than by two hand-typed templates agreeing — which they did not:
  // this comparison was a third copy of `user:<id>` until the leaf was extracted, and each
  // copy was pinned only by its own literal, so a suite could not see them diverge.
  // Comparing forward also avoids importing the PARSER from `block-scope.middleware`,
  // which imports THIS module. `anon` can never match a numeric owner, and a missing row
  // fails CLOSED.
  const ownerUserId = app?.userId;
  if (ownerUserId == null || claims.sub !== subjectForUserId(ownerUserId)) return 'not_approved';

  // Dynamic import, deliberately: `dev-tunnel.service` pulls the k8s control-plane client
  // and the sysRedis surface, and this module is imported STATICALLY by the REST
  // middleware, which fronts 13 page routes. Loading it lazily keeps that graph out of
  // every one of those bundles — the same reason `tryDevTunnelOwnedNonApprovedMint` and
  // all eight `blocks.router` call sites import it this way. Reached only on the dev +
  // real-row + NOT-approved path.
  //
  // 🔴 WRAPPED, BECAUSE "IT CANNOT THROW" WAS ALMOST TRUE AND ALMOST IS NOT A POSTURE.
  // `getActiveDevTunnel` swallows a rejected read, a `withSysReadDeadline` timeout and a
  // JSON parse failure — but it attaches `.catch(() => null)` to the RESULT of
  // `sysRedis.get(...)`, so a SYNCHRONOUS throw from the client (the exact shape
  // `dev-tunnel.service` warns about twice in its own file) escapes it, as can the
  // dynamic import itself. Unwrapped, that escape does not fail closed: on REST
  // `resolveRestApprovalVerdict` catches it as `lookup_failed` → 503, attributing a cache
  // fault to the replica read and pointing an incident at the wrong subsystem, and on the
  // bridge it surfaces as a raw internal error instead of a refusal. So the posture is
  // written rather than inherited.
  //
  // FAILING CLOSED HERE IS THE OPPOSITE OF THE REVOCATION CHECK ONE STEP EARLIER, which
  // fails OPEN by construction, and of the `lookup_failed` case above. That is deliberate:
  // the population that loses is owners debugging an app that is ALREADY suspended,
  // pending or deprecated. Nothing user-facing is served by a non-approved app either way,
  // so the cost is a degraded developer surface during an incident, not an outage.
  try {
    const { getActiveDevTunnel } = await import('~/server/services/blocks/dev-tunnel.service');
    // ⚠️ WHAT ENDS A SESSION EARLY IS THE REAPER, NOT THIS CALL — and its idle clock is
    // refreshed by ENTRY-document loads only. `dev-tunnel-gate` returns before stamping
    // `lastActivityAt` on the websocket and subresource branches, so HMR traffic and the
    // block's own XHR do not count as activity. An owner with the page open and no iframe
    // re-navigation for 30 minutes therefore loses this exemption MID-SESSION, and the
    // re-mint does not rescue them because the mint requires the same tunnel. That is the
    // intended direction — an exemption that outlives the debugging session it was minted
    // for is the thing this change exists to stop — but the failure is silent, so it is
    // recorded here rather than left for someone to rediscover from a support ticket.
    return (await getActiveDevTunnel(ownerUserId, claims.blockId)) ? 'dev_exempt' : 'not_approved';
  } catch (err) {
    // LOGGED, not swallowed — see `tunnelFailureLog`. The verdict is still the fail-closed
    // one, but an incident on this leg must be distinguishable from the stale-token
    // population that shares its verdict.
    tunnelFailureLog.warn(err);
    return 'not_approved';
  }
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
 * 🔴 THE COUNT IS NOT THE ALERTING SIGNAL — FOR THE REPLICA-READ LOGGER.
 * `civitai_app_block_rest_approval_verdicts_total{reason="lookup_failed"}` is, and it is
 * UNTHROTTLED, so that throttle only bounds the prose. Do not add a metric there and do
 * not read a suppressed log as a suppressed verdict.
 *
 * ⚠️ THAT IS NOT TRUE OF THE SECOND CONSUMER, AND THIS CONSTANT NOW SITS ABOVE BOTH.
 * `tunnelFailureLog`'s failures resolve to `not_approved`, which has NO dedicated
 * `reason=` label — they share the series with every legitimate stale-token refusal. So
 * for that leg the throttled log IS the only signal, and a suppressed line really is lost
 * information rather than redundant prose. Same 60s window, opposite relationship to the
 * metrics; the window is shared because the rate argument is identical, not because the
 * observability story is.
 */
const LOOKUP_FAILURE_LOG_WINDOW_MS = 60_000;

/**
 * 🔴 ONE THROTTLE IMPLEMENTATION, SEPARATE WINDOWS PER FAILURE MODE. The logic was written
 * once and open-coded once; there are now two failure modes that need it (the replica read
 * and the dev-tunnel re-check), and giving them a SHARED window would be wrong in the
 * expensive direction: two simultaneous incidents would suppress each other, and the one
 * you did not see would be the one you most needed. Each caller gets its own closure, so
 * each logs its first occurrence immediately and each reports its own
 * `droppedSinceLastLog`.
 */
function makeThrottledWarn(prefix: string): { warn: (err: unknown) => void; reset: () => void } {
  let lastLoggedAt = 0;
  let droppedSinceLastLog = 0;
  return {
    warn(err: unknown): void {
      const now = Date.now();
      if (lastLoggedAt !== 0 && now - lastLoggedAt < LOOKUP_FAILURE_LOG_WINDOW_MS) {
        droppedSinceLastLog++;
        return;
      }
      const dropped = droppedSinceLastLog;
      droppedSinceLastLog = 0;
      lastLoggedAt = now;
      // eslint-disable-next-line no-console
      console.warn(
        `${prefix}: ${
          err instanceof Error ? err.message : String(err)
        } droppedSinceLastLog=${dropped} windowMs=${LOOKUP_FAILURE_LOG_WINDOW_MS}`
      );
    },
    reset(): void {
      lastLoggedAt = 0;
      droppedSinceLastLog = 0;
    },
  };
}

const lookupFailureLog = makeThrottledWarn('[block-scope] approved-status lookup failed');

function warnLookupFailed(err: unknown): void {
  lookupFailureLog.warn(err);
}

/**
 * 🔴 THE DEV-TUNNEL LEG'S OWN LOG, AND IT EXISTS BECAUSE THE FIRST VERSION OF THAT LEG HAD
 * NONE. The `try/catch` around the tunnel re-check converts a throw into `not_approved` —
 * which is correct as a VERDICT and was wrong as OBSERVABILITY, because before the wrapper
 * existed such a throw reached `resolveRestApprovalVerdict`, was logged here, and answered
 * `lookup_failed`. Swallowing it silently folded a cache incident into
 * `…verdicts_total{reason="not_approved"}` — the *same* series this change ships to be
 * watched on, and the one the predicate's docblock calls the operator's only view of the
 * 4h window closing. A sysRedis fault would then have read as the narrowing working.
 *
 * ⚠️ DELIBERATELY A LOG AND NOT A NEW VERDICT — AND THE FIRST VERSION OF THIS PARAGRAPH
 * GAVE THE WRONG REASON, IN THE FAIL-OPEN DIRECTION. It claimed "the REST mapping for an
 * unknown verdict is 503". It is not: `withBlockScope`'s chain is `not_approved` → 403,
 * `lookup_failed` → 503, and then an `else` that asserts `approval satisfies 'not_found'`,
 * logs "SERVING (observe-only)" and **falls through to the handler**. So REST's runtime
 * default for a verdict it does not recognise is to SERVE, and it would additionally log
 * the request as a missing row, which it would not be. The bridge is the opposite — a
 * `satisfies never` followed by an unconditional FORBIDDEN. Two callers, two opposite
 * unknown-verdict postures; a paragraph telling the next author that REST refuses would
 * have sent them the wrong way.
 *
 * THE REAL REASONS, now that they are stated correctly: a new union member must be mapped
 * by BOTH callers (the compile error at REST's `satisfies` is what forces that, and it
 * does force it), and REST's runtime default on the way there is service rather than
 * refusal. Note the honest counterpoint, since the original sentence also inverted it: a
 * dedicated verdict WOULD be better attribution than this log, because it would carry its
 * own `reason=` label instead of sharing `not_approved`. The log is the cheaper answer,
 * not the better-instrumented one. If this leg ever needs alerting rather than forensics,
 * the verdict is the right change — made deliberately, with both mappings updated.
 */
const tunnelFailureLog = makeThrottledWarn('[block-scope] dev-tunnel re-check failed');

/** TEST-ONLY: reset the per-pod log-throttle windows so tests don't share state. */
export function __resetApprovalLookupFailureLogThrottleForTests(): void {
  lookupFailureLog.reset();
  tunnelFailureLog.reset();
}
