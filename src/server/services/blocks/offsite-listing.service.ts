import { TRPCError } from '@trpc/server';
// Value import (not `import type`) — `Prisma.sql`/`Prisma.join` are runtime helpers
// used by the raw `DISTINCT ON` in `listMySubmissions`. The namespace still supplies
// every `Prisma.*` TYPE this module references.
import { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import {
  assertNoOnPlatformSurface,
  validateExternalUrl,
} from '~/server/schema/blocks/external-app.schema';
import {
  OFFSITE_CONTENT_RATINGS,
  OFFSITE_REJECTION_REASON_MAX,
  OFFSITE_REJECTION_REASON_MIN,
  type OffsiteContentRating,
  type PersistListingAssetImageInput,
  type SubmitExternalListingInput,
} from '~/server/schema/blocks/offsite-listing.schema';
import { isAppBlockOauthClientId } from '~/shared/constants/block-scope.constants';
import {
  connectScopesSubsetOfCeiling,
  validateConnectScopeJustifications,
  SENSITIVE_TOKEN_SCOPES,
  tokenScopeMaskToList,
} from '~/shared/constants/token-scope.constants';
import { assertListingAssetsComplete } from '~/server/services/blocks/app-listing-assets.service';
import { notifyAppListingOwner } from '~/server/services/blocks/app-listing-notify';
import {
  deriveContentRatingFromAssets,
  nsfwLevelFromContentRating,
} from '~/shared/constants/browsingLevel.constants';
import { isMarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import {
  newAppListingId,
  newAppListingModerationEventId,
  newAppListingPublishRequestId,
  newAppListingScreenshotId,
  newUlid,
} from '~/server/utils/app-block-ids';
import type { UpdateListingPatch } from '~/server/schema/blocks/offsite-listing.schema';

/**
 * App Store Listings (W13) — P3a OFF-SITE submission service (Design B1).
 *
 * The author-facing submit / withdraw / my-submissions surface for a pure
 * external-link off-site app, plus the mod-facing read-only review-queue lists.
 * The mirror of the on-site `publish-request.service` state machine, but over the
 * `AppListingPublishRequest` + `AppListing` tables (no bundle / build / deploy).
 *
 * DESIGN B1 (locked): `submitExternalListing` creates, in ONE transaction, a
 * DRAFT `AppListing(kind='offsite', status='draft')` PLUS a `pending`
 * `AppListingPublishRequest(kind='offsite', appListingId=<draft id>)`. The draft
 * lets the author reuse the P1 asset CRUD (owner-gated) to attach icon/cover/
 * screenshots before approval; the read path hides non-approved rows, so a draft
 * never surfaces in the store. Slug-squat protection is FREE from
 * `AppListing.slug @unique` (no pending-per-slug partial-unique migration).
 *
 * TERMINAL cleanup: `withdrawExternalRequest` DELETES the draft `AppListing`
 * (releasing the slug + cascading its screenshots). Approve/reject (PR-b) are NOT
 * in this PR.
 *
 * DARK: submit/withdraw/my-submissions are gated by `app-blocks-author` (mods +
 * app-dev-testers) at the router; the queue lists are `moderatorProcedure`.
 * Nothing renders any UI in PR-a.
 */

// ---------------------------------------------------------------------------
// Typed failure modes for withdrawExternalRequest (mirror WithdrawRequestError).
// ---------------------------------------------------------------------------

export type OffsiteRequestErrorCode =
  | 'NOT_FOUND'
  | 'NOT_OWNED'
  | 'NOT_PENDING'
  // Author tried to edit a `removed` (mod-taken-down) listing — mod-only.
  | 'FORBIDDEN'
  // Author tried to edit a `rejected` listing (no row exists) — resubmit instead.
  | 'MUST_RESUBMIT'
  // A shadow-draft revision precondition failed (not a shadow / not a draft /
  // a concurrent revision is already pending / the parent isn't approved).
  | 'INVALID_REVISION';

export class OffsiteRequestError extends Error {
  readonly code: OffsiteRequestErrorCode;
  constructor(code: OffsiteRequestErrorCode, message: string) {
    super(message);
    this.name = 'OffsiteRequestError';
    this.code = code;
  }
}

/** Friendly, deterministic slug-collision error (pre-check + P2002-race branch). */
function slugTakenError(slug: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message: `slug "${slug}" already taken` });
}

/**
 * Per-user cap on OUTSTANDING (`pending`) off-site submissions. Drafts only clear
 * on withdraw/reject (no TTL), so an unbounded submit rate would let one author
 * accrue orphan drafts + squat slugs; this bounds the standing count (the router
 * `rateLimit` bounds the submit RATE). Mods bypass the router rate-limit but are
 * still subject to this cap.
 */
export const MAX_PENDING_OFFSITE_SUBMISSIONS = 10;

// ---------------------------------------------------------------------------
// submitExternalListing (author).
// ---------------------------------------------------------------------------

export type SubmitExternalListingResult = {
  listingId: string;
  publishRequestId: string;
  slug: string;
};

/**
 * Create a DRAFT external-app off-site listing + a pending publish request in one
 * transaction (the MERGED external+connect model — every external app IS an OAuth
 * app, so this ONE path links the caller's OAuth client AND carries the optional
 * homepage URL + display metadata + reviewed scopes).
 *
 * Owner-binding (IDOR): both the `AppListing.userId` and the
 * `AppListingPublishRequest.submittedByUserId` are set from the AUTHENTICATED
 * caller (`userId`) — the input carries NO owner field, so a caller can never
 * submit on another user's behalf. The linked OAuth client is ALSO ownership-checked
 * (`loadConnectClientForListing`: exists / owned-by-caller / not an App-Block client).
 *
 * REQUIRES a `connectClientId` (the caller's own OAuth client) + a DISCLOSED
 * `requestedScopes` subset (⊆ the client's `allowedScopes` ceiling) + per-scope
 * `scopeJustifications`. `externalUrl` is now OPTIONAL (homepage / Visit link) — the
 * https re-validation runs ONLY when a URL is provided; an omitted URL stores null.
 *
 * Disclosure/review-only: `connectRequestedScopes` is STORED + reviewed; it does NOT
 * gate OAuth token issuance (the client's `allowedScopes` remains the runtime ceiling
 * via the existing consent flow).
 *
 * Slug collision: pre-checked against BOTH `AppListing.slug` (unique across both
 * kinds) AND an existing `AppBlock.block_id` (an on-site slug), then backstopped
 * inside the tx — the `AppListing.slug @unique` constraint (P2002) closes the
 * AppListing check→create race, and a PRIMARY re-read of `AppBlock.block_id`
 * closes the (constraint-less) block-id replica-lag window. Every path → the SAME
 * friendly `slug "X" already taken`.
 *
 * Abuse bounds: a per-user cap on OUTSTANDING pending submissions
 * ({@link MAX_PENDING_OFFSITE_SUBMISSIONS}) bounds standing orphan-draft accrual
 * (drafts have no TTL); the router adds a submit-RATE limit.
 */
export async function submitExternalListing(opts: {
  input: SubmitExternalListingInput;
  userId: number;
}): Promise<SubmitExternalListingResult> {
  const { input, userId } = opts;

  // Defense-in-depth: re-run the shared URL validator — but ONLY when a URL is
  // provided (externalUrl is now optional; a connect-only listing omits it). This fn
  // is exported + unit-tested directly, not only reached through the schema.
  const url = input.externalUrl != null ? validateExternalUrl(input.externalUrl) : null;
  if (url && !url.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: url.error });
  const surface = assertNoOnPlatformSurface({
    page: input.page,
    targets: input.targets,
    iframe: input.iframe,
  });
  if (!surface.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: surface.error });

  if (input.category != null && !isMarketplaceCategory(input.category)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `unknown category "${input.category}"` });
  }

  // Re-assert the author-declared maturity against the shared enum (this fn is
  // exported + unit-tested directly, so mirror the URL/surface/category re-checks
  // rather than trusting the caller). Absent → the SFW `'g'` default below.
  const contentRating = input.contentRating ?? 'g';
  if (!(OFFSITE_CONTENT_RATINGS as readonly string[]).includes(contentRating)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `unknown content rating "${contentRating}"`,
    });
  }

  // Load + gate the caller's OAuth client (exists / owned / not-app-block). The
  // listing's requested scopes are AUTO-DERIVED from the client's CURRENT
  // `allowedScopes` — the client already declares its scopes at creation, so a
  // form-supplied `input.requestedScopes` mask is IGNORED (server-authoritative
  // snapshot). This snapshots the reviewed set: a later widening of the client's
  // allowedScopes does NOT silently expand a live/approved listing (a re-submit /
  // edit re-enters review). The subset check is trivially satisfied now (the set
  // equals its own ceiling) but kept as a defensive assertion; the per-scope
  // justifications are validated against the derived set.
  const client = await loadConnectClientForListing(input.connectClientId, userId);
  const requestedScopes = client.allowedScopes;
  assertConnectScopesValid({
    requestedScopes,
    scopeJustifications: input.scopeJustifications,
    allowedScopes: client.allowedScopes,
  });

  // Per-user pending-submission cap: bound the standing orphan-draft count (drafts
  // only clear on withdraw/reject, no TTL). At/over the cap → TOO_MANY_REQUESTS.
  const pendingCount = await dbRead.appListingPublishRequest.count({
    where: { submittedByUserId: userId, kind: 'offsite', status: 'pending' },
  });
  if (pendingCount >= MAX_PENDING_OFFSITE_SUBMISSIONS) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `You have ${pendingCount} pending submissions (max ${MAX_PENDING_OFFSITE_SUBMISSIONS}). Withdraw one or wait for review before submitting another.`,
    });
  }

  const slug = input.slug;

  // Pre-check both the store slug (both kinds) and an on-site block id so the
  // author gets a friendly error rather than a raw constraint violation.
  const existingListing = await dbRead.appListing.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (existingListing) throw slugTakenError(slug);
  const existingBlock = await dbRead.appBlock.findFirst({
    where: { blockId: slug },
    select: { id: true },
  });
  if (existingBlock) throw slugTakenError(slug);

  const listingId = newAppListingId();
  const publishRequestId = newAppListingPublishRequestId();

  try {
    await dbWrite.$transaction(async (tx) => {
      // Cross-kind block_id collision — PRIMARY re-check. The AppListing.slug
      // pre-check is backstopped by its @unique (P2002), but AppBlock.block_id
      // has no such constraint against AppListing, so its replica pre-check above
      // has a lag window. Re-read from the PRIMARY inside the tx to close it —
      // same friendly `slug "X" already taken`.
      const blockOnPrimary = await tx.appBlock.findFirst({
        where: { blockId: slug },
        select: { id: true },
      });
      if (blockOnPrimary) throw slugTakenError(slug);

      await tx.appListing.create({
        data: {
          id: listingId,
          kind: 'offsite',
          status: 'draft',
          slug,
          name: input.name,
          tagline: input.tagline ?? null,
          description: input.description ?? null,
          category: input.category ?? null,
          // Author-declared, re-asserted against the enum above; defaults to SFW
          // so an omitted rating is never mature.
          contentRating,
          // OPTIONAL homepage / Visit link — canonicalized when provided, else null.
          externalUrl: url && url.ok ? url.url : null,
          // REQUIRED OAuth client link + the disclosed (review-only) scope set
          // (SERVER-DERIVED from the client's allowedScopes) + per-scope justifications.
          connectClientId: input.connectClientId,
          connectRequestedScopes: requestedScopes,
          connectScopeJustifications: input.scopeJustifications,
          // A natively-created off-site listing has no backing AppBlock.
          appBlockId: null,
          userId,
        },
      });
      await tx.appListingPublishRequest.create({
        data: {
          id: publishRequestId,
          appListingId: listingId,
          kind: 'offsite',
          slug,
          submittedByUserId: userId,
          status: 'pending',
          changelog: input.changelog ?? null,
        },
      });
    });
  } catch (err) {
    // Lost the check→create race (or a slug the pre-check missed): the
    // AppListing.slug @unique fires P2002. Collapse to the same friendly error.
    if ((err as { code?: unknown })?.code === 'P2002') throw slugTakenError(slug);
    throw err;
  }

  return { listingId, publishRequestId, slug };
}

