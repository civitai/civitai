import { TRPCError } from '@trpc/server';
import {
  verifyBlockToken,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import { recordBlockRevocationRefusal } from '~/server/metrics/app-block-runtime.metrics';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import { resolveAppBlockApprovalVerdict } from '~/server/services/blocks/block-approval.service';

/**
 * THE authorization gate for the tRPC half of the host↔block postMessage bridge
 * (`blocks.router.ts`). Every bridge procedure resolves its claims through here and
 * nowhere else.
 *
 * `verifyBlockToken` answers ONE question — is this a token we signed, for this
 * issuer/audience, not yet expired. It says nothing about whether the install still
 * exists or the app is still allowed to run, so on its own it keeps honouring a token
 * for a whole lifetime after the user uninstalled the app or a moderator suspended it.
 * The two tRPC resolvers beside this one check both — `resolveStorageContext`
 * (apps.router) and `resolveSharedContext` (apps-shared.router). The bridge procs called
 * `verifyBlockToken` directly, thirteen times, and checked neither.
 *
 * ⚠️ THE REST WRAPPER NOW HAS AN APPROVED-STATUS GATE TOO. This paragraph used to say it
 * checked revocation ONLY and that the resulting asymmetry was real and unclosed; that was
 * true when this helper was written and is not true now. `withBlockScope`
 * (`block-scope.middleware.ts`) resolves the same verdict through the same predicate, so
 * after a moderator suspension — which flips `app_blocks.status` and writes NO revocation
 * marker (`flipBackingBlockStatus` in `offsite-moderation.service.ts`) — BOTH halves refuse.
 *
 * 🔴 ONE REMAINING ASYMMETRY, AND IT IS DELIBERATE: a MISSING row. This path answers
 * `NOT_FOUND`; the REST wrapper counts it and SERVES the request, because a 404 there lands
 * on a public HTTP endpoint and a missing row is a healthy app rather than a takedown (no
 * takedown deletes the row). See `assertAppBlockApproved` below and the predicate module's
 * docblock. Do not "fix" that difference without deciding it.
 *
 * ORDER, and why it is this order:
 *   1. TOKEN VALIDITY — nothing downstream can be trusted before it; an unverifiable
 *      token also has no `blockInstanceId` to key a revocation lookup on.
 *   2. REVOCATION — two pipelined Redis GETs, so it is still the cheap check and it runs
 *      before the DB read. It is also the one that responds to a user action (uninstall /
 *      toggle-off) within seconds rather than at the next approval change.
 *      🔴 A PUBLISHER BAN IS NOW ALSO CONTAINED HERE, and this line has been
 *      wrong in both directions before — it claimed the ban leg until 2026-09-16
 *      with no writer in the tree, then said no ban path writes a marker. As of
 *      clawgate #618 `toggleBan` calls `revokeBlockInstancesForPublisher`
 *      (`blocks/publisher-ban-revocation.service.ts`), the third production call
 *      site of `revokeInstance` alongside `uninstallFromModel` and
 *      `toggleEnabled(false)`. It marks every live instance of every block the
 *      banned user OWNS, so those tokens are refused on their next bridge call
 *      rather than running to natural `exp`.
 *   3. APPROVED STATUS — the backing `app_blocks` row must still say `approved`.
 *
 * Each step fails closed EXCEPT revocation, which fails OPEN by construction inside
 * `BlockRevocation.isRevoked` (a Redis incident must not take the bridge down; exposure
 * is bounded by the token lifetime instead of by Redis recovery time — see that
 * service's own note). That is a property of the primitive, deliberately inherited here
 * rather than re-decided, so the REST and tRPC paths cannot drift apart on it.
 *
 * 🔴 THE PER-REQUEST COST, because this runs on EVERY bridge call including the polling
 * ones. Steps 2 and 3 add TWO Redis GETs plus ONE indexed `appBlock.findUnique` (the
 * `(appId, blockId)` unique, on the replica — never the primary) to every bridge request.
 *
 * ⚠️ IT WAS "ONE Redis GET" UNTIL THE BAN KEYSPACE WAS SPLIT OUT, and the line that
 * introduced the split claimed the count was unchanged because it used `mGet`. That was
 * wrong: this repo's client WRAPS `mGet` into `Promise.all(keys.map(get))` to avoid
 * CROSSSLOT on the cluster, so the array path never reaches the native `MGET`. The two
 * GETs are issued in one tick and pipeline, so wall-clock is likely unchanged — but the
 * COMMAND RATE against the cache cluster is doubled on this path. Count commands, not
 * awaits.
 * The read itself is issued by the shared predicate rather than spelled here, which moves
 * where it lives and not what it costs. `pollWorkflow` is the shape to think about: a
 * running block polls it on a timer, so that pair is paid per poll, per open block
 * instance. A `dev` token skips the DB read (the predicate short-circuits on the
 * exemption, before the query) but still pays both Redis GETs.
 *
 * 🔴 AND THE ORDER THIS PUT THE RATE LIMITER IN. `checkBlockCatalogRateLimit` has five
 * call sites in `blocks.router.ts`, covering seven of the fifteen bridge procedures. Four
 * are in the procedure itself — `queryAppWorkflows`, `cancelAppWorkflow`, `getImagesByIds`
 * and `getMyViewer` — and the fifth is in the `authorizeBlockBuzzRead` helper, which
 * `getMyBuzzTransactions`, `getMyBuzzAccounts` and `getMyDailyCompensation` go through.
 *
 * ⚠️ NAMED, NOT WILDCARDED, AND THAT IS THE POINT. This said "the three `getMyBuzz*`
 * procs" until the round-2 audit, which is wrong in BOTH directions: `getMyDailyCompensation`
 * is behind the helper and is not a `getMyBuzz*` name, while `getMyBuzzBalance` IS one,
 * reaches this guard directly, and carries NO limiter of any kind. So a reader enumerating
 * the seven from that wildcard both missed a throttled proc and counted the one unthrottled
 * buzz read as throttled. `authorizeBlockBuzzRead`'s own docblock carries the
 * `getMyBuzzBalance` carve-out and explains why that proc cannot call the helper; this
 * cross-file sentence did not.
 *
 * All five sites run AFTER this helper, so an over-limit request has already paid the
 * Redis GET and the `findUnique` by the time the limiter refuses it. That is not free,
 * and it is not an oversight:
 *   - The limiter CANNOT precede verification. It is keyed on `claims.blockInstanceId`,
 *     which only exists once the token has been verified — there is no earlier key to
 *     throttle on, so step 1 is a hard floor beneath it.
 *   - Moving it INTO this helper, between steps 1 and 2, would apply a 120-req/10s
 *     ceiling to ALL FIFTEEN bridge procedures rather than the seven that opted in —
 *     `pollWorkflow` and `submitWorkflow` among them. Those are deliberately not on the
 *     catalog bucket, and a polling proc is exactly the one a shared ceiling would start
 *     refusing legitimately. That is an availability change, not a cleanup.
 *   - What the reorder would save, on requests ALREADY over the ceiling — the abusive
 *     tail, not the normal path — is this helper's Redis GET, its replica `findUnique`,
 *     AND everything the caller runs between this helper returning and the limiter. At
 *     all five sites that last part is `assertAppBlocksEnabledForTokenUser`, and it is the
 *     priciest of the three: it resolves the full `SessionUser` through
 *     `sessionClient.getSessionUserById` — a shared-cache read that falls through to an
 *     internal HTTP fetch against the auth hub on a miss — and then evaluates the
 *     App-Blocks flag (an in-process, cached Flipt eval).
 *     ⚠️ This enumeration used to omit that step while phrasing itself as closed ("what
 *     the reorder would save is one Redis GET + one replica findUnique … roughly one
 *     op") — and it is now TWO GETs, per the note above. It is not roughly one op: on a session-cache miss it is a network round-trip.
 * The conclusion is unchanged, because it never rested on the cost: what decides it is the
 * availability argument above — a shared 120/10s ceiling would reach `pollWorkflow`. The
 * cost line only ever said the reorder was not worth making for its own sake, and a
 * larger saving on an over-limit request does not buy a ceiling on the polling procs.
 * So the order stands. If a bridge proc ever needs a cheaper refusal than this, the
 * change to make is a limiter keyed on something available pre-verification, not a
 * reshuffle of these three steps.
 */
export async function authorizeBlockBridgeToken(blockToken: string): Promise<BlockTokenClaims> {
  const claims = await verifyBlockToken(blockToken);
  if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });

  // Per-instance revocation. Keyed on the token's OWN `blockInstanceId` claim, never on
  // anything the caller sent. Dev and review-sandbox tokens carry a synthetic but stable
  // instance id minted for exactly this purpose, so they are covered too.
  // `claims.sub` verbatim — same reason as the REST wrapper; see `bannedSubjectKey`.
  if (await BlockRevocation.isRevoked(claims.blockInstanceId, claims.sub)) {
    // Same counter the REST wrapper emits, different `surface` label — both guards read
    // the same primitive, and a series that could not tell them apart would leave you
    // unable to say which half of the surface refused. See the counter's own comment for
    // why this mechanism had no signal at all before clawgate #618.
    recordBlockRevocationRefusal('bridge', claims.blockInstanceId);
    throw new TRPCError({ code: 'FORBIDDEN', message: 'block instance revoked' });
  }

  await assertAppBlockApproved(claims);

  return claims;
}

