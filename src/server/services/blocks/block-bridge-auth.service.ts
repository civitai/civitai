import { TRPCError } from '@trpc/server';
import {
  parseSubjectUserId,
  verifyBlockToken,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import {
  recordBlockConsentMarkerUnavailable,
  recordBlockRevocationRefusal,
  recordConsentStrip,
} from '~/server/metrics/app-block-runtime.metrics';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import {
  applyRevocations,
  ConsentRevocation,
  revokedScopesForToken,
  shouldConsultMarker,
} from '~/server/services/blocks/consent-revocation.service';
import {
  resolveAppBlockApprovalVerdict,
  resolveStrictAppBlockApproval,
} from '~/server/services/blocks/block-approval.service';
import { sanitizeAppSlug } from '~/server/utils/apps-slug';

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
 * (apps/app-storage.service) and `resolveSharedContext` (apps-shared.router) — and all three
 * now do it through `resolveBlockToken` below. The bridge procs called `verifyBlockToken`
 * directly, thirteen times, and checked neither.
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
 *   2. REVOCATION — pipelined Redis GETs, so it is still the cheap check and it runs
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
 *   4. PER-SCOPE CONSENT — the viewer may have withdrawn a scope this token still carries. Its
 *      Redis read is STARTED before step 2 is awaited, so it costs no extra round trip in the
 *      ordering sense; it is listed last because that is where its verdict is CONSUMED.
 *
 * Each step fails closed. ⚠️ THE INSTANCE-revocation step still fails OPEN by construction, but
 * the PER-SCOPE consent step added below fails CLOSED — as a retryable 503, so a cache incident
 * refuses without telling the client to give up. This sentence used to say "EXCEPT revocation,
 * which fails OPEN", which is now true of only one of the two revocation legs inside
 * `BlockRevocation.isRevoked` (a Redis incident must not take the bridge down; exposure
 * is bounded by the token lifetime instead of by Redis recovery time — see that
 * service's own note). That is a property of the primitive, deliberately inherited here
 * rather than re-decided, so the REST and tRPC paths cannot drift apart on it.
 *
 * 🔴 THE PER-REQUEST COST, because this runs on EVERY bridge call including the polling ones.
 * Steps 2 and 4 issue Redis GETs; step 3 issues ONE indexed `appBlock.findUnique` (the
 * `(appId, blockId)` unique, on the replica — never the primary).
 *
 * ⚠️ THE GET COUNT IS DELIBERATELY GONE, ON THIS FILE'S OWN INSTRUCTION. It said: "if it goes
 * wrong a fourth time, delete the count rather than correct it — the ordering argument survives
 * without it." It went wrong a fourth time: the per-scope consent read (step 4) was added while
 * the sentence still said "TWO Redis GETs", and by then the middleware was citing THIS file as the
 * authority on the repeat offence, so the stale number had a second reader. Count the GETs at the
 * call sites if you need the number; the ordering argument below needs only "Redis is cheaper than
 * the DB read". The history, which is the part worth keeping:
 * introduced the split claimed the count was unchanged because it used `mGet`. That was
 * wrong: this repo's client WRAPS `mGet` into `Promise.all(keys.map(get))` to avoid
 * CROSSSLOT on the cluster, so the array path never reaches the native `MGET`. The two
 * GETs are issued in one tick and pipeline, so wall-clock is likely unchanged — but the
 * COMMAND RATE against the cache cluster is doubled on this path. Count commands, not
 * awaits.
 * The read itself is issued by the shared predicate rather than spelled here, which moves
 * where it lives and not what it costs. `pollWorkflow` is the shape to think about: a
 * running block polls it on a timer, so that pair is paid per poll, per open block
 * instance. ⚠️ A `dev` token USED TO skip the DB read; as of clawgate #571 it does not —
 * that skip was the hole, not an optimisation. Only a `reviewRunForReal` token still
 * short-circuits ahead of the query. A dev token on a real, NOT-approved row
 * additionally pays a dev-tunnel lookup (two sysRedis GETs); no other token does.
 *
 * 🔴 AND THE ORDER THIS PUT THE RATE LIMITER IN. Every `checkBlockCatalogRateLimit` call in
 * `blocks.router.ts` — in a procedure body, in a router-local helper, or in the
 * `rateLimit.check` a procedure hands `authorizeBlockBridgeViewer` — is keyed on the claims
 * this helper returns, so it runs AFTER this helper. Which procedures charge that bucket is
 * recorded by name in `RATE_LIMIT_DECISION_LEDGER`
 * (`src/server/services/__tests__/no-unlimited-block-bridge-proc.test.ts`); read the
 * population there, not from a count written here.
 *
 * So an over-limit request has already paid the Redis GET and the `findUnique` by the time
 * the limiter refuses it. That is not free, and it is not an oversight:
 *   - The limiter CANNOT precede verification. It is keyed on `claims.blockInstanceId`,
 *     which only exists once the token has been verified — there is no earlier key to
 *     throttle on, so step 1 is a hard floor beneath it.
 *   - Moving it INTO this helper, between steps 1 and 2, would apply the catalog
 *     ceiling to EVERY bridge procedure rather than the ones that opted in —
 *     `pollWorkflow` and `submitWorkflow` among them. Those are deliberately not on the
 *     catalog bucket, and a polling proc is exactly the one a shared ceiling would start
 *     refusing legitimately. That is an availability change, not a cleanup.
 *   - What the reorder would save, on requests ALREADY over the ceiling — the abusive
 *     tail, not the normal path — is this helper's Redis GET, its replica `findUnique`,
 *     AND everything the caller runs between this helper returning and the limiter. On
 *     the `authorizeBlockBridgeViewer` procedures that last part is
 *     `assertAppBlocksEnabledForTokenUser`, and it is the priciest of the three: it
 *     resolves the full `SessionUser` through
 *     `sessionClient.getSessionUserById` — a shared-cache read that falls through to an
 *     internal HTTP fetch against the auth hub on a miss — and then evaluates the
 *     App-Blocks flag (an in-process, cached Flipt eval).
 *     ⚠️ This enumeration used to omit that step while phrasing itself as closed ("what
 *     the reorder would save is one Redis GET + one replica findUnique … roughly one
 *     op") — and the GET count is per the note above, not the one in this sentence. It is not roughly one op: on a session-cache miss it is a network round-trip.
 * The conclusion is unchanged, because it never rested on the cost: what decides it is the
 * availability argument above — a shared catalog ceiling would reach `pollWorkflow`. The
 * cost line only ever said the reorder was not worth making for its own sake, and a
 * larger saving on an over-limit request does not buy a ceiling on the polling procs.
 * So the order stands. If a bridge proc ever needs a cheaper refusal than this, the
 * change to make is a limiter keyed on something available pre-verification, not a
 * reshuffle of these three steps.
 */
export async function authorizeBlockBridgeToken(blockToken: string): Promise<BlockTokenClaims> {
  const resolved = await resolveBlockToken(blockToken, {
    order: 'revocation-first',
    approval: 'bridge',
    consent: 'strip',
    metrics: 'bridge',
    slugCheck: false,
  });
  if (!resolved.ok) throw blockTokenRefusalError(resolved.refusal);
  return resolved.claims;
}

// ── THE ONE BLOCK-TOKEN RESOLVER ──────────────────────────────────────────────────────────
//
// `authorizeBlockBridgeToken` above, `resolveSharedContext` (`apps-shared.router.ts`) and
// `resolveStorageContext` (`apps/app-storage.service.ts`) used to verify a block token three
// times over, each with its own copy of the same steps. They now share this one, and their
// differences are OPTIONS — every one of them required, none defaulted — because several of
// them are deliberate and documented as such at each caller. Choosing an option is choosing
// a policy: read the caller's comment before changing what it passes.
//
// What stays at each entry point: mapping a refusal onto its own response and counters, and
// everything after the token resolves (per-op scope checks, subject hydration, flags, trust).

/** Which of the two containment checks runs first. The refusal of the first one wins. */
export type BlockTokenStepOrder = 'revocation-first' | 'approval-first';

/**
 * What the backing `app_blocks` row must say.
 *   - `bridge` — the shared predicate `resolveAppBlockApprovalVerdict` and its exemptions
 *     (run-for-real review, private run, no backing row on a dev token, owner + live dev
 *     tunnel). A missing row answers `not_found`; a tunnel-lookup fault answers `not_approved`.
 *   - `strict` — `resolveStrictAppBlockApproval`: the row must exist and be approved. No
 *     exemption at all.
 *   - `strict+reviewPreview` — `strict`, except that a token carrying the signed
 *     `reviewRunForReal` claim reads no row and resolves to `review_preview`; the caller then
 *     owns the review sandbox.
 */
export type BlockTokenApprovalPolicy = 'bridge' | 'strict' | 'strict+reviewPreview';

/**
 * Per-scope consent revocation.
 *   - `strip` — read the viewer's marker and remove every revoked scope from the claims
 *     returned; an unreadable marker refuses with `consent_unavailable`.
 *   - `exempt-only` — no marker read. Sound only for a caller that authorizes nothing but
 *     consent-exempt scopes; ledgered in
 *     `src/server/services/__tests__/no-unguarded-block-rest-token.test.ts`.
 */
export type BlockTokenConsentMode = 'strip' | 'exempt-only';

/**
 * `bridge` emits the runtime refusal/strip counters labelled `surface=bridge`; `none` emits
 * nothing (a caller with its own counter records it while mapping the refusal).
 */
export type BlockTokenMetrics = 'bridge' | 'none';

export type BlockTokenRefusal =
  | 'invalid_token'
  | 'invalid_slug'
  | 'revoked'
  | 'not_found'
  | 'not_approved'
  | 'consent_unavailable';

export interface ResolveBlockTokenOptions {
  order: BlockTokenStepOrder;
  approval: BlockTokenApprovalPolicy;
  consent: BlockTokenConsentMode;
  metrics: BlockTokenMetrics;
  /** Refuse with `invalid_slug` when `claims.blockId` is not a usable storage slug. */
  slugCheck: boolean;
}

/**
 * `admitted` — the `bridge` policy let the token through (it carries no row id).
 * `approved` — a `strict` policy read the row; `appBlockId` is the row's own id.
 * `review_preview` — `strict+reviewPreview` answered a run-for-real review token.
 */
export type BlockTokenApproval =
  | { kind: 'admitted' }
  | { kind: 'approved'; appBlockId: string }
  | { kind: 'review_preview' };

/**
 * ⚠️ DELIBERATELY NOT GENERIC over the options. The result is one plain union, so a caller
 * checks what it needs (`slug` non-null, `approval.kind`) instead of trusting a narrowing the
 * implementation could only assert — and so the function cannot be called with explicit type
 * arguments, a spelling the caller ledgers (which look for the bare call) would not see.
 */
export type BlockTokenResolution =
  | {
      ok: true;
      /** The verified claims — NARROWED by the consent strip when `consent: 'strip'`. */
      claims: BlockTokenClaims;
      /** The storage slug when `slugCheck` is on; `null` when it is off. */
      slug: string | null;
      approval: BlockTokenApproval;
    }
  | { ok: false; refusal: BlockTokenRefusal };

/**
 * Today's response for each refusal. One table, because the three entry points answer every
 * refusal with the same code and the same message; per-entry counters stay with the entries.
 */
export function blockTokenRefusalError(refusal: BlockTokenRefusal): TRPCError {
  switch (refusal) {
    case 'invalid_token':
      return new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
    case 'invalid_slug':
      return new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'block id is not a valid storage slug',
      });
    case 'revoked':
      return new TRPCError({ code: 'FORBIDDEN', message: 'block instance revoked' });
    case 'not_found':
      return new TRPCError({ code: 'NOT_FOUND', message: 'app block not found' });
    case 'not_approved':
      return new TRPCError({ code: 'FORBIDDEN', message: 'app block is not approved' });
    case 'consent_unavailable':
      // `SERVICE_UNAVAILABLE` rather than `FORBIDDEN` is the whole point — see the consent
      // step in `resolveBlockToken` — and it is the one tRPC 5xx whose message survives
      // `client-safe-error.ts`.
      return new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'permission state is temporarily unavailable — retry shortly',
      });
  }
  refusal satisfies never;
  throw new Error(`unknown block-token refusal: ${String(refusal)}`);
}