// ---------------------------------------------------------------------------
// OAuth-client link helpers — shared by the submit + edit paths of the merged
// external-app listing flow (every external app links its own OAuth client).
// ---------------------------------------------------------------------------

/**
 * Load the caller's OWN OAuth client and assert it is eligible to back an external
 * listing: it must EXIST, be OWNED by `userId` (IDOR), and NOT be an App-Block
 * client (`isAppBlockOauthClientId` — those are managed by the App Blocks flow, not
 * hand-listed). Returns the client's `allowedScopes` ceiling. An external listing does
 * NOT require the client to be `isVerified` (decision Q4). All failures are friendly
 * TRPCErrors (parity with `submitExternalListing`'s validation style).
 */
async function loadConnectClientForListing(
  connectClientId: string,
  userId: number
): Promise<{ id: string; allowedScopes: number }> {
  // App-block clients are excluded up-front (cheap, no DB) — they are never a
  // hand-authored connect target.
  if (isAppBlockOauthClientId(connectClientId)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'App Block OAuth clients cannot be listed as connect apps',
    });
  }
  const client = await dbRead.oauthClient.findUnique({
    where: { id: connectClientId },
    select: { id: true, userId: true, allowedScopes: true },
  });
  if (!client) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'OAuth client not found' });
  }
  if (client.userId !== userId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'you can only list an OAuth client you own',
    });
  }
  return { id: client.id, allowedScopes: client.allowedScopes };
}

/**
 * Assert a requested-scope mask + its per-scope justifications are valid against the
 * client's `allowedScopes` ceiling: the mask must be a SUBSET of the ceiling
 * ((requested & ~allowed) === 0) and the justifications must satisfy the shared
 * `validateConnectScopeJustifications` (keys are valid single-bit TokenScope enum
 * keys, keys ⊆ requested, values non-empty ≤ SCOPE_JUSTIFICATION_MAX_LENGTH). Throws
 * a friendly BAD_REQUEST on the first failure. Used on submit AND on edit (defense
 * in depth — these fns are exported + unit-tested directly).
 */
function assertConnectScopesValid(opts: {
  requestedScopes: number;
  scopeJustifications: Record<string, string>;
  allowedScopes: number;
}): void {
  const { requestedScopes, scopeJustifications, allowedScopes } = opts;
  if (!connectScopesSubsetOfCeiling(requestedScopes, allowedScopes)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'requested scopes exceed the OAuth client’s allowed scopes',
    });
  }
  const errors = validateConnectScopeJustifications(requestedScopes, scopeJustifications);
  if (errors.length > 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: errors.join('; ') });
  }
}

/**
 * For an EDIT patch that touches the OAuth-connect scope disclosure (carries
 * `requestedScopes` and/or `scopeJustifications`), resolve the listing's connect
 * client and return an `effectivePatch` whose `requestedScopes` is DERIVED from the
 * client's CURRENT `allowedScopes` (server-authoritative — a form-supplied mask is
 * ignored) plus that ceiling. A non-scope patch is passed through unchanged.
 *
 * Re-asserts the caller still OWNS the client (mirrors `loadConnectClientForListing`):
 * `connectClientId` is immutable on edit, but if the client were transferred after
 * submit, the original listing owner must NOT be able to re-snapshot scopes against
 * the new owner's ceiling. Validates the justifications against the derived set.
 * Shared by `updateListing` (in-place / material-shadow) and `updateRevisionDraft`
 * (approved shadow scalar write) so both snapshot scopes identically.
 */
async function deriveScopePatch(opts: {
  connectClientId: string | null;
  patch: UpdateListingPatch;
  userId: number;
}): Promise<{ effectivePatch: UpdateListingPatch; connectAllowedScopes: number | null }> {
  const { connectClientId, patch, userId } = opts;
  const editsScopes =
    patch.requestedScopes !== undefined || patch.scopeJustifications !== undefined;
  if (!editsScopes) return { effectivePatch: patch, connectAllowedScopes: null };

  if (connectClientId == null) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'this listing has no OAuth client, so it cannot request scopes',
    });
  }
  const client = await dbRead.oauthClient.findUnique({
    where: { id: connectClientId },
    select: { userId: true, allowedScopes: true },
  });
  if (!client) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'OAuth client not found' });
  }
  if (client.userId !== userId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'you can only list an OAuth client you own',
    });
  }
  const connectAllowedScopes = client.allowedScopes;
  // SERVER-AUTHORITATIVE snapshot: the disclosed set is ALWAYS the client's CURRENT
  // allowedScopes; the form-supplied `patch.requestedScopes` is overwritten. A drift
  // from the stored snapshot is then a MATERIAL change (patchHasMaterialChange) → the
  // approved edit re-enters mod review via a shadow revision.
  const effectivePatch: UpdateListingPatch = { ...patch, requestedScopes: connectAllowedScopes };
  assertConnectScopesValid({
    requestedScopes: connectAllowedScopes,
    scopeJustifications: patch.scopeJustifications ?? {},
    allowedScopes: connectAllowedScopes,
  });
  return { effectivePatch, connectAllowedScopes };
}

// ---------------------------------------------------------------------------
// withdrawExternalRequest (author) — mirror publish-request.service withdrawRequest.
// ---------------------------------------------------------------------------

/**
 * Author-initiated, terminal withdrawal of their OWN pending off-site request.
 * Idempotent (re-withdrawing an already-withdrawn row is a no-op success). Throws
 * a typed {@link OffsiteRequestError} on a missing row, another user's row, or a
 * non-`pending` row.
 *
 * Deletes the DRAFT `AppListing` on success (B1) so the slug is released and no
 * orphan draft accrues; the delete is status-guarded (`status:'draft'`) so it can
 * never remove an approved listing.
 *
 * REVISION-AWARE (no branch needed): a pending REVISION request points at a SHADOW
 * `AppListing`, which is itself `status:'draft'`. So the status-aware
 * `closeTerminalListing` DELETES ONLY the shadow (the `draft` branch) — the LIVE
 * parent (a separate, `approved` row, never referenced by this request's
 * `appListingId`) is untouched and stays live. Withdrawing a revision therefore
 * behaves exactly like withdrawing a first-time submission, by construction. (A
 * reset-to-pending, formerly-live listing is instead transitioned to `removed`; see
 * `closeTerminalListing`.)
 *
 * CONCURRENCY (TOCTOU): the `findUnique` only CLASSIFIES; the mutation is a
 * status-guarded `updateMany({ id, status:'pending' })`, so a withdraw that read
 * `pending` can't clobber a row a concurrent approve flipped. If the guarded
 * write matches 0 rows despite the earlier pending classification, we re-read
 * from the PRIMARY and resolve: now `withdrawn` → idempotent success; now
 * `approved`/`rejected` → NOT_PENDING. Mirrors `withdrawRequest`
 * (publish-request.service.ts).
 */
export async function withdrawExternalRequest(opts: {
  publishRequestId: string;
  userId: number;
}): Promise<void> {
  const { publishRequestId, userId } = opts;

  const row = await dbRead.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, status: true, submittedByUserId: true, appListingId: true },
  });
  if (!row) {
    throw new OffsiteRequestError('NOT_FOUND', `publish request ${publishRequestId} not found`);
  }
  if (row.submittedByUserId !== userId) {
    throw new OffsiteRequestError('NOT_OWNED', 'you can only withdraw your own publish requests');
  }
  if (row.status === 'withdrawn') return;
  if (row.status !== 'pending') {
    throw new OffsiteRequestError(
      'NOT_PENDING',
      `cannot withdraw a request in status ${row.status}`
    );
  }

  // ONE transaction: status-guarded request flip + the status-aware listing close,
  // so a reset-to-pending listing's `pending → removed` transition + its audit event
  // are atomic with the withdraw (a crash can't split them, and the guarded flip means
  // only the winner closes). A first-time draft is deleted (unchanged); a formerly-live
  // reset listing is set `removed` with a `delist` event — 🔴 the pending cycle is
  // always mod-mandated, so the owner CANNOT self-restore it (a mod must relist). See
  // `closeTerminalListing`.
  const flipped = await dbWrite.$transaction(async (tx) => {
    const { count } = await tx.appListingPublishRequest.updateMany({
      where: { id: publishRequestId, status: 'pending' },
      data: { status: 'withdrawn' },
    });
    if (count === 0) return false;
    await closeTerminalListing(tx, row.appListingId, {
      actorUserId: userId,
      reason: null,
    });
    return true;
  });
  if (flipped) {
    return;
  }

  // Raced: re-read from the PRIMARY (a replica read could be lag-stale and still
  // report `pending`) to decide the authoritative outcome.
  const after = await dbWrite.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { status: true },
  });
  if (!after || after.status === 'withdrawn') {
    // Raced into withdrawn (or vanished) → idempotent success. The concurrent
    // withdraw owns the draft cleanup, so we do NOT re-delete here.
    return;
  }
  // Raced into approved/rejected → the not-pending guarantee, now true under
  // concurrency.
  throw new OffsiteRequestError(
    'NOT_PENDING',
    `cannot withdraw a request in status ${after.status}`
  );
}

export type CloseTerminalListingOutcome = 'deleted' | 'removed' | 'none';

/**
 * Terminal-close the `AppListing` backing a rejected/withdrawn request, in the
 * caller's transaction — status-AWARE so a reset-to-pending (formerly-LIVE) listing
 * is never hard-deleted nor stranded in `pending`:
 *
 *   - `draft`   → DELETE (releases the slug; cascades screenshots). Covers a FIRST-TIME
 *                 submission AND a SHADOW revision (shadows are always `draft`) — both
 *                 keep the pre-W13 behaviour exactly.
 *   - `pending` → a reset-to-pending, FORMERLY-LIVE listing (real assets/reports/
 *                 history). Do NOT delete + do NOT leave stranded: transition it to
 *                 `removed` (recoverable via mod `relistListing`) AND write a `delist`
 *                 `AppListingModerationEvent`. 🔴 The action is UNCONDITIONALLY `delist`
 *                 (Fix #1 authz), for BOTH the reject and the withdraw caller: a
 *                 formerly-live `pending` listing is ALWAYS mod-mandated (only the mod
 *                 reset fns set `pending` on a live listing), so an owner who withdraws
 *                 the re-review must NOT be able to self-restore — `delist` makes the
 *                 last event a takedown, so `republishOwnListing` FORBIDS the owner and
 *                 a mod must relist. (This replaced a most-recent-event probe that an
 *                 intervening report-resolve/dismiss event could defeat.)
 *   - anything else (approved/removed) → no-op (a terminal request never targets one;
 *                 guarded defensively).
 *
 * The `pending → removed` flip is status-guarded (TOCTOU): a 0-count (raced) → `none`
 * with no event. Accepts a tx client so the flip + event are atomic with the caller's
 * request-status flip. No-op when the request had no linked listing.
 */