/**
 * The backing `app_blocks` row must still be `approved`. Resolved by the same
 * `(appId, blockId)` unique the sibling resolvers use, and from the token's claims only.
 *
 * 🔴 THE ONE EXEMPTION — a `dev` token, and it is a documented product decision, not an
 * oversight. `/api/v1/block-tokens`'s `tryDevTunnelOwnedNonApprovedMint` mints a dev
 * token carrying the app's REAL ids for an app that is deliberately NOT approved: a
 * suspended / pending / deprecated app stays runnable by its OWNER inside the owner's own
 * dev tunnel, so they can diagnose it back into review. That path is contained by its own
 * belt — ownership enforced in the query, an ACTIVE dev tunnel required, author +
 * dev-tunnel flags, self-bound `sub`, forced-SFW, dev-budget-capped, and never public.
 * Enforcing approval here would break it. The dev-token mints that have no backing row at
 * all (the pending / local-manifest / review-sandbox paths, which sign a synthetic
 * `pubreq_…` / `page_local_…` / `ephemeral-…` appBlockId) are covered by the same
 * exemption for the same reason: there is no row to be approved.
 *
 * Revocation above is NOT exempted — every one of those mints stamps a revocable instance
 * id, so a dev token is still killable.
 *
 * 🔴 THE LOOKUP IS SHARED WITH THE REST GATE; THE POLICY IS NOT. `resolveAppBlockApprovalVerdict`
 * (`block-approval.service.ts`) is the one place the row is read and `approved` is compared,
 * so the two halves of the runtime cannot drift on WHICH row or WHAT counts as approved.
 * What they do about the answer is deliberately different, and this is the divergence to
 * keep in mind before "aligning" them:
 *
 *   - `not_found` — THIS PATH ANSWERS `NOT_FOUND`. The REST gate SERVES it, because
 *     `withBlockScope` fronts public HTTP endpoints where a 404 on a healthy app is a
 *     live outage with no toggle (see that module's docblock). The bridge is a
 *     first-party postMessage surface reached only through the host page, this is its
 *     long-standing behaviour, and nothing here argued for changing it — so it did not
 *     change. If you make these agree, make it a decision, not a refactor.
 *   - a read that THROWS — propagates from here exactly as it always has, surfacing as
 *     the tRPC internal error. The REST gate converts it to a fail-closed 503 instead.
 *     That mapping lives in `resolveRestApprovalVerdict`, which this function does not
 *     call, precisely so the conversion does not reach the bridge.
 */
async function assertAppBlockApproved(claims: BlockTokenClaims): Promise<void> {
  const verdict = await resolveAppBlockApprovalVerdict(claims);
  if (verdict === 'ok' || verdict === 'dev_exempt') return;
  if (verdict === 'not_found') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'app block not found' });
  }
  if (verdict === 'not_approved') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'app block is not approved' });
  }
  // Compile-time exhaustiveness: a verdict added to the shared union fails to build here
  // until this path decides what it means, rather than inheriting "not approved" — the
  // two policies already differ on `not_found`, so a silent default is the wrong shape.
  // Runtime still fails CLOSED on an unexpected value.
  verdict satisfies never;
  throw new TRPCError({ code: 'FORBIDDEN', message: 'app block is not approved' });
}