/**
 * Verify a block token and run the containment checks every token-bearing tRPC surface
 * needs, in the order and under the policies the caller names. Returns a discriminated
 * result rather than throwing for a refusal, so each caller keeps its own mapping onto
 * responses and counters. A read that THROWS (the approval row, the verifier) propagates.
 */
export async function resolveBlockToken(
  blockToken: string,
  options: ResolveBlockTokenOptions
): Promise<BlockTokenResolution> {
  const refuse = (refusal: BlockTokenRefusal): BlockTokenResolution => ({ ok: false, refusal });

  const claims = await verifyBlockToken(blockToken);
  if (!claims) return refuse('invalid_token');

  let slug: string | null = null;
  if (options.slugCheck) {
    slug = sanitizeAppSlug(claims.blockId);
    if (!slug) return refuse('invalid_slug');
  }

  // 🔴 STARTED HERE, AWAITED AFTER THE APPROVAL READ — so the consent GET pipelines with
  // `isRevoked`'s instead of adding a serial round trip. The first cut of this seam awaited it
  // last, which put a full Redis RTT on the critical path of every bridge call including the
  // timer-driven `pollWorkflow`; the REST side had already taken this shape and only one of the
  // two seams got it. Every input is available the moment the token verifies.
  //
  // Safe to leave unawaited on the refusal paths below: `ConsentRevocation.lookup` catches
  // everything and resolves to a verdict, so an early return cannot strand a rejection.
  //
  // ⚠️ `parseSubjectUserId` THROWS on a malformed `sub`, and under `strip` it runs here —
  // before revocation — exactly where the bridge has always run it. Under `exempt-only` it
  // does not run at all; those callers parse the subject themselves, later, each its own way.
  let consentLookup: ReturnType<typeof ConsentRevocation.lookup> | null = null;
  if (options.consent === 'strip') {
    const consentUserId = parseSubjectUserId(claims.sub);
    consentLookup = shouldConsultMarker({ userId: consentUserId, scopes: claims.scopes })
      ? ConsentRevocation.lookup({
          // Non-null by `shouldConsultMarker`, which returns false for a null userId.
          userId: consentUserId as number,
          appBlockId: claims.appBlockId,
        })
      : null;
  }

  // Per-instance revocation. Keyed on the token's OWN `blockInstanceId` claim, never on
  // anything the caller sent. Dev and review-sandbox tokens carry a synthetic but stable
  // instance id minted for exactly this purpose, so they are covered too.
  // `claims.sub` verbatim — same reason as the REST wrapper; see `bannedSubjectKey`.
  const isRevoked = async (): Promise<boolean> => {
    if (!(await BlockRevocation.isRevoked(claims.blockInstanceId, claims.sub))) return false;
    // Same counter the REST wrapper emits, different `surface` label — both guards read
    // the same primitive, and a series that could not tell them apart would leave you
    // unable to say which half of the surface refused. See the counter's own comment for
    // why this mechanism had no signal at all before clawgate #618.
    if (options.metrics === 'bridge') {
      recordBlockRevocationRefusal('bridge', claims.blockInstanceId);
    }
    return true;
  };

  // The order decides which refusal wins for a token that is BOTH revoked and not approved,
  // and whether the approval row is read at all for a revoked one.
  let approval: BlockTokenApproval;
  if (options.order === 'revocation-first') {
    if (await isRevoked()) return refuse('revoked');
    const outcome = await resolveApproval(claims, options.approval);
    if (outcome.kind === 'refused') return refuse(outcome.refusal);
    approval = outcome;
  } else {
    const outcome = await resolveApproval(claims, options.approval);
    if (outcome.kind === 'refused') return refuse(outcome.refusal);
    approval = outcome;
    if (await isRevoked()) return refuse('revoked');
  }
  const resolved = (out: BlockTokenClaims): BlockTokenResolution => ({
    ok: true,
    claims: out,
    slug,
    approval,
  });

  // ── PER-SCOPE CONSENT REVOCATION, ON THE BRIDGE.
  //
  // 🔴 THE BRIDGE WAS THE HALF THE FIRST CUT LEFT OPEN, AND IT HOLDS THE SCOPE THE REPO CALLS
  // THE MOST SENSITIVE. `posts:write:self` is authorized HERE — by `authorizeBlockPostRequest`'s
  // `claims.scopes.includes('posts:write:self')` — and the REST middleware, where the consent
  // marker was first wired, is never on that path. Nor are `buzz:read:self` and
  // `user:read:self`, which several bridge procs read off `claims.scopes` directly.
  //
  // 🔴 A STRIP, NOT A PER-PROC GATE, which is why one site covers all of them. Every bridge proc
  // authorizes off `claims.scopes.includes(...)`; removing the revoked members from the claims
  // this function RETURNS makes all of them honour the revoke with no enumeration to keep
  // current. The procs then refuse with their own existing "block lacks <scope> scope".
  //
  // ⚠️ KNOWN AND ACCEPTED: that message is INDISTINGUISHABLE from a never-granted scope. The
  // REST seam can say `consent_revoked` because it knows the route's required scope; this one
  // does not.
  //
  // ⚠️ AND THE COST ARGUMENT THIS COMMENT FIRST GAVE WAS FALSIFIED BY ITS OWN COMMIT. It said
  // threading a reason through the per-proc refusals is "the per-gate list the strip exists to
  // avoid" — but most of those refusals are the IDENTICAL `ai:write:budgeted` throw, and the same
  // commit mechanically rewrote every one of them to use `CONSENT_SPEND_SCOPE`. Consolidating that
  // repeated throw into one `assertBridgeScope(claims, scope)` helper would let a reason ride on
  // the claims object with no per-proc enumeration at all. So the deferral stands on effort and
  // blast radius inside a fix delta, NOT on impossibility — "this cannot be done cheaply" is
  // exactly the kind of recorded claim that stops the next person looking. The security property (the scope stops working) is
  // delivered; the message quality on this seam is not, and that is a stated limitation rather
  // than an oversight.
  if (consentLookup !== null) {
    const verdict = await consentLookup;

    // 🔴 AN UNREADABLE MARKER IS A **RETRYABLE** REFUSAL, NOT A SILENT STRIP — AND THE FIRST CUT
    // GOT THIS WRONG IN A WAY THAT BREAKS PAID WORK. On `unavailable` the strip removed every
    // revokable scope, so `pollWorkflow` threw `FORBIDDEN "block lacks ai:write:budgeted scope"`:
    // a Redis blip presented to the SDK as a permanent manifest/approval problem, whose rational
    // response is to STOP POLLING. A generation the viewer had already paid for then looked
    // permanently broken — the exact harm `block-catalog-rate-limit.ts` says never to inflict.
    // This file's own docblock also promised revocation "fails OPEN … a Redis incident must not
    // take the bridge down", which the strip had quietly made false.
    //
    // So: fail CLOSED (the request is refused) but say it is TRANSIENT, so a client retries
    // instead of giving up. `SERVICE_UNAVAILABLE` rather than `FORBIDDEN` is the whole point —
    // and it is the one tRPC 5xx whose message survives `client-safe-error.ts`.
    if (verdict.kind === 'unavailable') {
      // 🔴 EMITTED, BECAUSE THIS REFUSAL WAS OTHERWISE INVISIBLE. The throw happens before
      // `recordConsentStrip` ever runs and there is no bridge request counter at all
      // (`civitai_app_block_requests_total` is REST-only), so during a cache incident every
      // bridge call 503'd while the consent series read a flat ZERO on `surface=bridge` — and
      // that series' help text tells the operator to expect the opposite. Same defect as the
      // REST strip branch emitting nothing, one round later and one surface over.
      if (options.metrics === 'bridge') recordBlockConsentMarkerUnavailable('bridge');
      return refuse('consent_unavailable');
    }

    const revoked = revokedScopesForToken(verdict, claims.scopes);
    const narrowed = applyRevocations(claims, revoked);
    if (narrowed !== claims) {
      // `applyRevocations` returns the SAME object when nothing changed, so identity is the
      // cheap test for "did this request lose a scope". The emitter is SHARED with the REST seam
      // so the two cannot report different things under one counter name.
      if (options.metrics === 'bridge') recordConsentStrip('bridge', claims.scopes, revoked);
      return resolved(narrowed);
    }
  }

  return resolved(claims);
}