async function closeTerminalListing(
  client: Pick<typeof dbWrite, 'appListing' | 'appListingModerationEvent'>,
  appListingId: string | null,
  // `action` is no longer a caller input — the pending branch ALWAYS writes `delist`
  // (Fix #1). Callers pass only the actor + reason.
  event: { actorUserId: number; reason: string | null }
): Promise<CloseTerminalListingOutcome> {
  if (!appListingId) return 'none';
  const listing = await client.appListing.findUnique({
    where: { id: appListingId },
    select: { status: true, slug: true },
  });
  if (!listing) return 'none';

  if (listing.status === 'draft') {
    // First-time draft OR a shadow revision — delete as before (status-guarded so it
    // can never remove an approved/removed row).
    await client.appListing.deleteMany({ where: { id: appListingId, status: 'draft' } });
    return 'deleted';
  }

  if (listing.status === 'pending') {
    // Reset-to-pending, formerly-live listing → transition to `removed` (recoverable),
    // never delete/strand. Status-guarded flip; on a raced 0-count, do nothing.
    const flipped = await client.appListing.updateMany({
      where: { id: appListingId, status: 'pending' },
      data: { status: 'removed' },
    });
    if (flipped.count === 0) return 'none';

    // 🔴 AUTHZ (Fix #1) — DETERMINISTIC: a formerly-live `pending` off-site listing is
    // ALWAYS mod-mandated, so the close ALWAYS writes a `delist` event (never
    // `owner-unpublish`), regardless of which caller (reject or withdraw) reached here.
    //
    // WHY the pending branch is unconditionally mod-mandated: the ONLY writers of
    // `status='pending'` for a formerly-LIVE listing are the two mod reset fns
    // (`resetListingToPending` / `resetOnsiteListingToPending`). A first-time submission
    // is `draft` (handled by the branch above → deleted); a revision is a `draft`
    // shadow (also the `draft` branch); owner unpublish/republish only move
    // approved↔removed and never touch `pending`. So reaching here means a mod bounced
    // a live listing back to review — an owner withdrawing that re-review must NOT be
    // able to self-restore the pre-reset content with no re-review.
    //
    // This REPLACES an earlier most-recent-event probe (`last event == reset-to-pending
    // ? delist : owner-unpublish`), which was BOTH exploitable and unsafe-by-default: an
    // intervening report `report-resolve`/`report-dismiss` event (written UNGUARDED on
    // the same listing by `closeReport`) shifted the newest event off `reset-to-pending`
    // → the probe fell through to `owner-unpublish` → the owner could republish the
    // pre-reset content live. Writing `delist` unconditionally closes that hole; the
    // republish guard (last event must be `owner-unpublish`) then correctly FORBIDS the
    // owner and a mod must relist. `event.action` is now irrelevant in this branch.
    await client.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId,
        slug: listing.slug,
        action: 'delist',
        actorUserId: event.actorUserId,
        reason: event.reason,
        before: { status: 'pending' },
        after: { status: 'removed' },
      },
    });
    return 'removed';
  }

  return 'none';
}

// ---------------------------------------------------------------------------
// updateListing / beginListingRevision / submitListingRevision (author) —
// edit an off-site listing WITHOUT withdrawing it (shadow-draft revision).
//
// State machine (on the LIVE listing's status):
//   draft | pending  → edit IN PLACE (no re-review). A pending listing's existing
//                      pending request keeps reviewing the now-updated row.
//   approved         → the live version STAYS LIVE. A TRIVIAL-only edit (tagline/
//                      description/category/contentRating) applies in place; any
//                      MATERIAL change (externalUrl/name — or assets, edited
//                      separately) is staged on a hidden DRAFT clone (the shadow)
//                      and applied to the parent only on mod re-approve.
//   rejected         → no row exists (reject deletes it) → MUST_RESUBMIT.
//   removed          → mod-only takedown → FORBIDDEN for an author edit.
// ---------------------------------------------------------------------------

/**
 * MATERIAL scalar fields — a change to ANY of these on an approved listing forces
 * re-review (routes through a shadow revision, not an in-place edit).
 *
 * `contentRating` is material because it drives the public SFW filter
 * (`content_rating NOT IN ('r','x')`): letting an approved author lower an 'x'/'r'
 * listing to 'g' in place with no mod re-review would surface a still-mature
 * listing to SFW users. `externalUrl`/`name` are the listing's identity/destination.
 * `tagline`/`description`/`category` stay trivial — quick copy edits are intended
 * and are delistable if abused.
 */
const MATERIAL_PATCH_FIELDS = ['externalUrl', 'name', 'contentRating'] as const;

/**
 * Validate + normalize an update patch (shared by the in-place + shadow paths).
 * Re-runs the shared URL / category / contentRating validators (this fn is
 * exported + unit-tested directly, so it can't trust the schema boundary) and
 * returns a Prisma `data` object carrying ONLY the fields the patch actually set
 * (an omitted field is left untouched; an explicit `null` clears a nullable one).
 * `externalUrl` is normalized to the validator's canonical form.
 */
export function buildListingPatchData(
  patch: UpdateListingPatch,
  opts?: {
    /**
     * The connect client's `allowedScopes` ceiling (from the listing's
     * `connectClientId`). REQUIRED when the patch touches `requestedScopes` /
     * `scopeJustifications` — the caller (`updateListing`) resolves it once and
     * passes it in. `null` means the listing has no connect client, so a scope edit
     * is rejected.
     */
    connectAllowedScopes?: number | null;
  }
): Prisma.AppListingUpdateInput {
  const data: Prisma.AppListingUpdateInput = {};
  if (patch.externalUrl !== undefined) {
    const url = validateExternalUrl(patch.externalUrl);
    if (!url.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: url.error });
    data.externalUrl = url.url;
  }
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.tagline !== undefined) data.tagline = patch.tagline;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.category !== undefined) {
    if (patch.category != null && !isMarketplaceCategory(patch.category)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `unknown category "${patch.category}"` });
    }
    data.category = patch.category;
  }
  if (patch.contentRating !== undefined) {
    if (!(OFFSITE_CONTENT_RATINGS as readonly string[]).includes(patch.contentRating)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `unknown content rating "${patch.contentRating}"`,
      });
    }
    data.contentRating = patch.contentRating;
  }
  // OAuth-connect scope disclosure edit. `requestedScopes` + `scopeJustifications`
  // travel as a pair: justifications validate against the requested mask, so a
  // justification-only edit (no mask) is rejected. Re-run the subset + justification
  // checks against the listing's client ceiling (defense in depth — this fn is
  // exported + unit-tested directly).
  if (patch.requestedScopes !== undefined || patch.scopeJustifications !== undefined) {
    if (patch.requestedScopes === undefined) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'requestedScopes is required when editing scope justifications',
      });
    }
    if (opts?.connectAllowedScopes == null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'this listing has no OAuth client, so it cannot request scopes',
      });
    }
    assertConnectScopesValid({
      requestedScopes: patch.requestedScopes,
      scopeJustifications: patch.scopeJustifications ?? {},
      allowedScopes: opts.connectAllowedScopes,
    });
    data.connectRequestedScopes = patch.requestedScopes;
    data.connectScopeJustifications = patch.scopeJustifications ?? {};
  }
  return data;
}

/**
 * True iff the patch changes a MATERIAL field (see MATERIAL_PATCH_FIELDS) to a
 * value DIFFERENT from the live listing. Iterates the material-field list so the
 * set is edited in ONE place; `externalUrl` compares against the validator's
 * canonical form, the rest are plain scalar inequality.
 */
function patchHasMaterialChange(
  patch: UpdateListingPatch,
  live: {
    externalUrl: string | null;
    name: string;
    contentRating: string | null;
    connectRequestedScopes: number | null;
  }
): boolean {
  for (const field of MATERIAL_PATCH_FIELDS) {
    const patched = patch[field];
    if (patched === undefined) continue;
    if (field === 'externalUrl') {
      const url = validateExternalUrl(patched);
      // An invalid URL is a material change (it will be rejected downstream, but
      // it is not "unchanged").
      if (!url.ok || url.url !== live.externalUrl) return true;
      continue;
    }
    // name / contentRating: plain scalar inequality vs the live value.
    if (patched !== live[field]) return true;
  }
  // A change to the DISCLOSED OAuth scope subset is material — the mod approved a
  // specific set of scopes, so a new set must re-enter review (the shadow carries the
  // updated mask + justifications, re-validated in buildListingPatchData).
  if (
    patch.requestedScopes !== undefined &&
    patch.requestedScopes !== (live.connectRequestedScopes ?? 0)
  ) {
    return true;
  }
  return false;
}

export type UpdateListingResult = {
  /** The LIVE listing id (unchanged — a shadow never surfaces its own id here). */
  listingId: string;
  /** The listing's status after the edit (unchanged for a live listing). */
  status: string;
  /** True when the edit was staged for mod re-review (approved-material path). */
  requiresReview: boolean;
  /** The shadow id created/reused for a staged revision, else null. */
  shadowId: string | null;
};

/**
 * A minimal listing projection used by the author edit paths (owner-check + state).
 */
type EditableListing = {
  id: string;
  kind: string;
  slug: string;
  status: string;
  userId: number;
  revisionOfId: string | null;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  contentRating: string | null;
  externalUrl: string | null;
  connectClientId: string | null;
  connectRequestedScopes: number | null;
  connectScopeJustifications: Prisma.JsonValue | null;
  iconId: number | null;
  coverId: number | null;
};

const editableListingSelect = {
  id: true,
  kind: true,
  slug: true,
  status: true,
  userId: true,
  revisionOfId: true,
  name: true,
  tagline: true,
  description: true,
  category: true,
  contentRating: true,
  externalUrl: true,
  connectClientId: true,
  connectRequestedScopes: true,
  connectScopeJustifications: true,
  iconId: true,
  coverId: true,
} as const;

/** Load a listing and assert the caller is its OWNER (strict — no mod override on the author edit path). */
async function loadOwnedEditableListing(
  listingId: string,
  userId: number
): Promise<EditableListing> {
  const listing = (await dbRead.appListing.findUnique({
    where: { id: listingId },
    select: editableListingSelect,
  })) as EditableListing | null;
  if (!listing) {
    throw new OffsiteRequestError('NOT_FOUND', `listing ${listingId} not found`);
  }
  if (listing.userId !== userId) {
    throw new OffsiteRequestError('NOT_OWNED', 'you can only edit your own listings');
  }
  return listing;
}

/**
 * AUTHOR: edit an off-site listing without withdrawing it. State-aware (see the
 * section header). Owner-bound (non-owner → NOT_OWNED/FORBIDDEN). Returns the
 * LIVE listing id + whether the edit was staged for re-review.
 */
export async function updateListing(opts: {
  listingId: string;
  patch: UpdateListingPatch;
  userId: number;
}): Promise<UpdateListingResult> {
  const { listingId, patch, userId } = opts;
  const listing = await loadOwnedEditableListing(listingId, userId);

  // A shadow is an internal draft — never editable via this top-level path (its
  // scalars are edited by updateListing's approved-material branch / asset procs).
  if (listing.revisionOfId != null) {
    throw new OffsiteRequestError(
      'INVALID_REVISION',
      'this listing is an internal revision draft and cannot be edited directly'
    );
  }

  // If the patch touches the disclosed OAuth scopes, resolve the client's ceiling
  // and DERIVE the requested-scope snapshot from it (server-authoritative — a
  // form-supplied mask is ignored). Validates UP-FRONT (before any shadow is opened)
  // so an invalid justification set never leaves an orphan shadow draft. A scope edit
  // on a listing with no connect client → BAD_REQUEST.
  const { effectivePatch, connectAllowedScopes } = await deriveScopePatch({
    connectClientId: listing.connectClientId,
    patch,
    userId,
  });
  const patchOpts = { connectAllowedScopes };

  switch (listing.status) {
    case 'removed':
      throw new OffsiteRequestError(
        'FORBIDDEN',
        'this listing has been removed by a moderator and can no longer be edited'
      );
    case 'rejected':
      // reject() deletes the draft, so this row usually doesn't exist (→ NOT_FOUND
      // above). If a rejected row somehow persists, steer the caller to resubmit.
      throw new OffsiteRequestError(
        'MUST_RESUBMIT',
        'this listing was rejected; submit a new listing instead of editing it'
      );
    case 'draft':
    case 'pending': {
      // Edit IN PLACE — no re-review. A pending listing's existing pending request
      // keeps reviewing the now-updated row (it references the row, not a snapshot).
      const data = buildListingPatchData(effectivePatch, patchOpts);
      await dbWrite.appListing.update({ where: { id: listingId }, data });
      return { listingId, status: listing.status, requiresReview: false, shadowId: null };
    }
    case 'approved': {
      const material = patchHasMaterialChange(effectivePatch, {
        externalUrl: listing.externalUrl,
        name: listing.name,
        contentRating: listing.contentRating,
        connectRequestedScopes: listing.connectRequestedScopes,
      });
      if (!material) {
        // TRIVIAL-only edit → apply to the LIVE row in place (no re-review). Any
        // material key present is byte-identical to the live value (material ===
        // false), so writing it is a harmless no-op.
        const data = buildListingPatchData(effectivePatch, patchOpts);
        await dbWrite.appListing.update({ where: { id: listingId }, data });
        return { listingId, status: listing.status, requiresReview: false, shadowId: null };
      }
      // MATERIAL change → stage on a shadow. The parent stays LIVE untouched; the
      // FULL patch (material + trivial) is written to the shadow. Assets are edited
      // separately against the shadow id, then submitListingRevision re-reviews it.
      const { shadowId } = await beginListingRevision({ listingId, userId });
      const data = buildListingPatchData(effectivePatch, patchOpts);
      await dbWrite.appListing.update({ where: { id: shadowId }, data });
      return { listingId, status: listing.status, requiresReview: true, shadowId };
    }
    default:
      throw new OffsiteRequestError(
        'INVALID_REVISION',
        `cannot edit a listing in status ${listing.status}`
      );
  }
}

export type BeginListingRevisionResult = { shadowId: string; created: boolean };

/**
 * AUTHOR: create (or re-open) a shadow-draft revision of an APPROVED listing.
 *
 * Idempotent: if a shadow (an AppListing with revisionOfId === parentId) already
 * exists it is returned as-is (so re-entering the edit flow doesn't clone a second
 * shadow). Otherwise the approved parent is cloned into a hidden DRAFT AppListing
 * — scalars copied, appBlockId NULL, a synthetic unique slug (`rev-<ulid>`, never
 * public), revisionOfId = parentId, owned by the parent's owner — and each of the
 * parent's screenshots is copied (imageId/order/caption). The author then edits
 * the shadow's ASSETS via the EXISTING setIcon/setCover/addScreenshot procs by
 * passing the shadow id (no new asset procs).
 */
export async function beginListingRevision(opts: {
  listingId: string;
  userId: number;
}): Promise<BeginListingRevisionResult> {
  const { listingId, userId } = opts;
  const parent = await loadOwnedEditableListing(listingId, userId);

  if (parent.revisionOfId != null) {
    throw new OffsiteRequestError(
      'INVALID_REVISION',
      'cannot open a revision of a revision draft'
    );
  }
  if (parent.status !== 'approved') {
    throw new OffsiteRequestError(
      'INVALID_REVISION',
      `only an approved listing can be revised (status is ${parent.status})`
    );
  }

  // Idempotent reuse: a parent has at most one in-flight shadow.
  const existing = await dbRead.appListing.findFirst({
    where: { revisionOfId: listingId },
    select: { id: true },
  });
  if (existing) return { shadowId: existing.id, created: false };

  const shadowId = newAppListingId();
  // Synthetic, globally-unique slug: the shadow is never public, but slug is
  // @unique, so it must not collide with the parent or any other listing.
  const shadowSlug = `rev-${newUlid()}`;

  try {
    await dbWrite.$transaction(async (tx) => {
      // Re-check inside the tx (primary) that no shadow was created concurrently.
      const race = await tx.appListing.findFirst({
        where: { revisionOfId: listingId },
        select: { id: true },
      });
      if (race) return; // lost the race — the other caller's shadow stands.
      await tx.appListing.create({
        data: {
          id: shadowId,
          kind: parent.kind,
          status: 'draft',
          slug: shadowSlug,
          revisionOfId: listingId,
          name: parent.name,
          tagline: parent.tagline,
          description: parent.description,
          category: parent.category,
          contentRating: parent.contentRating,
          externalUrl: parent.externalUrl,
          connectClientId: parent.connectClientId,
          // Carry the disclosed OAuth scope subset + justifications onto the shadow so
          // a revision that DOESN'T touch scopes preserves them (and one that does
          // overwrites them via buildListingPatchData).
          connectRequestedScopes: parent.connectRequestedScopes,
          connectScopeJustifications:
            parent.connectScopeJustifications === null
              ? Prisma.DbNull
              : (parent.connectScopeJustifications as Prisma.InputJsonValue),
          iconId: parent.iconId,
          coverId: parent.coverId,
          // A shadow has NO backing AppBlock (appBlockId is @unique — it stays on
          // the parent) and no publish request yet (submitListingRevision adds it).
          appBlockId: null,
          userId: parent.userId,
        },
      });
      const shots = await tx.appListingScreenshot.findMany({
        where: { appListingId: listingId },
        select: { imageId: true, order: true, caption: true },
        orderBy: { order: 'asc' },
      });
      if (shots.length > 0) {
        await tx.appListingScreenshot.createMany({
          data: shots.map((s: { imageId: number | null; order: number; caption: string | null }) => ({
            id: newAppListingScreenshotId(),
            appListingId: shadowId,
            imageId: s.imageId,
            order: s.order,
            caption: s.caption,
          })),
        });
      }
    });
  } catch (err) {
    // A concurrent creator committed its shadow between our in-tx read-check and
    // our INSERT → the partial-UNIQUE index on revision_of_id (WHERE NOT NULL)
    // rejects the duplicate with P2002. Collapse to the idempotent-reuse path
    // (the winner re-read below returns the standing shadow) instead of
    // surfacing the race as an error. Duck-type on `code` (the Prisma error
    // class isn't reliably constructible with a stale client). Re-throw anything
    // else.
    const code = (err as { code?: unknown })?.code;
    if (code !== 'P2002') throw err;
  }

  // If we lost the concurrent-create race (in-tx read-check OR a P2002 on
  // insert) the row we minted was never written; re-read the winning shadow so
  // the caller always gets a live shadow id.
  const winner = await dbWrite.appListing.findFirst({
    where: { revisionOfId: listingId },
    select: { id: true },
  });
  if (!winner) {
    throw new OffsiteRequestError('INVALID_REVISION', 'failed to open a revision draft');
  }
  return { shadowId: winner.id, created: winner.id === shadowId };
}

export type SubmitListingRevisionResult = {
  publishRequestId: string;
  shadowId: string;
  /** The PUBLIC parent slug denormalized onto the review-queue request. */
  slug: string;
};

/**
 * AUTHOR: submit a prepared shadow-draft revision for mod re-approval. Asserts the
 * shadow is a draft revision (revisionOfId set), asset-complete, and URL-valid,
 * then creates a pending AppListingPublishRequest pointing at the SHADOW but
 * carrying the PUBLIC PARENT slug (so the queue reads the live slug). Idempotent /
 * concurrency-guarded: a shadow that already has a pending request returns it
 * rather than creating a second concurrent pending revision.
 */
export async function submitListingRevision(opts: {
  shadowId: string;
  userId: number;
  changelog?: string | null;
}): Promise<SubmitListingRevisionResult> {
  const { shadowId, userId } = opts;
  const changelog = opts.changelog ?? null;

  const shadow = (await dbRead.appListing.findUnique({
    where: { id: shadowId },
    select: {
      id: true,
      kind: true,
      status: true,
      userId: true,
      revisionOfId: true,
      externalUrl: true,
      iconId: true,
      coverId: true,
      revisionOf: { select: { slug: true, status: true } },
    },
  })) as
    | {
        id: string;
        kind: string;
        status: string;
        userId: number;
        revisionOfId: string | null;
        externalUrl: string | null;
        iconId: number | null;
        coverId: number | null;
        revisionOf: { slug: string; status: string } | null;
      }
    | null;

  if (!shadow) {
    throw new OffsiteRequestError('NOT_FOUND', `revision draft ${shadowId} not found`);
  }
  if (shadow.userId !== userId) {
    throw new OffsiteRequestError('NOT_OWNED', 'you can only submit your own revision');
  }
  if (shadow.revisionOfId == null || !shadow.revisionOf) {
    throw new OffsiteRequestError('INVALID_REVISION', 'this listing is not a revision draft');
  }
  if (shadow.status !== 'draft') {
    throw new OffsiteRequestError(
      'INVALID_REVISION',
      `a revision can only be submitted from draft (status is ${shadow.status})`
    );
  }

  // Asset-completeness (authoritative on the primary — the asset mutators write to
  // dbWrite, so a replica count could be stale-complete under lag) + URL re-validate.
  const screenshotCount = await dbWrite.appListingScreenshot.count({
    where: { appListingId: shadowId, imageId: { not: null } },
  });
  assertListingAssetsComplete({
    iconId: shadow.iconId,
    coverId: shadow.coverId,
    screenshotCount,
  });
  // Validate the stored externalUrl ONLY WHEN present — it's OPTIONAL in the merged
  // model (a connect-only listing carries `externalUrl: null`). Gating this
  // unconditionally made a no-homepage external app UN-REVISABLE: its material-edit
  // shadow carries a null URL and `validateExternalUrl(null)` returns `{ok:false}`,
  // so submitting the revision threw. Mirrors the submit / first-time-approve /
  // revision-approve gates. A provided-but-invalid URL still blocks.
  // Validate the stored externalUrl ONLY WHEN present — it's OPTIONAL in the merged
  // model (a connect-only listing carries `externalUrl: null`). Gating this
  // unconditionally made a no-homepage external app UN-REVISABLE: its material-edit
  // shadow carries a null URL and `validateExternalUrl(null)` returns `{ok:false}`,
  // so submitting the revision threw. Mirrors the submit / first-time-approve /
  // revision-approve gates. A provided-but-invalid URL still blocks.
  if (shadow.externalUrl != null) {
    const url = validateExternalUrl(shadow.externalUrl);
    if (!url.ok) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `stored externalUrl is invalid and cannot be submitted: ${url.error}`,
      });
    }
  }

  // Guard a second concurrent pending revision: one open request per shadow.
  const openRequest = await dbRead.appListingPublishRequest.findFirst({
    where: { appListingId: shadowId, status: 'pending' },
    select: { id: true, slug: true },
  });
  if (openRequest) {
    return { publishRequestId: openRequest.id, shadowId, slug: openRequest.slug };
  }

  const publishRequestId = newAppListingPublishRequestId();
  await dbWrite.appListingPublishRequest.create({
    data: {
      id: publishRequestId,
      appListingId: shadowId,
      kind: shadow.kind,
      // Denormalize the PUBLIC parent slug so the mod queue reads the live slug,
      // not the synthetic rev-<ulid>.
      slug: shadow.revisionOf.slug,
      submittedByUserId: userId,
      status: 'pending',
      changelog,
    },
  });
  return { publishRequestId, shadowId, slug: shadow.revisionOf.slug };
}

// ---------------------------------------------------------------------------
// getMyListingForEdit / updateRevisionDraft (author) — the DUAL-MODE edit wizard
// glue. `getMyListingForEdit` is the owner-gated PREFILL read for
// `/apps/submit?edit=<listingId>` (scalars + current assets + status +
// hasPendingRevision, resolving an approved parent's in-progress shadow so a
// resumed revision prefills from the shadow's edited state). `updateRevisionDraft`
// is the symmetric scalar-write to an owned draft shadow (the asset procs already
// write to a shadow; this is the "direct once shadow exists" scalar path so the
// approved flow can put ALL scalar edits on the shadow before submitting it for
// re-review — never leaving a trivial edit on the live parent that the shadow
// would revert on approval).
// ---------------------------------------------------------------------------

export type ListingEditScalars = {
  name: string;
  tagline: string | null;
  description: string | null;
  category: string | null;
  contentRating: string | null;
  externalUrl: string | null;
};

export type ListingEditAsset = { imageId: number | null; url: string | null };
export type ListingEditScreenshot = {
  id: string;
  imageId: number | null;
  url: string | null;
  caption: string | null;
  order: number;
};

export type GetMyListingForEditResult = {
  /** The LIVE (parent) listing id — always the caller's edit target identity. */
  parentId: string;
  /** The parent's PUBLIC slug — immutable in edit mode (identity/URL). */
  slug: string;
  /** The parent's status (draft | pending | approved). */
  status: string;
  /** True when an in-flight shadow revision is already under review. */
  hasPendingRevision: boolean;
  /**
   * The existing shadow id for an approved parent whose revision is in progress
   * (else null). The client still calls `beginListingRevision` on entering edit
   * for an approved listing (idempotent — returns this same shadow), so this is
   * only a hint that the prefill below came from the shadow, not the parent.
   */
  shadowId: string | null;
  /**
   * Prefill scalars from the EFFECTIVE source: the in-progress shadow when one
   * exists (resume the revision), else the parent. `slug` above always stays the
   * public parent slug regardless.
   */
  scalars: ListingEditScalars;
  /** Prefill assets (icon/cover/screenshots) from the effective source, edge-resolved. */
  assets: {
    icon: ListingEditAsset;
    cover: ListingEditAsset;
    screenshots: ListingEditScreenshot[];
  };
  /** The linked OAuth client id (null for a non-connect listing — none in the merged model). */
  connectClientId: string | null;
  /**
   * The client's CURRENT `allowedScopes` (null when no client / not found). This IS
   * the derived requested-scope set the edit form displays read-only + submits — the
   * server re-snapshots `requestedScopes` from it on save.
   */
  connectAllowedScopes: number | null;
  /** The STORED requested-scope snapshot on the effective row (for drift detection). */
  connectRequestedScopes: number | null;
  /** The STORED per-scope justifications (enum-key → rationale) on the effective row. */
  connectScopeJustifications: Record<string, string> | null;
};