type ApprovalOutcome = BlockTokenApproval | { kind: 'refused'; refusal: BlockTokenRefusal };

/** The approval step, under the caller's policy. See `BlockTokenApprovalPolicy`. */
async function resolveApproval(
  claims: BlockTokenClaims,
  policy: BlockTokenApprovalPolicy
): Promise<ApprovalOutcome> {
  if (policy === 'bridge') return assertAppBlockApproved(claims);
  // The run-for-real review token's ONLY exemption on the storage path, taken BEFORE the row
  // is read — the review mint signs an `appId` that resolves to no row. The caller resolves
  // the disposable review schema itself; this step only says that it must.
  if (policy === 'strict+reviewPreview' && claims.reviewRunForReal === true) {
    return { kind: 'review_preview' };
  }
  const strict = await resolveStrictAppBlockApproval(claims);
  if (strict.verdict === 'approved') return { kind: 'approved', appBlockId: strict.appBlockId };
  return { kind: 'refused', refusal: strict.verdict };
}

/**
 * The backing `app_blocks` row must still be `approved`. Resolved by the same
 * `(appId, blockId)` unique the sibling resolvers use, and from the token's claims only.
 *
 * ⚠️ IT NO LONGER THROWS, despite the name: it returns the `bridge` policy's outcome and
 * `authorizeBlockBridgeToken` maps a refusal onto the same `TRPCError` it always threw. The
 * name is kept because comments elsewhere — including in modules this consolidation does
 * not touch — point readers here by it.
 *
 * 🔴 THE EXEMPTION IS NO LONGER "A `dev` TOKEN", AND THIS PARAGRAPH USED TO SAY IT WAS.
 * It justified a bare `claims.dev === true` short-circuit by listing the belts
 * `tryDevTunnelOwnedNonApprovedMint` enforces — ownership in-query, an ACTIVE dev tunnel,
 * author + dev-tunnel flags, self-bound `sub`, forced-SFW, budget cap — while this guard
 * re-checked NONE of them and keyed on the signed boolean alone. Since the `dev` claim is
 * stamped by six different mint paths, that argument covered one of them and exempted all
 * six, for the 4h dev lifetime (16× the 900s default). clawgate #571.
 *
 * The shared predicate now re-derives the two belts that actually discriminate — the
 * subject IS the app's owner, and that owner has an ACTIVE dev tunnel for the slug — so a
 * `dev:live` token whose app was approved at mint and has since been suspended is
 * REFUSED here, while the owner-dev-tunnel path and the review sandbox keep working.
 * `resolveAppBlockApprovalVerdict`'s own docblock is the argument and the population
 * table; do not restate it here, and do not re-derive the exemption from the `dev` claim.
 *
 * Revocation above is NOT exempted, and never was — every one of those mints stamps a
 * revocable instance id, so a dev token is still killable regardless of this verdict.
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
 *   - a ROW read that THROWS — propagates from here exactly as it always has, surfacing as
 *     the tRPC internal error. The REST gate converts it to a fail-closed 503 instead.
 *     That mapping lives in `resolveRestApprovalVerdict`, which this function does not
 *     call, precisely so the conversion does not reach the bridge.
 *     ⚠️ SCOPED TO THE ROW READS SINCE clawgate #571, and this line used to be blanket.
 *     The predicate's dev-tunnel re-check is wrapped at its own call, so a cache fault on
 *     THAT leg no longer reaches here as an internal error — a bridge caller gets
 *     `FORBIDDEN / 'app block is not approved'`, deliberately indistinguishable from a
 *     real refusal (telling a block that the dev-tunnel cache is down would be an
 *     infrastructure oracle), plus a throttled warn this path never used to emit.
 *
 *     🔴 WHAT SEPARATES THAT INCIDENT FROM A REAL REFUSAL IS THE `tunnel_lookup_failed`
 *     VERDICT — NOT THE LOG, and an earlier version of this note said the log. It is not
 *     readable: container logs are not collected on this deployment. But the verdict is
 *     only half a signal HERE, because **this path records no counter at all** — the
 *     verdict metric has a single call site, in `withBlockScope`. So on the bridge a
 *     tunnel-cache fault is genuinely unobservable today. That gap predates this change
 *     and is equally true of `not_approved`; closing it means giving the bridge a verdict
 *     counter, which is a metrics change rather than a guard one. Recorded here so the
 *     next reader does not infer from the REST series that this surface is covered.
 */