/** Load a listing's scalars + current assets (edge-resolved URLs) + connect scope
 *  snapshot for edit prefill. */
async function loadListingEditView(listingId: string): Promise<{
  scalars: ListingEditScalars;
  assets: GetMyListingForEditResult['assets'];
  connectRequestedScopes: number | null;
  connectScopeJustifications: Record<string, string> | null;
}> {
  const { getEdgeUrl } = await import('~/client-utils/cf-images-utils');
  const row = (await dbRead.appListing.findUnique({
    where: { id: listingId },
    select: {
      name: true,
      tagline: true,
      description: true,
      category: true,
      contentRating: true,
      externalUrl: true,
      connectRequestedScopes: true,
      connectScopeJustifications: true,
      iconId: true,
      coverId: true,
      icon: { select: { url: true } },
      cover: { select: { url: true } },
      screenshots: {
        select: {
          id: true,
          imageId: true,
          order: true,
          caption: true,
          image: { select: { url: true } },
        },
        orderBy: { order: 'asc' },
      },
    },
  })) as {
    name: string;
    tagline: string | null;
    description: string | null;
    category: string | null;
    contentRating: string | null;
    externalUrl: string | null;
    connectRequestedScopes: number | null;
    connectScopeJustifications: Prisma.JsonValue | null;
    iconId: number | null;
    coverId: number | null;
    icon: { url: string | null } | null;
    cover: { url: string | null } | null;
    screenshots: {
      id: string;
      imageId: number | null;
      order: number;
      caption: string | null;
      image: { url: string | null } | null;
    }[];
  } | null;
  if (!row) {
    throw new OffsiteRequestError('NOT_FOUND', `listing ${listingId} not found`);
  }
  return {
    scalars: {
      name: row.name,
      tagline: row.tagline,
      description: row.description,
      category: row.category,
      contentRating: row.contentRating,
      externalUrl: row.externalUrl,
    },
    connectRequestedScopes: row.connectRequestedScopes ?? null,
    connectScopeJustifications:
      (row.connectScopeJustifications as Record<string, string> | null) ?? null,
    assets: {
      icon: {
        imageId: row.iconId,
        url: row.icon?.url ? getEdgeUrl(row.icon.url, { width: 256 }) : null,
      },
      cover: {
        imageId: row.coverId,
        url: row.cover?.url ? getEdgeUrl(row.cover.url, { width: 1200 }) : null,
      },
      screenshots: row.screenshots.map((s) => ({
        id: s.id,
        imageId: s.imageId,
        url: s.image?.url ? getEdgeUrl(s.image.url, { width: 1200 }) : null,
        caption: s.caption,
        order: s.order,
      })),
    },
  };
}

/**
 * AUTHOR: owner-gated prefill read for the dual-mode edit wizard. Loads the
 * caller's OWN listing (NOT_OWNED / NOT_FOUND), asserts it is EDITABLE
 * (draft/pending/approved; rejected → MUST_RESUBMIT, removed → FORBIDDEN,
 * an internal shadow → INVALID_REVISION), and returns the prefill scalars +
 * current assets from the EFFECTIVE source: an approved parent's in-progress
 * shadow when one exists (so a resumed revision prefills its edited state), else
 * the listing itself. `slug` + `status` + `parentId` always describe the live
 * parent; `shadowId` hints whether the prefill came from a shadow.
 */
export async function getMyListingForEdit(opts: {
  listingId: string;
  userId: number;
}): Promise<GetMyListingForEditResult> {
  const { listingId, userId } = opts;
  const listing = await loadOwnedEditableListing(listingId, userId);

  if (listing.revisionOfId != null) {
    throw new OffsiteRequestError(
      'INVALID_REVISION',
      'this listing is an internal revision draft and cannot be edited directly'
    );
  }
  switch (listing.status) {
    case 'removed':
      throw new OffsiteRequestError(
        'FORBIDDEN',
        'this listing has been removed by a moderator and can no longer be edited'
      );
    case 'rejected':
      throw new OffsiteRequestError(
        'MUST_RESUBMIT',
        'this listing was rejected; submit a new listing instead of editing it'
      );
    case 'draft':
    case 'pending':
    case 'approved':
      break;
    default:
      throw new OffsiteRequestError(
        'INVALID_REVISION',
        `cannot edit a listing in status ${listing.status}`
      );
  }

  // For an approved parent, resolve the shadow SERVER-SIDE (idempotent: reuses an
  // in-flight shadow, else clones the parent's scalars+assets into a fresh one) and
  // prefill from IT, returning `effectiveId = shadowId` + the SHADOW's asset rows.
  //
  // 🔴 SECURITY (do not weaken): the edit UI mutates the EFFECTIVE listing's asset
  // ROWS (add/remove screenshot, set icon/cover). For an approved listing those MUST
  // be the shadow's rows — NEVER the live parent's. If the prefill returned the
  // parent's `AppListingScreenshot` ids (as it did when the shadow was only begun
  // client-side after mount), a "remove screenshot" on the first edit would delete
  // the row from the LIVE served listing, bypassing moderator review. Resolving the
  // shadow here — before any row id reaches the client — closes that window. (This
  // is a query that performs an idempotent write; acceptable — begin is safe to
  // repeat.) A pending revision REQUEST (not mere shadow existence) drives the badge.
  let effectiveId = listingId;
  let shadowId: string | null = null;
  let hasPendingRevision = false;
  if (listing.status === 'approved') {
    const begun = await beginListingRevision({ listingId, userId });
    shadowId = begun.shadowId;
    effectiveId = begun.shadowId;
    const pendingRevisionReq = await dbRead.appListingPublishRequest.findFirst({
      where: {
        status: 'pending',
        kind: 'offsite',
        appListing: { revisionOfId: listingId },
      },
      select: { id: true },
    });
    hasPendingRevision = !!pendingRevisionReq;
  }

  const view = await loadListingEditView(effectiveId);

  // Resolve the connect client's CURRENT allowedScopes — this is the derived
  // requested-scope set the edit form displays read-only + re-submits (the server
  // re-snapshots `requestedScopes` from it on save). null when the listing has no
  // client or the client no longer exists.
  let connectAllowedScopes: number | null = null;
  if (listing.connectClientId != null) {
    const client = await dbRead.oauthClient.findUnique({
      where: { id: listing.connectClientId },
      select: { allowedScopes: true },
    });
    connectAllowedScopes = client?.allowedScopes ?? null;
  }

  return {
    parentId: listingId,
    slug: listing.slug,
    status: listing.status,
    hasPendingRevision,
    shadowId,
    scalars: view.scalars,
    assets: view.assets,
    connectClientId: listing.connectClientId,
    connectAllowedScopes,
    connectRequestedScopes: view.connectRequestedScopes,
    connectScopeJustifications: view.connectScopeJustifications,
  };
}

/**
 * AUTHOR: write a scalar patch to an owned DRAFT shadow revision (the "direct once
 * shadow exists" scalar write for the approved edit flow). Symmetric with the
 * asset procs, which already mutate a shadow the caller owns. Owner-bound; asserts
 * the target is a draft shadow (revisionOfId set) so this can NEVER edit a live
 * top-level listing — that path stays `updateListing` (state-routed). Validation
 * mirrors the in-place path (`buildListingPatchData`).
 */
export async function updateRevisionDraft(opts: {
  shadowId: string;
  patch: UpdateListingPatch;
  userId: number;
}): Promise<{ shadowId: string }> {
  const { shadowId, patch, userId } = opts;
  const shadow = await loadOwnedEditableListing(shadowId, userId);
  if (shadow.revisionOfId == null) {
    throw new OffsiteRequestError(
      'INVALID_REVISION',
      'updateRevisionDraft targets a shadow revision draft, not a top-level listing'
    );
  }
  if (shadow.status !== 'draft') {
    throw new OffsiteRequestError(
      'INVALID_REVISION',
      `a revision draft can only be edited while draft (status is ${shadow.status})`
    );
  }
  // Derive the requested-scope snapshot from the shadow's connect client (the shadow
  // carries the parent's connectClientId) when the patch touches scopes — same
  // server-authoritative rule as updateListing, so a scope justification staged on a
  // shadow re-snapshots against the client's CURRENT allowedScopes.
  const { effectivePatch, connectAllowedScopes } = await deriveScopePatch({
    connectClientId: shadow.connectClientId,
    patch,
    userId,
  });
  const data = buildListingPatchData(effectivePatch, { connectAllowedScopes });
  await dbWrite.appListing.update({ where: { id: shadowId }, data });
  return { shadowId };
}

// ---------------------------------------------------------------------------
// approveExternalRequest / rejectExternalRequest (moderator) — PR-b.
//
// Mirror the on-site `publish-request.service` approve/reject state machine over
// the `AppListingPublishRequest` + `AppListing` tables (no bundle / build /
// deploy). Approve flips the DRAFT listing → approved (the read path then
// surfaces it in the store); reject DELETES the draft (releases the slug). Both
// writes are status-guarded `updateMany`/`deleteMany` so a concurrent
// approve/reject/withdraw can never double-act (TOCTOU).
// ---------------------------------------------------------------------------

export type ApproveExternalRequestResult = {
  publishRequestId: string;
  listingId: string;
  slug: string;
};

/**
 * Compute the content rating to STAMP on an off-site listing at approve. The
 * scanner's per-image rating is imprecise, so the AUTHOR is never blocked on it +
 * the author's declared rating is only a hint — the authoritative rating is DERIVED
 * from the assets' MAX detected `nsfwLevel` (icon + cover + real screenshots) at
 * review, with an optional mod OVERRIDE.
 *
 * 🔴 SAFETY (floor-at-derived): an override whose ceiling is BELOW the derived value
 * would publish mature assets under a too-low rating — so it is clamped UP to the
 * derived rating (never silently under-rated). An override AT or ABOVE the derived
 * value is honoured (a mod may always rate UP). Reads the backing Image levels from
 * the PRIMARY (`tx`) so the derived rating is row-consistent with the approve flip.
 */
async function resolveApprovalContentRating(
  tx: Prisma.TransactionClient,
  args: {
    appListingId: string;
    iconId: number | null;
    coverId: number | null;
    override?: OffsiteContentRating | null;
  }
): Promise<OffsiteContentRating> {
  const shots = await tx.appListingScreenshot.findMany({
    where: { appListingId: args.appListingId, imageId: { not: null } },
    select: { imageId: true },
  });
  const imageIds = [args.iconId, args.coverId, ...shots.map((s) => s.imageId)].filter(
    (v): v is number => v != null
  );
  const images = imageIds.length
    ? await tx.image.findMany({ where: { id: { in: imageIds } }, select: { nsfwLevel: true } })
    : [];
  const derived = deriveContentRatingFromAssets(images.map((i) => ({ nsfwLevel: i.nsfwLevel })));
  const override = args.override ?? null;
  if (override == null) return derived;
  return nsfwLevelFromContentRating(override) < nsfwLevelFromContentRating(derived)
    ? derived // floor: an under-rating override is clamped up to the derived value
    : override;
}

/**
 * Approval gate for OAuth-CONNECT listings (PR3): every SENSITIVE requested scope
 * MUST carry a non-empty per-scope justification before the listing can go live.
 * `SENSITIVE_TOKEN_SCOPES` (money / private / cross-user writes) is the flagged set;
 * a non-sensitive requested scope need not be justified. No-op for an external-link
 * listing (`connectClientId == null`) or a connect listing requesting no sensitive
 * scope. Throws `BAD_REQUEST` listing the offending scope keys otherwise. Read-only.
 *
 * 🔴 The connect fields are NOT immutable across the approve flow — an owner can edit
 * `connectRequestedScopes`/`connectScopeJustifications` in place while the request
 * sits draft/pending. A pre-tx call on the replica is therefore only a FAST-FAIL; the
 * AUTHORITATIVE gate runs on the in-tx re-read of the row (row-consistent with the
 * status flip) so a concurrent scope-broadening can't slip an unjustified sensitive
 * scope past a mod approval (TOCTOU). Both the first-time approve and the revision
 * approve paths re-invoke this on their in-tx `tx`-read row before flipping status.
 */
function assertConnectSensitiveScopesJustified(listing: {
  connectClientId: string | null;
  connectRequestedScopes: number | null;
  connectScopeJustifications: Prisma.JsonValue | null;
}): void {
  if (listing.connectClientId == null) return; // external-link listing — no scopes.
  const sensitiveRequested = (listing.connectRequestedScopes ?? 0) & SENSITIVE_TOKEN_SCOPES;
  if (sensitiveRequested === 0) return; // nothing sensitive requested.
  const justifications =
    listing.connectScopeJustifications &&
    typeof listing.connectScopeJustifications === 'object' &&
    !Array.isArray(listing.connectScopeJustifications)
      ? (listing.connectScopeJustifications as Record<string, unknown>)
      : {};
  // Each sensitive requested bit is keyed by its TokenScope enum-key (same mapping
  // the author-side justification map uses).
  const missing = tokenScopeMaskToList(sensitiveRequested)
    .filter(({ key }) => {
      const raw = justifications[key];
      return !(typeof raw === 'string' && raw.trim().length > 0);
    })
    .map(({ key }) => key);
  if (missing.length > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `sensitive scope(s) require a justification before approval: ${missing.join(', ')}`,
    });
  }
}

/**
 * MOD approve of a pending off-site request. Loads the request + its draft
 * `AppListing`, asserts `pending`, and enforces two gates BEFORE any mutation:
 *
 *   1. {@link assertListingAssetsComplete} — **THE P3 ACTIVATION.** Approve FAILS
 *      `BAD_REQUEST { missing }` unless the draft has an icon AND a cover AND ≥1
 *      screenshot (a screenshot whose backing Image was deleted — `imageId` null
 *      — does NOT count, mirroring `getListingAssets`' completeness math). This is
 *      the intended live wiring of the dark P1 gate.
 *   2. `validateExternalUrl` on the STORED `externalUrl` (defense-in-depth — a
 *      somehow-bad stored value blocks approve; the card link opens in the user's
 *      browser, so a non-https stored URL must never reach the store).
 *
 * The asset gate is a CHEAP FAIL-FAST on the replica; it is RE-ASSERTED
 * authoritatively on the PRIMARY inside the tx (row-consistent with the flip) —
 * the sibling asset mutators write to `dbWrite`, so under replica lag the replica
 * gate could otherwise pass on stale-complete state.
 *
 * Then, in ONE transaction: re-assert the asset+URL gate on the primary, flip the
 * request `pending → approved` (status-guarded TOCTOU), flip the listing
 * `draft → approved` (status-guarded), and supersede any sibling pending request
 * for the same slug (parity with the on-site approve).
 *
 * NOTE (self-approve): v1 deliberately ALLOWS a moderator to approve their OWN
 * submission (reviewer == submitter) — this enables single-mod dogfooding + the
 * approve e2e, and mods are trusted. A reviewer≠submitter restriction is DEFERRED
 * to GA / P3b hardening (alongside report → verify-ownership → delist/claim). Do
 * NOT add a self-approve block here without that product decision.
 */
export async function approveExternalRequest(opts: {
  publishRequestId: string;
  reviewerUserId: number;
  approvalNotes?: string | null;
  /** Optional mod override of the final content rating (floored at the derived value). */
  contentRating?: OffsiteContentRating | null;
}): Promise<ApproveExternalRequestResult> {
  const { publishRequestId, reviewerUserId } = opts;
  const approvalNotes = opts.approvalNotes ?? null;

  // (1) Classify: an off-site + pending request pointing at a draft listing.
  const request = await dbRead.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, status: true, kind: true, slug: true, appListingId: true },
  });
  if (!request) {
    throw new OffsiteRequestError('NOT_FOUND', `publish request ${publishRequestId} not found`);
  }
  if (request.kind !== 'offsite') {
    throw new OffsiteRequestError(
      'NOT_FOUND',
      `publish request ${publishRequestId} is not an off-site request`
    );
  }
  if (request.status !== 'pending') {
    throw new OffsiteRequestError(
      'NOT_PENDING',
      `cannot approve a request in status ${request.status}`
    );
  }
  if (!request.appListingId) {
    throw new OffsiteRequestError(
      'NOT_FOUND',
      `publish request ${publishRequestId} has no draft listing`
    );
  }
  // Narrow once for the tx closures below (findUnique needs a non-null id).
  const appListingId = request.appListingId;

  // (2) CHEAP PRE-TX FAIL-FAST on the replica: load the draft listing + count its
  // REAL (imageId-bearing) screenshots so an obviously-incomplete listing is
  // rejected before we open a transaction. This is NOT authoritative — the
  // AUTHORITATIVE gate re-reads the PRIMARY inside the tx below (the sibling asset
  // mutators write to dbWrite, so under replica lag this replica read can be
  // stale-complete). See step (5).
  const listing = await dbRead.appListing.findUnique({
    where: { id: appListingId },
    select: {
      id: true,
      status: true,
      externalUrl: true,
      iconId: true,
      coverId: true,
      revisionOfId: true,
      // Connect sub-kind (PR3): the discriminator + the reviewed scope disclosure —
      // used to SKIP the external-URL gate (connect listings store `externalUrl:null`)
      // and to enforce the sensitive-must-justify approval gate.
      connectClientId: true,
      connectRequestedScopes: true,
      connectScopeJustifications: true,
      // Owner (for the post-commit "approved" owner notification) + name (message).
      userId: true,
      name: true,
      slug: true,
    },
  });
  if (!listing) {
    throw new OffsiteRequestError('NOT_FOUND', `draft listing ${appListingId} not found`);
  }

  // REVISION branch: the request points at a SHADOW (an edit of an approved
  // parent), not a first-time draft. Apply the shadow onto its live parent instead
  // of the first-time draft→approved flip. The NON-revision path below is
  // deliberately left byte-for-behavior UNCHANGED.
  if (listing.revisionOfId != null) {
    return applyApprovedRevision({
      request,
      shadowId: appListingId,
      parentId: listing.revisionOfId,
      reviewerUserId,
      approvalNotes,
      contentRating: opts.contentRating,
    });
  }

  const screenshotCount = await dbRead.appListingScreenshot.count({
    where: { appListingId, imageId: { not: null } },
  });

  // (3) THE P3 ACTIVATION — mandatory-asset gate (throws BAD_REQUEST { missing }).
  // Fail-fast copy on the replica; re-asserted authoritatively on the primary in (5).
  assertListingAssetsComplete({
    iconId: listing.iconId,
    coverId: listing.coverId,
    screenshotCount,
  });

  // (4) Defense-in-depth: re-validate the STORED externalUrl before it can reach
  // the store (mirrors submit + the read-path `safeExternalUrl`). Also re-checked
  // on the primary inside the tx. In the MERGED model `externalUrl` is OPTIONAL for
  // every listing, so the gate runs ONLY WHEN a URL is present — a provided URL must
  // still be a valid https link; a null URL (connect-only, or a legacy row without a
  // homepage) approves fine.
  if (listing.externalUrl != null) {
    const url = validateExternalUrl(listing.externalUrl);
    if (!url.ok) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `stored externalUrl is invalid and cannot be approved: ${url.error}`,
      });
    }
  }

  // (4b) OAuth-scope approval gate: every SENSITIVE requested scope must carry a
  // non-empty justification before the app goes live. No-op for a legacy URL-only
  // row (`connectClientId == null`); runs for every OAuth-linked external listing.
  assertConnectSensitiveScopesJustified(listing);

  // (5) One transaction: RE-ASSERT the asset gate on the PRIMARY (row-consistent
  // with the flip) + guarded request flip + guarded listing flip + supersede.
  await dbWrite.$transaction(async (tx) => {
    // AUTHORITATIVE asset gate — re-read from the PRIMARY (`tx`), not the replica.
    // The sibling asset mutators (add/reorder/removeListingScreenshot,
    // setListingIcon/Cover) deliberately read+write dbWrite to avoid replica-lag
    // races, so under lag + a concurrent owner asset-edit the pre-tx replica gate
    // in (3) can pass on stale-complete state. Re-reading iconId/coverId + the
    // imageId-bearing screenshot count via `tx` (and re-validating the stored URL)
    // makes the security-relevant gate row-consistent with the status flip below;
    // any failure rolls the whole tx back BEFORE anything is flipped.
    const primaryListing = await tx.appListing.findUnique({
      where: { id: appListingId },
      select: {
        externalUrl: true,
        iconId: true,
        coverId: true,
        connectClientId: true,
        // Connect sub-kind (PR3): re-read the reviewed scope disclosure on the PRIMARY
        // so the sensitive-must-justify + subset-of-ceiling gates below are authoritative
        // (row-consistent with the flip), not merely checked pre-tx on the replica.
        connectRequestedScopes: true,
        connectScopeJustifications: true,
        connectClient: { select: { allowedScopes: true } },
      },
    });
    if (!primaryListing) {
      throw new OffsiteRequestError('NOT_FOUND', `draft listing ${appListingId} not found`);
    }
    const primaryScreenshotCount = await tx.appListingScreenshot.count({
      where: { appListingId, imageId: { not: null } },
    });
    assertListingAssetsComplete({
      iconId: primaryListing.iconId,
      coverId: primaryListing.coverId,
      screenshotCount: primaryScreenshotCount,
    });
    // Validate the stored externalUrl ONLY WHEN present (it's optional in the merged
    // model); a null URL approves fine. See step (4).
    if (primaryListing.externalUrl != null) {
      const primaryUrl = validateExternalUrl(primaryListing.externalUrl);
      if (!primaryUrl.ok) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `stored externalUrl is invalid and cannot be approved: ${primaryUrl.error}`,
        });
      }
    }

    // AUTHORITATIVE connect-scope gate — re-run on the PRIMARY read (row-consistent
    // with the flip). The pre-tx gate in (4b) is a REPLICA fail-fast: the connect
    // fields are owner-editable in-place while the request sits pending (draft/pending
    // in-place edit), so an owner could broaden `connectRequestedScopes` to sensitive
    // bits (with an empty justification map) AFTER the mod's pre-tx gate passed but
    // BEFORE this flip — a mod-approved listing would then go live with unjustified
    // sensitive scopes. Re-asserting on the in-tx row closes that TOCTOU. Mirrors the
    // revision path's in-tx re-gate. Only for connect listings (`connectClientId`
    // non-null here; external-link listings carry no scopes).
    if (primaryListing.connectClientId != null) {
      assertConnectSensitiveScopesJustified({
        connectClientId: primaryListing.connectClientId,
        connectRequestedScopes: primaryListing.connectRequestedScopes,
        connectScopeJustifications: primaryListing.connectScopeJustifications,
      });
      // Also re-assert subset-of-ceiling on the primary: guards a client whose
      // `allowedScopes` SHRANK after submit (the pre-tx subset check happened at
      // submit/edit time). A connect listing always has a `connectClient` row here
      // (FK-backed by the non-null `connectClientId`); treat a null ceiling as 0.
      const allowedScopes = primaryListing.connectClient?.allowedScopes ?? 0;
      if (!connectScopesSubsetOfCeiling(primaryListing.connectRequestedScopes ?? 0, allowedScopes)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'requested scopes exceed the OAuth client’s allowed scopes',
        });
      }
    }

    const req = await tx.appListingPublishRequest.updateMany({
      where: { id: publishRequestId, status: 'pending' },
      data: {
        status: 'approved',
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        approvalNotes,
      },
    });
    if (req.count === 0) {
      // Lost the TOCTOU race to a concurrent withdraw/reject/approve — the whole
      // tx rolls back.
      throw new OffsiteRequestError(
        'NOT_PENDING',
        `cannot approve — the request is no longer pending`
      );
    }
    // Derive (+ mod-override, floored) the content rating from the assets' max
    // detected nsfwLevel and stamp it on the listing as it goes live. The author is
    // never blocked on the scanner's rating — it is confirmed HERE at review.
    const finalRating = await resolveApprovalContentRating(tx, {
      appListingId,
      iconId: primaryListing.iconId,
      coverId: primaryListing.coverId,
      override: opts.contentRating,
    });
    // Guard flips a `draft` OR a `pending` listing → approved. `pending` is the W13
    // post-approval-mgmt REOPEN path: `resetListingToPending` bounces an approved
    // listing back to `pending` + mints a fresh pending request pointing at it (a
    // non-shadow request), so re-approving that request must accept a `pending`
    // listing — not only a first-time `draft`. Additive: a first-time draft still
    // flips exactly as before. Status-guarded so a concurrently deleted/moved row
    // rolls the request flip back rather than approving a listing that is gone.
    const flipped = await tx.appListing.updateMany({
      where: { id: appListingId, status: { in: ['draft', 'pending'] } },
      data: { status: 'approved', contentRating: finalRating },
    });
    if (flipped.count === 0) {
      // The draft/pending listing was concurrently deleted / already flipped — abort
      // (rolls back the request flip) rather than approve a request whose listing is gone.
      throw new OffsiteRequestError(
        'NOT_PENDING',
        `cannot approve — the draft/pending listing is no longer available`
      );
    }
    // Supersede any OTHER pending off-site request pointing at the SAME listing row
    // (`appListingId`), NOT merely the same slug. 🔴 A pending REVISION request
    // denormalizes the PARENT slug (`submitListingRevision` sets its
    // `slug = shadow.revisionOf.slug`) but targets a DISTINCT shadow listing
    // (`appListingId = shadowId`, `revisionOfId != null`). Scoping the supersede by
    // slug therefore swept an owner's in-flight revision when a mod approved a
    // reset-to-pending request for the same parent — orphaning the shadow with no
    // notice. Scoping by `appListingId` supersedes only genuine siblings on THIS
    // exact listing (e.g. a duplicate reset request) and leaves a legitimately-
    // competing revision (a different appListingId) pending. Still scoped to NOT
    // touch the approved row.
    await tx.appListingPublishRequest.updateMany({
      where: {
        appListingId,
        status: 'pending',
        kind: 'offsite',
        NOT: { id: publishRequestId },
      },
      data: { status: 'withdrawn' },
    });
  });

  // Post-commit, best-effort: notify the listing OWNER their app went live. Emitted
  // AFTER the tx so a notification failure can't roll back the approval, and only on
  // a committed approve. Keyed by the publish request so a ret/replay dedups. Covers
  // BOTH a first-time approve and a reset-to-pending re-approve (both land here — the
  // revision-apply path returns earlier). (The listing owner may differ from the
  // submitter after a mod claim, so target `AppListing.userId`, not submittedBy.)
  await notifyAppListingOwner({
    type: 'app-listing-approved',
    userId: listing.userId,
    key: `app-listing-approved:${publishRequestId}`,
    details: { slug: listing.slug, name: listing.name, listingId: appListingId, reason: null },
  });

  return { publishRequestId, listingId: appListingId, slug: request.slug };
}