async function assertAppBlockApproved(claims: BlockTokenClaims): Promise<ApprovalOutcome> {
  const verdict = await resolveAppBlockApprovalVerdict(claims);
  // 🔴 `private_run_exempt` IS ADMITTED HERE, and it is the one exemption that lets a
  // NON-OWNER reach the bridge on a non-approved app. Listed explicitly rather than
  // folded into `dev_exempt` upstream so this line is where a reader looking for "who
  // can drive the bridge on a taken-down app" finds the answer. The containment is
  // NOT here — it is the mint: a self-bound `sub`, scopes clamped to the app's last
  // moderator-approved snapshot with the tip rail stripped, a per-call budget and a
  // per-(viewer, app) aggregate ceiling.
  if (verdict === 'ok' || verdict === 'dev_exempt' || verdict === 'private_run_exempt') {
    return { kind: 'admitted' };
  }
  if (verdict === 'not_found') return { kind: 'refused', refusal: 'not_found' };
  if (verdict === 'not_approved' || verdict === 'tunnel_lookup_failed') {
    // 🔴 THE SAME REFUSAL FOR BOTH, DELIBERATELY — identical code AND identical message.
    // `tunnel_lookup_failed` is a separate verdict so the REST counter can attribute it,
    // not so the caller can tell the two apart: a block that learned "the dev-tunnel cache
    // is down" rather than "not approved" would be a state oracle on infrastructure, for
    // no benefit to it. The split is for the operator, not the bearer.
    return { kind: 'refused', refusal: 'not_approved' };
  }
  // Compile-time exhaustiveness: a verdict added to the shared union fails to build here
  // until this path decides what it means, rather than inheriting "not approved" — the
  // two policies already differ on `not_found`, so a silent default is the wrong shape.
  // Runtime still fails CLOSED on an unexpected value.
  verdict satisfies never;
  return { kind: 'refused', refusal: 'not_approved' };
}