/**
 * REVISION APPLY (shadow-draft): copy an approved shadow's contents onto its live
 * parent, preserving the parent's id / slug / appBlockId / metric / reports, then
 * retire the shadow. Called by {@link approveExternalRequest} when the request's
 * listing has `revisionOfId` set.
 *
 * In ONE transaction (authoritative on the primary):
 *   1. Re-load the shadow from the primary; re-assert it is still a draft revision,
 *      asset-complete, and URL-valid (any failure rolls the whole tx back before
 *      any mutation — the parent stays exactly as it was).
 *   2. Flip the request pending→approved (status-guarded TOCTOU) AND re-point it at
 *      the PARENT (so the approved request documents the live listing, and deleting
 *      the shadow can't SetNull it — the FK is `onDelete: SetNull`).
 *   3. Copy the shadow's scalars (name/tagline/description/category/contentRating/
 *      externalUrl/iconId/coverId/connectClientId) onto the parent. NOT status /
 *      slug / appBlockId / id — the live identity + placement are preserved.
 *   4. REPARENT the shadow's screenshots onto the parent: delete the parent's
 *      existing screenshot rows, then UPDATE the shadow's screenshots'
 *      appListingId → parent BEFORE deleting the shadow, so the CASCADE on the
 *      shadow delete drops nothing (the rows have already left the shadow).
 *   5. Delete the shadow (guarded to a revision row so it can never remove a real
 *      listing). Its screenshots are gone (moved) and its only request is re-pointed
 *      at the parent, so the cascade is a no-op.
 */
async function applyApprovedRevision(opts: {
  request: { id: string; slug: string; appListingId: string | null };
  shadowId: string;
  parentId: string;
  reviewerUserId: number;
  approvalNotes: string | null;
  /** Optional mod override of the final content rating (floored at the derived value). */
  contentRating?: OffsiteContentRating | null;
}): Promise<ApproveExternalRequestResult> {
  const { request, shadowId, parentId, reviewerUserId, approvalNotes } = opts;

  // Parent must still exist (defense — its delete would CASCADE the shadow away).
  const parent = await dbRead.appListing.findUnique({
    where: { id: parentId },
    select: { id: true, slug: true, status: true },
  });
  if (!parent) {
    throw new OffsiteRequestError('NOT_FOUND', `parent listing ${parentId} not found`);
  }
  // The live parent must still be APPROVED. If a mod REMOVED (took down) or
  // otherwise un-approved it after this revision was submitted, applying the
  // shadow's scalars would leave a confusing "approved request → still-hidden
  // listing" state (the copy doesn't flip status). Refuse instead.
  if (parent.status !== 'approved') {
    throw new OffsiteRequestError(
      'INVALID_REVISION',
      `the live listing is no longer approved (status is ${parent.status}); cannot apply this revision`
    );
  }

  await dbWrite.$transaction(async (tx) => {
    // (1) AUTHORITATIVE re-read of the shadow on the PRIMARY (row-consistent with
    // the copy). The sibling asset mutators write to dbWrite, so a pre-tx replica
    // gate could pass on stale-complete state — re-assert here.
    const shadow = await tx.appListing.findUnique({
      where: { id: shadowId },
      select: {
        id: true,
        status: true,
        revisionOfId: true,
        name: true,
        tagline: true,
        description: true,
        category: true,
        contentRating: true,
        externalUrl: true,
        connectClientId: true,
        connectRequestedScopes: true,
        connectScopeJustifications: true,
        // The reviewed client's scope CEILING — re-asserted in-tx below so a client
        // whose `allowedScopes` SHRANK between edit and revision-approve can't slip a
        // now-out-of-ceiling scope past the mod (mirrors the first-time approve path).
        connectClient: { select: { allowedScopes: true } },
        iconId: true,
        coverId: true,
      },
    });
    if (!shadow || shadow.revisionOfId !== parentId || shadow.status !== 'draft') {
      throw new OffsiteRequestError(
        'NOT_PENDING',
        'cannot approve — the revision draft is no longer available'
      );
    }
    const screenshotCount = await tx.appListingScreenshot.count({
      where: { appListingId: shadowId, imageId: { not: null } },
    });
    assertListingAssetsComplete({
      iconId: shadow.iconId,
      coverId: shadow.coverId,
      screenshotCount,
    });
    // Validate the stored externalUrl ONLY WHEN present (optional in the merged
    // model); a null URL is fine. See the first-time approve path (step 4).
    if (shadow.externalUrl != null) {
      const url = validateExternalUrl(shadow.externalUrl);
      if (!url.ok) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `stored externalUrl is invalid and cannot be approved: ${url.error}`,
        });
      }
    }
    // OAuth-scope approval gate: the revision carries the (possibly UPDATED) scope
    // set that will go live — every sensitive requested scope must be justified.
    assertConnectSensitiveScopesJustified({
      connectClientId: shadow.connectClientId,
      connectRequestedScopes: shadow.connectRequestedScopes,
      connectScopeJustifications: shadow.connectScopeJustifications,
    });
    // Also re-assert subset-of-ceiling on the in-tx shadow (mirrors the first-time
    // approve path): guards a client whose `allowedScopes` SHRANK after the revision
    // was edited. Only for OAuth-linked listings (`connectClientId` non-null; a legacy
    // URL-only revision carries no scopes). A null ceiling is treated as 0.
    if (shadow.connectClientId != null) {
      const allowedScopes = shadow.connectClient?.allowedScopes ?? 0;
      if (!connectScopesSubsetOfCeiling(shadow.connectRequestedScopes ?? 0, allowedScopes)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'requested scopes exceed the OAuth client’s allowed scopes',
        });
      }
    }

    // (2) Flip the request pending→approved AND re-point it at the PARENT.
    const req = await tx.appListingPublishRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: {
        status: 'approved',
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        approvalNotes,
        // Re-point at the live parent so (a) the approved request documents the
        // live listing and (b) the shadow delete below can't SetNull this row.
        appListingId: parentId,
      },
    });
    if (req.count === 0) {
      throw new OffsiteRequestError(
        'NOT_PENDING',
        'cannot approve — the request is no longer pending'
      );
    }

    // (3) Copy scalars onto the parent (id / slug / appBlockId / status untouched).
    // The content rating is DERIVED from the shadow's assets' max nsfwLevel (+ the
    // mod override, floored) rather than trusting the shadow's declared value — same
    // never-under-rate safety as the first-time approve path.
    const finalRating = await resolveApprovalContentRating(tx, {
      appListingId: shadowId,
      iconId: shadow.iconId,
      coverId: shadow.coverId,
      override: opts.contentRating,
    });
    await tx.appListing.update({
      where: { id: parentId },
      data: {
        name: shadow.name,
        tagline: shadow.tagline,
        description: shadow.description,
        category: shadow.category,
        contentRating: finalRating,
        externalUrl: shadow.externalUrl,
        connectClientId: shadow.connectClientId,
        // Apply the revision's disclosed OAuth scopes + justifications onto the live
        // parent (a scope change is material, so the shadow carries the reviewed set).
        connectRequestedScopes: shadow.connectRequestedScopes,
        connectScopeJustifications:
          shadow.connectScopeJustifications === null
            ? Prisma.DbNull
            : (shadow.connectScopeJustifications as Prisma.InputJsonValue),
        iconId: shadow.iconId,
        coverId: shadow.coverId,
      },
    });

    // (4) Reparent screenshots BEFORE deleting the shadow (cascade-safe): drop the
    // parent's current rows, then move the shadow's rows onto the parent.
    await tx.appListingScreenshot.deleteMany({ where: { appListingId: parentId } });
    await tx.appListingScreenshot.updateMany({
      where: { appListingId: shadowId },
      data: { appListingId: parentId },
    });

    // (5) Retire the shadow (guarded to a revision row). Screenshots already moved;
    // the request already re-pointed — the cascade drops nothing.
    await tx.appListing.deleteMany({
      where: { id: shadowId, revisionOfId: { not: null } },
    });
  });

  return { publishRequestId: request.id, listingId: parentId, slug: parent.slug };
}

/**
 * MOD reject of a pending off-site request. Requires a `rejectionReason` of
 * ≥`OFFSITE_REJECTION_REASON_MIN` (the shared `OFFSITE_MOD_REASON_MIN`, 3)
 * (trimmed) chars, then — in ONE transaction — flips the request
 * `pending → rejected` + sets `reviewedBy*` / `rejectionReason` and DELETES the
 * draft `AppListing` (status-guarded `deleteMany({ id, status:'draft' })` so it can
 * never remove an approved listing — releases the slug). Wrapping the flip + delete
 * in a single tx means a crash between them can't orphan a hidden `draft` listing
 * that keeps squatting the slug (parity with approve). The flip is a status-guarded
 * `updateMany` so a concurrent approve/withdraw that already flipped the row yields
 * NOT_PENDING (and, having matched 0, the tx rolls back before the delete).
 * Non-pending → NOT_PENDING.
 *
 * REVISION-AWARE (no branch needed): a pending REVISION request points at a SHADOW
 * `AppListing`, which is `status:'draft'`, so `closeTerminalListing` DELETES ONLY the
 * shadow (the `draft` branch) — the LIVE parent (a separate `approved` row) is
 * untouched and stays live. Rejecting a revision therefore behaves exactly like
 * rejecting a first-time submission, by construction. A reset-to-pending, formerly-live
 * listing is instead transitioned to `removed` + a `delist` audit event (a rejected
 * re-review = a MOD takedown the owner cannot self-restore); see `closeTerminalListing`.
 */
export async function rejectExternalRequest(opts: {
  publishRequestId: string;
  reviewerUserId: number;
  rejectionReason: string;
}): Promise<void> {
  const { publishRequestId, reviewerUserId } = opts;
  const reason = opts.rejectionReason.trim();
  if (reason.length < OFFSITE_REJECTION_REASON_MIN) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `rejection reason must be at least ${OFFSITE_REJECTION_REASON_MIN} characters`,
    });
  }
  if (reason.length > OFFSITE_REJECTION_REASON_MAX) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `rejection reason must be at most ${OFFSITE_REJECTION_REASON_MAX} characters`,
    });
  }

  const request = await dbRead.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, status: true, kind: true, appListingId: true },
  });
  if (!request) {
    throw new OffsiteRequestError('NOT_FOUND', `publish request ${publishRequestId} not found`);
  }
  if (request.kind !== 'offsite') {
    throw new OffsiteRequestError(
      'NOT_FOUND',
      `publish request ${publishRequestId} is not an off-site request`
    );
  }
  if (request.status !== 'pending') {
    throw new OffsiteRequestError(
      'NOT_PENDING',
      `cannot reject a request in status ${request.status}`
    );
  }

  // Snapshot the owner + display fields for the post-commit "not approved" owner
  // notification BEFORE the tx deletes the draft (the row is gone afterwards). A
  // REVISION reject (the request points at a shadow — `revisionOfId != null`) is
  // NOT a first-time rejection: the parent listing stays LIVE, so a "your app was
  // not approved" notice would be misleading — skip it (revision-edit rejection
  // notices are out of Phase-1 scope). A request whose listing was already gone
  // (`appListingId` null) → nothing to notify.
  const rejectedListing = request.appListingId
    ? await dbRead.appListing.findUnique({
        where: { id: request.appListingId },
        select: { userId: true, name: true, slug: true, revisionOfId: true },
      })
    : null;

  // ONE transaction: status-guarded flip + the status-aware listing close, so a crash
  // between them can't orphan a hidden listing / squat the slug. The flip is
  // TOCTOU-guarded (`status:'pending'`): a concurrent approve/withdraw that already
  // flipped the row matches 0 → NOT_PENDING (throwing rolls the tx back before the
  // close); only the winner closes. `closeTerminalListing` deletes a first-time
  // `draft` (releases the slug — unchanged) but transitions a reset-to-pending,
  // formerly-LIVE listing to `removed` (recoverable; NEVER stranded in `pending` nor
  // hard-deleted) + writes a `delist` audit event so a rejected re-review reads as a
  // MOD takedown — the owner CANNOT self-restore it via `republishOwnListing`.
  await dbWrite.$transaction(async (tx) => {
    const { count } = await tx.appListingPublishRequest.updateMany({
      where: { id: publishRequestId, status: 'pending' },
      data: {
        status: 'rejected',
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
    });
    if (count === 0) {
      throw new OffsiteRequestError(
        'NOT_PENDING',
        `cannot reject — the request is no longer pending`
      );
    }
    await closeTerminalListing(tx, request.appListingId, {
      actorUserId: reviewerUserId,
      reason,
    });
  });

  // Post-commit, best-effort: notify the owner their first-time submission was not
  // approved, carrying the mod reason. Skipped for a revision reject (parent still
  // live) and when there was no listing. Keyed by the request → dedups a replay.
  if (rejectedListing && rejectedListing.revisionOfId == null) {
    await notifyAppListingOwner({
      type: 'app-listing-rejected',
      userId: rejectedListing.userId,
      key: `app-listing-rejected:${publishRequestId}`,
      details: {
        slug: rejectedListing.slug,
        name: rejectedListing.name,
        listingId: request.appListingId,
        reason,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// persistListingAssetImage (author) — asset-step glue for the submit form.
// ---------------------------------------------------------------------------

/**
 * Materialise a CF-uploaded image into an `Image` row (owned by the caller) and
 * return its numeric id, so the submit form's asset step can attach it to the
 * draft listing via the P1 asset-CRUD procs. Kicks off the standard ingestion/scan
 * pipeline (`createImage` with default ingestion) — the P1 attach proc enforces
 * `ingestion === Scanned` + the per-kind image validation, so this proc does NOT
 * re-validate dimensions/mime (it only persists). `createImage` is dynamically
 * imported so the heavy `image.service` module stays out of this service's static
 * graph (mirrors the router's dynamic-import discipline + keeps the unit tests,
 * which mock only `dbRead`/`dbWrite`, light).
 */
export async function persistListingAssetImage(opts: {
  input: PersistListingAssetImageInput;
  userId: number;
}): Promise<{ imageId: number }> {
  const { input, userId } = opts;
  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: input.url,
    name: input.name ?? undefined,
    type: 'image',
    width: input.width,
    height: input.height,
    mimeType: input.mimeType,
    // The P1 image validator reads the byte size from `Image.metadata.size`.
    metadata: input.sizeBytes != null ? { size: input.sizeBytes } : undefined,
    userId,
  });
  return { imageId: image.id };
}

// ---------------------------------------------------------------------------
// Read-only lists.
// ---------------------------------------------------------------------------

const submissionSelect = {
  id: true,
  appListingId: true,
  slug: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  rejectionReason: true,
  approvalNotes: true,
  changelog: true,
  appListing: {
    // `revisionOfId` lets a caller INFER whether a request targets a shadow (a
    // revision) vs a top-level listing — no dedicated column on the request.
    select: {
      name: true,
      externalUrl: true,
      category: true,
      contentRating: true,
      revisionOfId: true,
      // OAuth-connect sub-kind (PR3 mod review): the requested-scope disclosure the
      // moderator reviews. `connectClientId` is the discriminator (null ⇒ an
      // external-link listing; the mod UI renders the scope panel only when set);
      // `connectRequestedScopes` is the disclosed bitmask, `connectScopeJustifications`
      // the per-scope rationale map. `connectClient.{name,allowedScopes}` gives the
      // reviewed client's display name + its scope CEILING for context. All
      // additive/PII-safe — the external-link queues just carry nulls.
      connectClientId: true,
      connectRequestedScopes: true,
      connectScopeJustifications: true,
      connectClient: { select: { name: true, allowedScopes: true } },
      // The listing's TRUE lifecycle status (`draft|pending|approved|rejected|
      // removed`) — DISTINCT from the publish-REQUEST `status`. An owner unpublish
      // / mod delist flips `AppListing.status` approved → removed WITHOUT touching
      // the (still-`approved`) request, so my-submissions can only distinguish a
      // live listing from a hidden one by reading THIS field. Additive/PII-safe;
      // the mod queues that spread `submissionSelect` gain it harmlessly.
      status: true,
    },
  },
} as const;

const submitterChip = { select: { id: true, username: true, image: true } } as const;

export type ListOffsiteRequestsOptions = { limit?: number; cursor?: string };

/**
 * The caller's OWN off-site submissions, newest-first, keyset-paginated. Scoped
 * to `submittedByUserId` — never another user's rows.
 *
 * SHADOW handling: a pending REVISION request targets a hidden SHADOW listing
 * (`appListing.revisionOfId != null`) — it must NOT surface as its own top-level
 * submission. Those requests are excluded here; instead each PARENT row carries a
 * `hasPendingRevision` flag so the my-submissions UI can badge "a revision is
 * under review". (A request whose listing was deleted — `appListingId` null, e.g.
 * a rejected/withdrawn submission — is still shown.) The shape is otherwise
 * backward-compatible: `hasPendingRevision` is purely additive.
 */
export async function listMySubmissions(
  opts: { userId: number } & ListOffsiteRequestsOptions
) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: {
      submittedByUserId: opts.userId,
      kind: 'offsite',
      // Exclude requests targeting a SHADOW (revision) listing — surfaced as a
      // flag on the parent, not as their own row. Keep requests with no listing.
      OR: [{ appListingId: null }, { appListing: { revisionOfId: null } }],
    },
    orderBy: { submittedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: submissionSelect,
  });
  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;

  // Flag which parent listings on this page have a revision UNDER REVIEW. This is
  // derived from the existence of a PENDING publish request that targets a shadow
  // (a `revisionOfId`-bearing listing) for the parent — NOT from mere shadow
  // existence. An abandoned shadow (opened via beginListingRevision but never
  // submitListingRevision-ed → no pending request) must NOT falsely badge the
  // parent "revision in review".
  const parentIds = page
    .map((r) => r.appListingId)
    .filter((id): id is string => id != null);
  const pendingRevisionReqs =
    parentIds.length > 0
      ? await dbRead.appListingPublishRequest.findMany({
          where: {
            status: 'pending',
            kind: 'offsite',
            appListing: { revisionOfId: { in: parentIds } },
          },
          select: { appListing: { select: { revisionOfId: true } } },
        })
      : [];
  const parentsWithRevision = new Set(
    pendingRevisionReqs
      .map((r) => r.appListing?.revisionOfId)
      .filter((id): id is string => id != null)
  );

  // W13 post-approval mgmt (owner controls): for every REMOVED listing on the page,
  // fetch its MOST-RECENT moderation-event action so the my-submissions UI can tell
  // an owner-hidden listing (last event `owner-unpublish` → republish-eligible) from
  // a moderator takedown (last event `delist` → republish FORBIDDEN, shown as
  // "removed by a moderator") WITHOUT a per-row history fetch.
  //
  // Fix B4 (scaling): a Prisma `findMany({ distinct, orderBy: createdAt })` CANNOT
  // emit Postgres `DISTINCT ON` here — the `distinct` column (`appListingId`) is not
  // the leading `orderBy` key (`createdAt`), so Prisma fetches EVERY moderation event
  // for every removed listing on the page and dedups in memory (unbounded per listing
  // — a heavily-moderated listing has an arbitrarily long history). Use a raw
  // `DISTINCT ON (app_listing_id) ... ORDER BY app_listing_id, created_at DESC, id
  // DESC` so Postgres returns exactly ONE row per listing (the latest event). Same
  // result contract (last action per appListingId), bounded to one row per listing.
  const removedParentIds = page
    .filter((r) => r.appListingId != null && r.appListing?.status === 'removed')
    .map((r) => r.appListingId as string);
  const lastEvents =
    removedParentIds.length > 0
      ? await dbRead.$queryRaw<Array<{ appListingId: string; action: string }>>(Prisma.sql`
          SELECT DISTINCT ON (app_listing_id)
            app_listing_id AS "appListingId",
            action
          FROM app_listing_moderation_events
          WHERE app_listing_id IN (${Prisma.join(removedParentIds)})
          ORDER BY app_listing_id, created_at DESC, id DESC
        `)
      : [];
  const lastActionByListing = new Map(
    lastEvents
      .filter((e): e is { appListingId: string; action: string } => e.appListingId != null)
      .map((e) => [e.appListingId, e.action])
  );

  const items = page.map((r) => ({
    ...r,
    hasPendingRevision: r.appListingId != null && parentsWithRevision.has(r.appListingId),
    // Null for a non-removed listing (or one with no events) — the UI only reads it
    // when `appListing.status === 'removed'` to gate the Republish affordance.
    lastModerationAction:
      r.appListingId != null ? lastActionByListing.get(r.appListingId) ?? null : null,
  }));

  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

/** Mod queue: pending off-site requests, oldest-first (FIFO), keyset-paginated. */
export async function listPendingOffsiteRequests(opts: ListOffsiteRequestsOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { status: 'pending', kind: 'offsite' },
    orderBy: { submittedAt: 'asc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { ...submissionSelect, submittedBy: submitterChip },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

/** Mod history: approved off-site requests, most-recently-reviewed first. */
export async function listApprovedOffsiteRequests(opts: ListOffsiteRequestsOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { status: 'approved', kind: 'offsite' },
    orderBy: { reviewedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      ...submissionSelect,
      submittedBy: submitterChip,
      reviewedBy: submitterChip,
    },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

/** Mod history: rejected off-site requests, most-recently-reviewed first. */
export async function listRejectedOffsiteRequests(opts: ListOffsiteRequestsOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { status: 'rejected', kind: 'offsite' },
    orderBy: { reviewedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      ...submissionSelect,
      submittedBy: submitterChip,
      reviewedBy: submitterChip,
    },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}
