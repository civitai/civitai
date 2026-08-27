import { TRPCError } from '@trpc/server';
// Value import (not `import type`) — `Prisma.sql`/`Prisma.join` are runtime helpers
// used by the raw `DISTINCT ON` in `listMySubmissions`. The namespace still supplies
// every `Prisma.*` TYPE this module references.
import { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import {
  listingAssetTooLargeReason,
  MAX_LISTING_ASSET_SIZE_BYTES,
} from '~/server/schema/blocks/app-listing.schema';
import {
  assertNoOnPlatformSurface,
  validateExternalUrl,
  validateRepositoryUrl,
} from '~/server/schema/blocks/external-app.schema';
import {
  assertSourceRepoWritable,
  isSourceRepoColumnAvailable,
  readListingSourceRepoUrl,
  sourceRepoWriteFragment,
  type ListingSourceRepoRead,
} from '~/server/services/blocks/app-listing-source-repo.service';
import {
  OFFSITE_CONTENT_RATINGS,
  OFFSITE_REJECTION_REASON_MAX,
  OFFSITE_REJECTION_REASON_MIN,
  type OffsiteContentRating,
  type PersistListingAssetImageInput,
  type SubmitExternalListingInput,
} from '~/server/schema/blocks/offsite-listing.schema';
import { MATERIAL_LISTING_PATCH_FIELDS } from '~/shared/constants/app-capabilities.constants';
import { isAppBlockOauthClientId } from '~/shared/constants/block-scope.constants';
import {
  connectScopesSubsetOfCeiling,
  validateConnectScopeJustifications,
  SENSITIVE_TOKEN_SCOPES,
  tokenScopeMaskToList,
} from '~/shared/constants/token-scope.constants';
import {
  assertAssetsScanClean,
  assertListingMeetsFloor,
  resolveListingRatingFloorInTx,
} from '~/server/services/blocks/app-listing-assets.service';
import { assertOffsiteListingActionable } from '~/server/services/blocks/app-listing-actionable.service';
import {
  isOwnerUnpublishedListing,
  readLastModerationAction,
  isOwnerUnpublishAction,
  LISTING_STATUS_CHANGING_MODERATION_ACTIONS,
} from '~/server/services/blocks/app-listing-owner-unpublish';
// TYPE-ONLY (erased at compile time) — the runtime reach into `app-access.service` stays
// a dynamic import, so this adds nothing to the module graph. See `resolveListingRole`.
import type { AppRole } from '~/server/services/blocks/app-access.service';
import {
  computeListingProblems,
  type ListingProblemKind,
} from '~/server/services/blocks/listing-problems';
import { measureUploadedImage } from '~/server/services/blocks/measure-uploaded-image';
import { storedObjectEtagMetadata } from '~/server/services/blocks/stored-object-integrity';
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
  | 'INVALID_REVISION'
  // The author tried to change a MATERIAL field (externalUrl / name / contentRating /
  // sourceRepoUrl / the disclosed scope mask) on a listing the OWNER has unpublished.
  // Trivial copy edits on that listing are fine; a material one has to go back through
  // review, which means republishing first and editing through the shadow path.
  | 'MATERIAL_CHANGE_BLOCKED';

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
 * submit on another user's behalf. The linked OAuth client is ALSO gated
 * (`loadConnectClientForListing`: exists / not an App-Block client / owned-by-caller —
 * the owner check is relaxed for a MODERATOR, who may link any non-App-Block client,
 * mirroring the mod-only global client search).
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
  /**
   * The caller's moderator status. When true, `loadConnectClientForListing` skips the
   * owner-only check so a mod may link ANY (non-App-Block) OAuth client — mirroring the
   * mod-only global client search that feeds the submit picker. A non-mod stays
   * restricted to their own clients. The listing OWNER is still the caller (`userId`).
   */
  isModerator?: boolean;
}): Promise<SubmitExternalListingResult> {
  const { input, userId, isModerator = false } = opts;

  // Defense-in-depth: re-run the shared URL validator — but ONLY when a URL is
  // provided (externalUrl is now optional; a connect-only listing omits it). This fn
  // is exported + unit-tested directly, not only reached through the schema.
  const url = input.externalUrl != null ? validateExternalUrl(input.externalUrl) : null;
  if (url && !url.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: url.error });
  // Same posture for the OPTIONAL public source-repository link: re-run the shared
  // validator (this fn is exported + unit-tested directly, not only reached through the
  // schema) and STORE THE NORMALISED FORM, so a later material-change comparison is
  // against a canonical value rather than whatever the author happened to paste.
  const sourceRepo =
    input.sourceRepoUrl != null ? validateRepositoryUrl(input.sourceRepoUrl) : null;
  if (sourceRepo && !sourceRepo.ok) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: sourceRepo.error });
  }
  // 🔴 THE AUTHOR SUPPLIED A LINK, SO THE COLUMN MUST EXIST BEFORE WE PROMISE TO STORE
  // IT. `app_listings.source_repo_url` is MANUAL-APPLY; writing it before a human runs
  // the SQL raises P2022 and the author gets a 500 naming a database column, and
  // dropping it silently would return "submitted" for a listing whose source link is
  // simply gone. Neither is acceptable, so refuse with a message that names the field.
  //
  // 🔴 PROBED ONLY WHEN THERE IS SOMETHING TO WRITE. An author who leaves the field
  // empty must be able to submit exactly as before — same query count, same behaviour —
  // which is also why the create below OMITS the key rather than writing `null`.
  //
  // Probed on `dbWrite` (the PRIMARY), because the primary is where the create lands: a
  // replica probe could answer "absent" for a column DDL that has already committed on
  // the primary and not yet replicated, refusing a submit that would have worked.
  if (sourceRepo && sourceRepo.ok) {
    assertSourceRepoWritable(await isSourceRepoColumnAvailable(dbWrite));
  }
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
  const client = await loadConnectClientForListing(input.connectClientId, userId, isModerator);
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
          // OPTIONAL public source-repository link, canonicalized.
          //
          // The key is OMITTED ENTIRELY when the author supplied none, rather than
          // written as `null`. That keeps the column out of the INSERT's column list.
          //
          // 🔴 IT DOES **NOT** MAKE THIS CREATE SAFE AGAINST AN UNAPPLIED MIGRATION, and
          // an earlier version of this comment claimed it did ("the column is simply
          // never mentioned"). Prisma returns the created row, so it emits
          // `INSERT … RETURNING <every scalar the MODEL declares>` — and `sourceRepoUrl`
          // is on the model. The generated SQL names `source_repo_url` regardless of
          // `data`, so this create raises P2022 on any database without the column.
          // Measured on the PR preview env: 5 smoke specs 500'd here, for authors who
          // supplied no link at all. The migration is therefore a HARD PRE-DEPLOY step —
          // see the header of 20260823120000_app_listing_source_repo/migration.sql.
          ...(sourceRepo && sourceRepo.ok ? { sourceRepoUrl: sourceRepo.url } : {}),
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
 * Load an OAuth client and assert it is eligible to back an external listing: it must
 * EXIST and NOT be an App-Block client (`isAppBlockOauthClientId` — those are managed
 * by the App Blocks flow, not hand-listed). By default it must also be OWNED by
 * `userId` (IDOR). Returns the client's `allowedScopes` ceiling. An external listing
 * does NOT require the client to be `isVerified` (decision Q4). All failures are
 * friendly TRPCErrors (parity with `submitExternalListing`'s validation style).
 *
 * `isModerator`: when true, the owner-only check is BYPASSED — a moderator may link
 * ANY (non-App-Block) OAuth client, mirroring the mod-only GLOBAL client search that
 * feeds the external-submit picker (`oauthClient.searchForModerator`). This ONLY
 * relaxes ownership: the App-Block exclusion (for everyone) and the existence check
 * still hold. A non-moderator stays restricted to their own clients.
 */
export async function loadConnectClientForListing(
  connectClientId: string,
  userId: number,
  isModerator = false
): Promise<{ id: string; allowedScopes: number }> {
  // App-block clients are excluded up-front (cheap, no DB) — they are never a
  // hand-authored connect target. This exclusion holds for EVERYONE, mods included.
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
  // Owner-only — BYPASSED for a moderator (who can pick any client via the mod-only
  // global search). A non-mod picking a client they don't own is still FORBIDDEN.
  if (!isModerator && client.userId !== userId) {
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
 *
 * `isModerator`: when true, that owner re-assertion is intentionally BYPASSED — a mod
 * may edit a listing that links a client they don't own (mirroring the mod-only
 * client search on submit). The existence check + scope-subset / justification
 * validation (server-authoritative snapshot from the client's CURRENT allowedScopes)
 * are UNCHANGED. A non-mod is still refused a foreign client.
 */
export async function deriveScopePatch(opts: {
  connectClientId: string | null;
  patch: UpdateListingPatch;
  userId: number;
  isModerator?: boolean;
}): Promise<{ effectivePatch: UpdateListingPatch; connectAllowedScopes: number | null }> {
  const { connectClientId, patch, userId, isModerator = false } = opts;
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
  // Owner re-assertion — BYPASSED for a moderator (the post-submit transfer guard is
  // intentionally skipped for mods, who may link any client). Non-mods still refused.
  if (!isModerator && client.userId !== userId) {
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
 *
 * 🔴 RETURNS WHAT IT DID, because the two outcomes are not equally reversible and the
 * caller was announcing them with one sentence. Withdrawing a first-time submission
 * (`'deleted'`) throws away a draft. Withdrawing the review of a FORMERLY-LIVE listing
 * (`'removed'`) leaves it `removed` behind a `delist` event, which `republishOwnListing`'s
 * last-event guard reads as a moderator takedown — so the owner cannot put it back and a
 * moderator must `relistListing`. That is deliberate (see `closeTerminalListing`), but
 * "Submission withdrawn." is not an honest description of it, so the outcome is surfaced
 * and the UI says which one happened.
 */
export type WithdrawExternalRequestResult = { outcome: CloseTerminalListingOutcome };

export async function withdrawExternalRequest(opts: {
  publishRequestId: string;
  userId: number;
}): Promise<WithdrawExternalRequestResult> {
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
  // Already withdrawn — idempotent success. `'none'` rather than a remembered outcome:
  // this call did nothing, and the UI must not narrate someone else's close as its own.
  if (row.status === 'withdrawn') return { outcome: 'none' };
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
    if (count === 0) return null;
    return await closeTerminalListing(tx, row.appListingId, {
      actorUserId: userId,
      reason: null,
    });
  });
  if (flipped !== null) {
    return { outcome: flipped };
  }

  // Raced: re-read from the PRIMARY (a replica read could be lag-stale and still
  // report `pending`) to decide the authoritative outcome.
  const after = await dbWrite.appListingPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { status: true },
  });
  if (!after || after.status === 'withdrawn') {
    // Raced into withdrawn (or vanished) → idempotent success. The concurrent
    // withdraw owns the draft cleanup, so we do NOT re-delete here — and it owns the
    // outcome too, so this call reports `'none'`.
    return { outcome: 'none' };
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
 *                 formerly-live `pending` listing is in review — mod-mandated, or (since
 *                 the owner-republish asset-change gate) owner-initiated — and an owner
 *                 who withdraws a re-review must NOT be able to self-restore, so `delist`
 *                 makes the last event a takedown: `republishOwnListing` FORBIDS the owner
 *                 and a mod must relist. Written UNCONDITIONALLY for both; see the
 *                 in-branch note. (This replaced a most-recent-event probe that an
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
    // WHY the pending branch is written unconditionally: a first-time submission is
    // `draft` (handled by the branch above → deleted) and a revision is a `draft` shadow
    // (also the `draft` branch), so reaching here means a formerly-LIVE listing was
    // bounced back to review — and an owner withdrawing a re-review must NOT be able to
    // self-restore the pre-reset content with no re-review.
    //
    // 🔴 THE WRITER SET IS NO LONGER ONLY THE TWO MOD RESET FNS, and this comment used to
    // say it was. `republishOwnListing`'s ASSET-CHANGE REVIEW GATE
    // (`offsite-moderation.service`) also writes `pending` on a formerly-live listing:
    // when an owner republishes a listing whose assets changed since the last approval, it
    // routes to review instead of going live. So this branch can now close an
    // OWNER-INITIATED review as well as a mod-mandated one, and it treats both the same —
    // `delist`, i.e. the owner must ask a moderator to relist rather than self-restoring.
    // For the mod-mandated case that is the point. For the owner-initiated case it is a
    // deliberate FAIL-CLOSED choice, not an oversight: distinguishing them means
    // re-introducing a most-recent-event probe here, and the last one was removed because
    // it was exploitable (below). Nothing unreviewed reaches the store either way; the
    // cost is that an owner who withdraws their own re-review needs a moderator.
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
//   removed          → SPLIT BY THE LAST STATUS-CHANGING MODERATION EVENT. A moderator
//                      takedown stays FORBIDDEN. An OWNER self-unpublish
//                      (`owner-unpublish`) is a REPAIR state: TRIVIAL fields edit in
//                      place; any MATERIAL change is REFUSED (MATERIAL_CHANGE_BLOCKED)
//                      — republish first, then edit through the shadow path, which is
//                      the only route back into review.
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
 *
 * `sourceRepoUrl` is MATERIAL for the same reason `externalUrl` is: it is an OUTBOUND
 * LINK rendered on a public store page, and the moderator approved a specific
 * destination. The host allowlist bounds where it can point but not what is THERE —
 * a repo can be replaced, renamed or transferred — so a change re-enters review
 * rather than going live silently. Like `externalUrl` it compares against the
 * validator's CANONICAL form, so re-saving `…/a/b` as `…/a/b.git` is correctly seen
 * as no change and does not cost a pointless mod re-review.
 *
 * 🔴 THE LIST ITSELF NOW LIVES IN `shared/`, and this is an ALIAS of it — not a copy. The
 * EDIT FORM has to disable exactly these inputs while a listing is unpublished (the
 * `removed` branch below refuses them with `MATERIAL_CHANGE_BLOCKED`), and it cannot import
 * this module: `offsite-listing.service` top-level-imports `~/server/db/client`, so reading
 * the list from here would drag Prisma into the browser bundle. A second literal in the
 * component is how the form starts offering a field the server refuses. See
 * {@link MATERIAL_LISTING_PATCH_FIELDS}.
 */
const MATERIAL_PATCH_FIELDS = MATERIAL_LISTING_PATCH_FIELDS;

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
  opts: {
    /**
     * The connect client's `allowedScopes` ceiling (from the listing's
     * `connectClientId`). REQUIRED when the patch touches `requestedScopes` /
     * `scopeJustifications` — the caller (`updateListing`) resolves it once and
     * passes it in. `null` means the listing has no connect client, so a scope edit
     * is rejected.
     */
    connectAllowedScopes?: number | null;
    /**
     * Whether the MANUAL-APPLY `app_listings.source_repo_url` column actually exists,
     * from the caller's guarded read (`EditableListing.sourceRepoAvailable`).
     *
     * 🔴 REQUIRED, AND `opts` IS NO LONGER OPTIONAL, PRECISELY SO A NEW CALL SITE
     * CANNOT FORGET IT. This function is the single place every off-site scalar edit
     * funnels through — `updateListing`'s three branches and `updateRevisionDraft` —
     * and the first version of this feature took no availability parameter at all, so
     * every one of those four paths wrote the column unconditionally and 500'd with a
     * P2022 naming a database column. A defaulted parameter would have re-created that
     * silently; a required one makes the compiler ask the question at each call site.
     * At runtime an absent value is read as `false` (fail CLOSED — a refusal the author
     * can act on beats a 500 they cannot).
     */
    sourceRepoAvailable: boolean;
  }
): Prisma.AppListingUpdateInput {
  const data: Prisma.AppListingUpdateInput = {};
  if (patch.externalUrl !== undefined) {
    const url = validateExternalUrl(patch.externalUrl);
    if (!url.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: url.error });
    data.externalUrl = url.url;
  }
  // Public source-repository link. Follows this builder's established convention
  // exactly: an OMITTED key leaves the column untouched, an explicit `null` CLEARS it,
  // and a provided value is validated + stored NORMALISED (so the material-change
  // comparison below is against a canonical value).
  if (patch.sourceRepoUrl !== undefined) {
    // 🔴 THE COLUMN GATE COMES FIRST, before the value is even looked at. An explicit
    // `null` is as unwritable as a URL while the column is missing — Prisma raises the
    // same P2022 for `{sourceRepoUrl: null}` as for a value — so BOTH instructions have
    // to be refused, and refused with a message about the environment rather than about
    // the author's input. `opts?.` is deliberate belt-and-braces on a REQUIRED field:
    // absent reads as `false`, which refuses rather than 500s.
    assertSourceRepoWritable(opts?.sourceRepoAvailable === true);
    if (patch.sourceRepoUrl === null) {
      data.sourceRepoUrl = null;
    } else {
      const repo = validateRepositoryUrl(patch.sourceRepoUrl);
      if (!repo.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: repo.error });
      data.sourceRepoUrl = repo.url;
    }
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
 * The names of the MATERIAL fields this patch actually CHANGES relative to the live
 * listing — `[]` when the edit is trivial-only. `patchHasMaterialChange` is the boolean
 * view of this; the approved branch only needs the boolean, the `removed` branch needs the
 * NAMES so its refusal can tell the caller which key to drop.
 *
 * 🔴 ONE ITERATION OVER {@link MATERIAL_PATCH_FIELDS}, and the two callers read the SAME
 * answer. The `removed` branch could have re-listed the fields it wants to block; a second
 * copy of that list is how `sourceRepoUrl` (added to the set later than the rest) would get
 * blocked on one path and waved through on the other.
 *
 * `externalUrl`/`sourceRepoUrl` compare against the validator's CANONICAL form, the rest
 * are plain scalar inequality.
 */
function materialPatchChanges(
  patch: UpdateListingPatch,
  live: {
    externalUrl: string | null;
    name: string;
    contentRating: string | null;
    sourceRepoUrl: string | null;
    connectRequestedScopes: number | null;
  }
): string[] {
  const changed: string[] = [];
  for (const field of MATERIAL_PATCH_FIELDS) {
    const patched = patch[field];
    if (patched === undefined) continue;
    if (field === 'externalUrl') {
      const url = validateExternalUrl(patched);
      // An invalid URL is a material change (it will be rejected downstream, but
      // it is not "unchanged").
      if (!url.ok || url.url !== live.externalUrl) changed.push(field);
      continue;
    }
    if (field === 'sourceRepoUrl') {
      // 🔴 COMPARED IN CANONICAL FORM, not as a raw string — the same treatment
      // `externalUrl` gets one branch up, and for a sharper reason. The author edits
      // this in a text box, so `https://github.com/a/b`, `…/a/b/` and `…/a/b.git` all
      // arrive from an author who changed NOTHING. Plain inequality would route each of
      // those onto a shadow revision and back into the moderator queue, which is both
      // noise for the mod and a needless "pending re-review" banner for the author.
      if (patched === null) {
        // An explicit CLEAR is material iff there was something to clear.
        if (live.sourceRepoUrl !== null) changed.push(field);
        continue;
      }
      const repo = validateRepositoryUrl(patched);
      // An invalid value is material (rejected downstream, but not "unchanged") —
      // mirrors the externalUrl branch, so an author cannot slip an unreviewed value
      // through the trivial in-place path by making it malformed.
      if (!repo.ok || repo.url !== live.sourceRepoUrl) changed.push(field);
      continue;
    }
    // name / contentRating: plain scalar inequality vs the live value.
    if (patched !== live[field]) changed.push(field);
  }
  // A change to the DISCLOSED OAuth scope subset is material — the mod approved a
  // specific set of scopes, so a new set must re-enter review (the shadow carries the
  // updated mask + justifications, re-validated in buildListingPatchData).
  if (
    patch.requestedScopes !== undefined &&
    patch.requestedScopes !== (live.connectRequestedScopes ?? 0)
  ) {
    changed.push('requestedScopes');
  }
  return changed;
}

/**
 * True iff the patch changes a MATERIAL field (see MATERIAL_PATCH_FIELDS) to a
 * value DIFFERENT from the live listing. The boolean view of
 * {@link materialPatchChanges}.
 */
function patchHasMaterialChange(
  patch: UpdateListingPatch,
  live: Parameters<typeof materialPatchChanges>[1]
): boolean {
  return materialPatchChanges(patch, live).length > 0;
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
  /**
   * The CALLER's role on this listing, as resolved by the access gate in
   * {@link loadOwnedEditableListing} — never `null`, because a null role throws there.
   *
   * 🔴 NOT THE SAME THING AS `userId` BELOW, and conflating them is the bug this exists to
   * prevent. `userId` is the listing's denormalized OWNER column; `callerRole` is who the
   * CALLER is relative to this row. They differ for every accepted editor seat.
   */
  callerRole: AppRole;
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
  /**
   * The public source-repository link, resolved SEPARATELY from the select below.
   *
   * 🔴 IT IS DELIBERATELY NOT IN `editableListingSelect`. `source_repo_url` is a
   * MANUAL-APPLY column, so naming it in that select would make every author edit and
   * every `beginListingRevision` throw P2022 until a human runs the migration —
   * breaking two pre-existing flows for an additive field. `loadOwnedEditableListing`
   * fills it via the guarded `readListingSourceRepoUrl` instead.
   */
  sourceRepoUrl: string | null;
  /** See {@link ListingSourceRepoRead.available} — `false` ⇒ never write the column. */
  sourceRepoAvailable: boolean;
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

/**
 * The caller's role on this listing — `'owner'`, `'editor'`, or `null` for no access.
 *
 * 🔴 THE WHOLE GATE, not just its collaborator half. Every author gate in this file
 * asks THIS, never `listing.userId !== userId`, because that column is a DENORMALIZED
 * copy of the owner for an ON-SITE listing — the canonical owner is the backing
 * `AppBlock.app.userId`. Comparing against the copy inverts the gate in BOTH directions
 * on a drifted row: it refuses the real owner and admits whoever the stale row names.
 * `resolveListingAccess` resolves the owner KIND-AWARE (the block's `OauthClient.userId`
 * for an onsite listing; the PARENT listing's own column for an offsite one, even when it
 * carries a block — issue #3844), hops a shadow revision to its parent, and answers the
 * seat question in the same call.
 *
 * 🔴 WHERE THE DRIFT ACTUALLY COMES FROM — a SHADOW REVISION, and this is worth stating
 * precisely because an earlier version of this comment named the wrong mechanism and
 * would have sent the next maintainer to the wrong file. {@link beginListingRevision}
 * clones the parent with `userId: parent.userId`; `acceptTransfer` step 3 updates ONLY
 * `{ id: <the transferred listing> }` and never that listing's shadows, and
 * {@link applyApprovedRevision} never copies `userId` back onto the parent. So a shadow
 * that outlives a transfer keeps the OLD owner FROZEN while its parent and the
 * `OauthClient` both name the new one. That is reachable on every path in this file that
 * can be handed a shadow id — `updateRevisionDraft` → {@link loadOwnedEditableListing},
 * and {@link submitListingRevision}, which takes nothing else.
 *
 * 🔴 NOT via `acceptTransfer`'s onsite listing write, which is what that earlier comment
 * claimed. That write is `where: { id }` — UNCONDITIONAL, in the same transaction as the
 * `OauthClient` move and after an in-tx read of the row through its own FK — so it HEALS
 * the parent's copy rather than drifting it, and a 0-count there would require the row to
 * be absent, which the pre-read precludes. There is no other in-app writer of
 * `OauthClient.userId`. The top-level row's copy therefore has no drift mechanism at all;
 * only clones of it do. (`getMyListingForApp` resolves its row by `appBlockId`/`slug`, so
 * it only ever sees a parent — it goes through this helper for uniformity, not because a
 * stale copy can reach it.)
 *
 * 🔴 IT COSTS ONE EXTRA READ ON THE OWNER PATH, deliberately. The bare comparison was
 * free for the owner because the row was already in hand — but "already in hand" is
 * exactly the stale copy. These are author EDIT paths (a handful of calls per editing
 * session), not a hot read, so correctness wins. The non-owner path costs the same as
 * before: it already resolved through here.
 *
 * Dynamic import: `app-access.service` is small and IO-only, but keeping the import
 * inside the body matches this file's existing discipline for cross-service reach
 * (`beginListingRevision`'s import of the asset service) and keeps the module graph of
 * a plain listing read unchanged.
 */
async function resolveListingRole(listingId: string, userId: number): Promise<AppRole | null> {
  const { resolveListingAccess } = await import('~/server/services/blocks/app-access.service');
  const access = await resolveListingAccess(listingId, userId);
  return access?.role ?? null;
}

/**
 * Load a listing and assert the caller may edit it: its OWNER or an ACCEPTED
 * collaborator ON THE LISTING (seats are listing-keyed since the re-key; the backing
 * AppBlock is not the seat key, and an off-site listing has none).
 *
 * 🔴 STILL NO MODERATOR OVERRIDE — unchanged, and deliberately different from
 * `app-listing-assets.service::loadOwnedListing`, which does bypass for mods. That
 * divergence between two sibling gates PREDATES collaborators; it was surfaced by
 * consolidating the predicate and is recorded in `app-access.call-site-ledger.test.ts`
 * rather than quietly normalised, because "make the mod bypass consistent" is a
 * behaviour change to the author edit path that deserves its own decision.
 *
 * 🔴 THE OWNER HALF IS `resolveListingRole`, NOT `listing.userId` — the row loaded here
 * carries the DENORMALIZED copy, which is stale-able for onsite. See
 * {@link resolveListingRole}.
 */
async function loadOwnedEditableListing(
  listingId: string,
  userId: number
): Promise<EditableListing> {
  const listing = (await dbRead.appListing.findUnique({
    where: { id: listingId },
    select: editableListingSelect,
  })) as Omit<EditableListing, 'sourceRepoUrl' | 'sourceRepoAvailable'> | null;
  if (!listing) {
    throw new OffsiteRequestError('NOT_FOUND', `listing ${listingId} not found`);
  }
  // 🔴 THE RESOLVED ROLE IS KEPT AND RETURNED, not merely null-checked — and note that
  // this function's NAME oversells its gate. It admits the OWNER *or* an accepted editor
  // seat (that is what `resolveListingRole` returns non-null for); "Owned" here means "you
  // hold a role on it", not "you own it". Callers that need to distinguish the two — the
  // repair-state copy does, because Republish is owner-only — read `callerRole` rather
  // than re-deriving it from a second read or from the session.
  const callerRole = await resolveListingRole(listingId, userId);
  if (callerRole === null) {
    throw new OffsiteRequestError('NOT_OWNED', 'you can only edit your own listings');
  }
  // Guarded second read for the MANUAL-APPLY `source_repo_url` column — see the
  // `sourceRepoUrl` field note on `EditableListing`. Costs one extra round trip on an
  // author edit path (a handful of calls per editing session, not a hot read); the
  // alternative is a select that 500s the whole edit flow until a human runs SQL.
  const sourceRepo: ListingSourceRepoRead = await readListingSourceRepoUrl(listingId, dbRead);
  return {
    ...listing,
    callerRole,
    sourceRepoUrl: sourceRepo.value,
    sourceRepoAvailable: sourceRepo.available,
  };
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
  /**
   * The caller's moderator status — threaded into `deriveScopePatch` so a mod editing
   * a listing that links a foreign OAuth client isn't blocked by the owner re-assertion
   * (mirrors the mod-only client search on submit). Listing OWNERSHIP is unaffected —
   * `loadOwnedEditableListing` still requires the caller to own the LISTING itself.
   */
  isModerator?: boolean;
}): Promise<UpdateListingResult> {
  const { listingId, patch, userId, isModerator = false } = opts;
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
    isModerator,
  });
  // 🔴 HOISTED ABOVE THE STATE ROUTING, for the same reason the scope validation above
  // is: the `approved` + material branch opens a SHADOW REVISION before it builds the
  // patch data, so a refusal raised inside `buildListingPatchData` would land AFTER
  // `beginListingRevision` has minted one — leaving the author an orphan revision draft
  // and their listing stuck in "pending re-review" for an edit that never applied.
  // Checked here, nothing has been written when it throws.
  //
  // `listing.sourceRepoAvailable` comes from the guarded read on the REPLICA. That is
  // the safe direction for a REFUSAL: DDL reaches the primary first, so a replica that
  // can see the column proves the primary can, and the only error this can make is a
  // transient false refusal during the seconds a freshly-applied `ALTER TABLE` takes to
  // replicate. The opposite mistake — believing a column the primary lacks — is the one
  // that 500s, and it is not reachable from this direction.
  if (effectivePatch.sourceRepoUrl !== undefined) {
    assertSourceRepoWritable(listing.sourceRepoAvailable);
  }
  const patchOpts = {
    connectAllowedScopes,
    sourceRepoAvailable: listing.sourceRepoAvailable,
  };

  switch (listing.status) {
    case 'removed': {
      // 🔴 `removed` IS TWO DIFFERENT STATES WEARING ONE STATUS STRING. An owner who
      // unpublished their own app to fix it up lands here, and so does a listing a
      // moderator took down; only the last moderation event separates them. Refusing both
      // meant the owner's "take it down, repair it, put it back" loop had no repair step.
      // See `app-listing-owner-unpublish` — PRIMARY read, `null` (no events) fails closed.
      //
      // 🔴 THE PREDICATE IS ABOUT THE LISTING, THE GATE ABOVE IS ABOUT THE CALLER, AND
      // THEY ARE DELIBERATELY DIFFERENT QUESTIONS. `readLastModerationAction` selects only
      // `action` — never `actorUserId` — so this asks "is this listing in owner-repair
      // state?", not "did YOU unpublish it?". `loadOwnedEditableListing` has already
      // admitted the OWNER **or an accepted collaborator** (`resolveListingRole`), so an
      // accepted seat-holder can make trivial edits here while the owner has the app down.
      //
      // That is INTENDED, not an oversight, and the reasoning is: (a) a seat-holder already
      // has exactly this power on `draft`, `pending` and `approved`, so refusing only in the
      // repair state would make "unpublish → fix your copy → republish" the one flow a team
      // cannot share — which is the flow most likely to need a second pair of hands; (b) the
      // seat is itself an authorization the OWNER granted and can revoke; and (c) with the
      // material-field refusal below, everything reachable here is copy. Note the asymmetry
      // this leaves standing on purpose: `unpublishOwnListing` and `republishOwnListing` are
      // OWNER-ONLY (`loadOwnedListingInTx`), so a collaborator can repair the copy but
      // cannot take the app down or put it back. Pinned by
      // `offsite-listing.owner-unpublish-editable.service.test.ts`.
      if (!(await isOwnerUnpublishedListing(dbWrite, listingId))) {
        throw new OffsiteRequestError(
          'FORBIDDEN',
          'this listing has been removed by a moderator and can no longer be edited'
        );
      }
      // 🔴 TRIVIAL FIELDS ONLY. A MATERIAL change is REFUSED here — it is NOT applied in
      // place, and it is NOT staged on a shadow.
      //
      // 🔴 WHY, and this corrects what this comment used to claim. The earlier version
      // asserted that "the go-live gates run on the way BACK UP — `republishOwnListing`
      // re-asserts scan-clean assets + off-site actionability — so an edit made while down
      // still cannot reach the store unreviewed." THAT IS FALSE, and it was the load-bearing
      // safety claim on this branch. Neither of those gates is a CONTENT review:
      // `assertListingAssetsScanCleanInTx` asks whether the images finished scanning, and
      // `assertOffsiteListingActionableInTx` asks whether an https destination exists AT
      // ALL — neither asks whether a MODERATOR ever approved the value now in the column.
      // So without this refusal an owner drives the whole loop themselves, no moderator
      // involved: `approved` → `unpublishOwnListing` (which requires `approved`) → patch
      // `externalUrl` in place here → `republishOwnListing` → `approved` again, and the
      // store's destination URL has been swapped after approval. `contentRating` is the
      // same shape and worse: it drives the public SFW filter, and nothing on the republish
      // path re-derives a rating floor. Both are reachable today through the
      // `appListings.updateListing` tRPC mutation and by CLI token under
      // `TokenScope.AppBlocksSubmit`; "there is no UI button" is not a gate.
      //
      // 🔴 WHY REFUSE RATHER THAN ROUTE TO A SHADOW. The shadow mechanism is defined for a
      // parent that STAYS LIVE while its replacement is reviewed — `beginListingRevision`
      // refuses any parent that is not `approved`, and `applyApprovedRevision` copies the
      // shadow onto a live parent on approve. A `removed` parent has no live copy to
      // protect and no defined post-approval status, so routing here would mean widening
      // the revision state machine (and deciding whether approving a revision of an
      // unpublished listing silently republishes it — a moderator action nobody asked for).
      // Refusing keeps ONE way for a material change to reach the store: through review of
      // a live listing. The author's path is stated in the message.
      //
      // The feature this branch exists for is untouched: `tagline`, `description` and
      // `category` are not material, so "unpublish → fix your copy → republish" still works.
      const material = materialPatchChanges(effectivePatch, {
        externalUrl: listing.externalUrl,
        name: listing.name,
        contentRating: listing.contentRating,
        sourceRepoUrl: listing.sourceRepoUrl,
        connectRequestedScopes: listing.connectRequestedScopes,
      });
      if (material.length > 0) {
        throw new OffsiteRequestError(
          'MATERIAL_CHANGE_BLOCKED',
          `${material.join(', ')} cannot be changed while this listing is unpublished, ` +
            `because that change needs moderator review and an unpublished listing has no ` +
            `way to reach it. Republish the listing first, then edit ` +
            `${material.length > 1 ? 'those fields' : 'that field'} — the edit will be ` +
            `staged for review. Tagline, description and category can be edited now.`
        );
      }
      // Everything left is trivial, so edit IN PLACE exactly like draft/pending: the
      // listing is not being served, so there is nothing live to protect with a shadow
      // revision. Any material key still present in the patch is byte-identical to the live
      // value (`material` is empty), so writing it is a harmless no-op — the same argument
      // the `approved` trivial-only branch makes.
      const data = buildListingPatchData(effectivePatch, patchOpts);
      await dbWrite.appListing.update({ where: { id: listingId }, data });
      return { listingId, status: listing.status, requiresReview: false, shadowId: null };
    }
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
        sourceRepoUrl: listing.sourceRepoUrl,
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
    throw new OffsiteRequestError('INVALID_REVISION', 'cannot open a revision of a revision draft');
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

  // 🔴 RE-READ THE SOURCE REPO ON THE **PRIMARY**, not from `parent` (which came off the
  // REPLICA via `loadOwnedEditableListing`). The two clients can disagree about this
  // column for a few seconds after the manual `ALTER TABLE`, and the disagreement DELETES
  // DATA in exactly one direction: clone-time reads the replica and sees "unavailable",
  // so the shadow is created WITHOUT the column; apply-time reads the primary
  // (`applyApprovedRevision`, inside its own tx) and sees "available", so the fragment
  // emits `{sourceRepoUrl: null}` and the approve wipes the parent's live public link —
  // no error, no moderator-visible diff, the link simply gone.
  //
  // Reading on the primary makes both ends of the round trip ask the SAME database, so
  // the pair is consistent by construction rather than by luck of replication timing.
  // It costs one query on a path that already runs a transaction, and only when a shadow
  // is actually being minted (the idempotent-reuse return above is ahead of it).
  const parentSourceRepo = await readListingSourceRepoUrl(listingId, dbWrite);

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
          // 🔴 CARRIED ONTO THE SHADOW, or a revision that does NOT touch the source
          // link would silently CLEAR it on approve — `applyApprovedRevision` copies the
          // shadow's value onto the parent unconditionally, so an uncopied column here
          // becomes a deletion there. Same reasoning as `connectRequestedScopes` below.
          // Omitted entirely (not null) when the manual-apply column is unreadable, so
          // opening a revision keeps working before the migration lands.
          //
          // 🔴 FROM THE PRIMARY READ ABOVE, NOT FROM `parent` — see that comment. A
          // replica-sourced `available: false` paired with a primary-sourced
          // `available: true` at apply time is what silently clears a live link.
          ...sourceRepoWriteFragment(parentSourceRepo),
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
          data: shots.map(
            (s: { imageId: number | null; order: number; caption: string | null }) => ({
              id: newAppListingScreenshotId(),
              appListingId: shadowId,
              imageId: s.imageId,
              order: s.order,
              caption: s.caption,
            })
          ),
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
  })) as {
    id: string;
    kind: string;
    status: string;
    userId: number;
    revisionOfId: string | null;
    externalUrl: string | null;
    iconId: number | null;
    coverId: number | null;
    revisionOf: { slug: string; status: string } | null;
  } | null;

  if (!shadow) {
    throw new OffsiteRequestError('NOT_FOUND', `revision draft ${shadowId} not found`);
  }
  // Owner OR an ACCEPTED collaborator, resolved from the SHADOW id — {@link
  // resolveListingRole} hops to the parent, which is where both the seat and the
  // canonical owner live.
  //
  // 🔴 A shadow is the WORST row to read `userId` off, and it is where the drift is
  // actually MINTED rather than merely inherited. `beginListingRevision` clones with
  // `userId: parent.userId`, and nothing ever revisits that clone: an ownership transfer
  // updates only the parent row (`where: { id }`), and the revision-apply copies assets
  // back, never `userId`. So the bare equality was wrong twice over — it refused an
  // editor on their own shadow (the clone names the parent owner, not them) AND, on any
  // shadow that outlives a transfer of its parent, it named an owner who had already
  // been replaced, refusing the new owner and admitting the old one.
  if ((await resolveListingRole(shadowId, userId)) === null) {
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

  // Publish FLOOR gate (icon+cover required; screenshots optional) — authoritative
  // on the primary (the asset mutators write to dbWrite, so a replica count could be
  // stale under lag). screenshotCount is still computed for the arg shape but the
  // floor helper ignores it. + URL re-validate.
  const screenshotCount = await dbWrite.appListingScreenshot.count({
    where: { appListingId: shadowId, imageId: { not: null } },
  });
  assertListingMeetsFloor({
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
  /**
   * The public source-repository link. `null` for "not set" AND (indistinguishably, on
   * purpose) while the manual-apply column is absent: to the FORM those are the same
   * state — an empty input — and the form's diff only emits the field when the author
   * types into it, so an unreadable column cannot cause a spurious write.
   */
  sourceRepoUrl: string | null;
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
  /**
   * The listing's KIND. 🔴 Additive OUTPUT field (no input schema is touched), and the
   * edit form branches on it: an ON-SITE listing must not be offered the App URL step or
   * the OAuth-scope disclosure, and `buildScalarPatch` refuses to emit `externalUrl` for
   * it. Needed because the canonical authoring page now opens on the DETAILS tab, which
   * routes on-site owners into this form for the first time.
   */
  kind: string;
  /** The LIVE (parent) listing id — always the caller's edit target identity. */
  parentId: string;
  /** The parent's PUBLIC slug — immutable in edit mode (identity/URL). */
  slug: string;
  /** The parent's status (draft | pending | approved). */
  status: string;
  /**
   * The CALLER's role on this listing — `owner` or an accepted `editor` seat.
   *
   * 🔴 SAME REASON AS `GetMyListingForAppResult.role`, AND THE SAME MISREADING TO CORRECT.
   * `loadOwnedEditableListing` is named for ownership but gates on
   * `resolveListingRole(...) === null`, so an accepted editor reaches this prefill. The
   * unpublished-state copy (`materialEditBlockedReason`) tells the caller to "republish the
   * app from the Publishing tab" — owner-only in `editorTabsFor`, so for an editor that is
   * an instruction they cannot follow. The role is resolved by the gate anyway; returning
   * it is what lets the copy say the true thing to each.
   */
  role: AppRole;
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
 *  snapshot for edit prefill.
 *
 * 🔴 READ-AFTER-WRITE: defaults to the REPLICA (`dbRead`) — correct only for a row that
 * was written long ago. A caller reading a SHADOW revision MUST pass `dbWrite`.
 *
 * The predicate is "is the target a shadow?", NOT "did I just create it".
 * `beginListingRevision(...).created === false` means only that *this* call did not do
 * the INSERT — it says NOTHING about whether the replica has the row. The shadow is
 * minted on the PRIMARY by whoever got there first, and in this flow that is routinely
 * microseconds earlier and in a DIFFERENT request: the media editor fires its own
 * client-side `beginListingRevision` mutation on mount, `getMyListingForEdit` mints one
 * for the same parent, a second tab does either. So a `created === false` read off the
 * replica misses under lag exactly like a `created === true` one: the `findUnique`
 * returns null, this throws NOT_FOUND → tRPC NOT_FOUND → the editor renders
 * `<NotFound />` (its query has `retry: false`), discarding the whole editor including
 * any in-flight upload. Because the client invalidates on every asset mutation, that is
 * once per mutation, not once per page load.
 *
 * Same hazard the screenshot re-pack guards against in `app-listing-assets.service.ts`.
 * Do NOT route a non-shadow (in-place draft/pending) read to the primary. */
async function loadListingEditView(
  listingId: string,
  db: typeof dbRead = dbRead
): Promise<{
  scalars: ListingEditScalars;
  assets: GetMyListingForEditResult['assets'];
  connectRequestedScopes: number | null;
  connectScopeJustifications: Record<string, string> | null;
}> {
  const { getEdgeUrl } = await import('~/client-utils/edge-url');
  // Guarded, SEPARATE read of the manual-apply `source_repo_url` column — never added
  // to the select below, which would 500 the whole author edit-prefill page until a
  // human runs the migration. Degrades to null; see app-listing-source-repo.service.
  const sourceRepo = await readListingSourceRepoUrl(listingId, db);
  const row = (await db.appListing.findUnique({
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
      sourceRepoUrl: sourceRepo.value,
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
 * (draft/pending/approved; rejected → MUST_RESUBMIT; removed → editable ONLY when the
 * owner unpublished it themselves, else FORBIDDEN; an internal shadow →
 * INVALID_REVISION), and returns the prefill scalars +
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
    case 'removed': {
      // 🔴 Same two-states-one-string branch as `updateListing` — the prefill read has to
      // agree with the write path it prefills, or the owner gets an editor they are then
      // refused by. `app-listing-owner-unpublish` is the single spelling of the predicate.
      const lastAction = await readLastModerationAction(dbWrite, listingId);
      if (!isOwnerUnpublishAction(lastAction)) {
        throw new OffsiteRequestError(
          'FORBIDDEN',
          'this listing has been removed by a moderator and can no longer be edited'
        );
      }
      break;
    }
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
        // Onsite media revisions are kind:'onsite'; widen so the onsite "revision in
        // review" badge resolves (the probe is already scoped to this parent's shadows).
        kind: { in: [...REVIEWABLE_LISTING_KINDS] },
        appListing: { revisionOfId: listingId },
      },
      select: { id: true },
    });
    hasPendingRevision = !!pendingRevisionReq;
  }

  // 🔴 READ-AFTER-WRITE — same rule as `getMyListingForApp`: a SHADOW target is read
  // from the PRIMARY (it may have been minted microseconds ago by ANY caller), an
  // in-place target from the replica. See `loadListingEditView`.
  const view = await loadListingEditView(effectiveId, effectiveId !== listingId ? dbWrite : dbRead);

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
    kind: listing.kind,
    slug: listing.slug,
    status: listing.status,
    role: listing.callerRole,
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

export type GetMyListingForAppResult = {
  /** The backing `AppListing.id` — the target for `beginListingRevision` + the owner asset procs. */
  appListingId: string;
  /** The listing's TRUE lifecycle status (`draft|pending|approved|rejected|removed`). */
  status: string;
  /**
   * The CALLER's role on this listing — `owner` or an accepted `editor` seat.
   *
   * 🔴 THIS PROC HAS NEVER BEEN OWNER-ONLY, and the media editor's copy assumed it was.
   * The gate below is `resolveListingRole(...) === null`, which admits an accepted
   * collaborator; the role it resolves was then thrown away. So `ListingMediaEditor` had no
   * way to tell the two apart and told an editor "you unpublished it" and "republish it
   * from the Publishing tab" — a thing they did not do, and a tab `editorTabsFor` does not
   * give them (`publishing` is owner-only). Returning the role the gate ALREADY computes is
   * what lets the copy be true for both, without a second access read and without the
   * component guessing from the session.
   */
  role: AppRole;
  /** The listing's stored content rating (drives the asset NSFW-scan threshold). */
  contentRating: string;
  /** Whether a shadow-revision publish request is already under review for this listing. */
  hasPendingRevision: boolean;
  /**
   * The in-progress SHADOW revision id for an APPROVED parent (resolved server-side,
   * idempotently — the same id the client's `beginListingRevision` returns), else
   * `null`. Mirrors `GetMyListingForEditResult.shadowId`.
   */
  shadowId: string | null;
  /**
   * The id the client hands to the asset procs: `shadowId` when a shadow already
   * exists, else `appListingId`. Under LAZY shadow creation the first asset mutation
   * on an approved parent arrives carrying the PARENT id — the asset service mints the
   * shadow and re-targets (and re-maps screenshot row ids) server-side. See
   * `resolveOwnerAssetEditTarget` in `app-listing-assets.service`.
   */
  editTargetId: string;
  /**
   * Non-null when this listing's media CANNOT be edited at all (`removed` / `rejected`
   * / the row is itself an internal shadow). The editor renders it as its inline alert
   * instead of mounting the asset step — the same surface the client's on-mount
   * `beginListingRevision` used to produce via `INVALID_REVISION`. `null` for every
   * editable listing (`draft` / `pending` edited in place; `approved` via a revision).
   */
  editBlockedReason: string | null;
  /**
   * The EDITABLE target's current assets, edge-resolved — icon / cover / screenshots.
   *
   * 🔴 These are the assets of the EFFECTIVE edit target: the SHADOW's rows when a
   * shadow EXISTS, the listing's own rows otherwise. NEVER the live parent's rows
   * when a shadow exists — the media editor mutates + floor-checks exactly what it
   * is handed, so returning the parent's `AppListingScreenshot` ids alongside a live
   * shadow would let a "remove screenshot" delete a row from the LIVE served listing,
   * bypassing moderator review. Same rule as `getMyListingForEdit`.
   *
   * 🔴 Under LAZY creation an approved parent with NO shadow yet projects the PARENT's
   * rows — which IS the hazard above, so it is contained on the WRITE side: every
   * screenshot proc re-maps a parent row id onto the freshly-minted shadow's clone
   * before mutating, and `assertOwnerAssetEditable` fires (fail-closed) if that re-map
   * ever hands back the parent. See `resolveOwnerAssetEditTarget`.
   */
  assets: {
    icon: ListingEditAsset;
    cover: ListingEditAsset;
    screenshots: ListingEditScreenshot[];
  };
};

/**
 * OWNER: resolve the caller's OWN listing for a listing-media surface. TWO selectors,
 * and `appBlockId` WINS: the backing `appBlockId` (`AppListing.appBlockId` is `@unique`)
 * is tried first, and the slug arm runs only when that lookup MISSED or no `appBlockId`
 * was supplied — so passing both a block id and a slug that name DIFFERENT listings
 * returns the `appBlockId` one. At least one of the two must be given (enforced by the
 * schema's `.refine`).
 *
 * The slug arm resolves ANY TOP-LEVEL listing — either `kind`, any `status`, with or
 * without a backing `appBlockId` — narrowed only by `revisionOfId: null`
 * (civitai/civitai#3984). It is deliberately NOT scoped to the W13 pre-approval draft it
 * was first written for; that shape is one member of the set, alongside an OFF-SITE
 * listing (which `appBlockId` cannot address, see the inline comment) and an approved
 * on-site listing whose caller only holds the slug. A `removed` / `rejected` listing
 * resolves too and comes back carrying an `editBlockedReason` instead of throwing, so
 * the surface renders the reason rather than a blank page.
 *
 * Returns the `AppListing.id` (the target the caller then passes to
 * `beginListingRevision` + the owner-gated asset procs), the listing's lifecycle
 * status + content rating, and whether a revision is already under review.
 * Owner-bound: a listing owned by another user → NOT_OWNED (→FORBIDDEN); no listing
 * row for the app → NOT_FOUND. Kind-agnostic (works for both on-site and off-site
 * listings — the on-site owner UI was the first caller).
 *
 * ALSO projects the EDITABLE target's current `assets` (+ its `shadowId`). Without
 * them the media editor had no way to see the icon/cover it is about to edit: it
 * rendered every slot as "none" and its publish-floor check (icon+cover attached)
 * could never be satisfied, so "Submit for review" stayed permanently disabled —
 * the whole on-site listing-media flow was uncompletable. The assets come from the
 * EFFECTIVE source: an approved parent's shadow WHEN ONE ALREADY EXISTS, else the
 * listing's own rows.
 *
 * 🔴 THIS IS A READ. It does NOT create a shadow. It used to call
 * `beginListingRevision`, so merely OPENING the media tab minted a `draft`
 * `AppListing` — measured on prod 2026-07-30: 7 shadows, 7/7 with
 * `updated_at == created_at` (never written since their clone tx), 6 of them minted
 * that day purely by page views, three 1.5 s apart; 78% of approved onsite parents
 * carried a shadow representing no edit, and they self-refilled on sight. A `.query`
 * must not write. The shadow is now minted LAZILY by the first asset MUTATION (see
 * `resolveOwnerAssetEditTarget` in `app-listing-assets.service`), so every shadow
 * that exists represents real work.
 */
export async function getMyListingForApp(opts: {
  appBlockId?: string;
  slug?: string;
  userId: number;
}): Promise<GetMyListingForAppResult> {
  const { appBlockId, slug, userId } = opts;
  // 🔴 `userId` is deliberately NOT selected. Nothing below reads it any more (the gate
  // is `resolveListingRole`), and leaving the denormalized owner column sitting next to
  // an access check is an invitation to compare against it again.
  const entrySelect = {
    id: true,
    status: true,
    contentRating: true,
    revisionOfId: true,
  } as const;
  let listing = appBlockId
    ? await dbRead.appListing.findUnique({
        where: { appBlockId },
        select: entrySelect,
      })
    : null;
  // SLUG fallback — 🔴 SECOND, and only on a MISS. `appBlockId` is the primary selector
  // and wins whenever it resolves; this arm runs when that lookup missed or when no
  // `appBlockId` was supplied. (Pinned: "appBlockId WINS over a slug naming a DIFFERENT
  // listing" in `offsite-listing.get-my-listing-for-app.service.test.ts`.) Two callers
  // need it:
  //   - (W13 draft-at-submit) a FIRST-version on-site app has no backing AppBlock yet,
  //     so its draft listing (minted at submit) has `appBlockId = NULL` and is only
  //     reachable BY SLUG while it is pending; and
  //   - any client whose ONLY handle is the slug — in particular an OFF-SITE listing,
  //     which in practice carries no AppBlock, so `appBlockId` cannot address it
  //     (civitai/civitai#3984).
  //
  // 🟡 "off-site ⇒ no AppBlock" is EMPIRICAL, NOT STRUCTURAL — do not restate it as
  // "never, ever". `AppListing.appBlockId` is "set for EVERY backfilled row — on-site
  // AND the #2821 off-site rows (both come from an AppBlock). It is NOT a kind
  // discriminator: discriminate on `kind`, never on appBlockId nullness"
  // (schema.full.prisma). Only a NATIVELY-created off-site listing leaves it NULL, and
  // `mapAppBlockToListing` can still mint `kind:'offsite'` + a non-null `appBlockId`.
  // That shape measured 0 rows in production on 2026-08-11 (see
  // `resolveAccessibleAppBlockIds` / `appListingEditorTabs.ts`), so today the slug is
  // the only handle every off-site listing has — but a backfilled class exists and the
  // widening below is correct either way: it admits the row on EITHER selector.
  //
  // 🔴 `revisionOfId: null` IS LOAD-BEARING, not decoration. `beginListingRevision`
  // mints a shadow with a synthetic `rev-<ulid>` slug that is never public but IS a
  // real row — `kind: parent.kind`, `appBlockId` NULL, status `draft`. For an ON-SITE
  // parent that is exactly the previous, apparently-narrower clause, so those shadows
  // matched it; a shadow of an OFF-SITE parent is `kind:'offsite'` and did not. Either
  // way, excluding revisions here is what makes the comment below ("only ever sees a
  // top-level parent") true by construction rather than by the accident that nobody
  // knows a shadow's slug — and it is now the ONLY clause standing between the widened
  // arm and every shadow in the table.
  //
  // `AppListing.slug` is `@unique` across BOTH kinds (schema.full.prisma), so this is
  // unambiguous without an index change. Owner-bound below (unchanged): a slug that
  // is not yours is refused by `resolveListingRole`, not by this `where`.
  if (!listing && slug) {
    listing = await dbRead.appListing.findFirst({
      where: { slug, revisionOfId: null },
      select: entrySelect,
    });
  }
  if (!listing) {
    throw new OffsiteRequestError(
      'NOT_FOUND',
      `no listing found for app ${appBlockId ?? slug ?? '(unspecified)'}`
    );
  }
  // Owner OR an ACCEPTED collaborator ON THE LISTING (the seat key since the re-key).
  // This is the media editor's entry read; an editor who cannot reach it cannot edit
  // anything. The owner half goes through {@link resolveListingRole} too, for UNIFORMITY
  // rather than because a stale copy can reach here: this read resolves its row by
  // `appBlockId`/`slug`, so it only ever sees a top-level parent, and a parent's copy has
  // no drift mechanism (see {@link resolveListingRole}). One spelling of the gate across
  // the file is the point — a second spelling is what drifts.
  //
  // 🟡 KNOWN, ACCEPTED: this re-reads the same row on the same pool, so a listing DELETED
  // between the two reads reports `NOT_OWNED` instead of `NOT_FOUND` (`resolveListingAccess`
  // returns null for a missing row, and null role is the refusal here). It is cosmetic —
  // the caller is refused either way, no capability turns on it — and the alternative is
  // to distinguish "no row" from "no role" in the shared resolver's return, which widens
  // it for every caller to improve one error string on a race with a moderator delete.
  // Written down rather than left as a puzzle for whoever next reads a NOT_OWNED in the
  // logs for a listing that no longer exists.
  // 🔴 KEEP THE RESOLVED ROLE — it is returned, not just null-checked. The copy in
  // `ListingMediaEditor` branches on it (an editor is not told they unpublished the app,
  // nor pointed at an owner-only Publishing tab). Discarding it here is what forced that
  // component to have no answer.
  const callerRole = await resolveListingRole(listing.id, userId);
  if (callerRole === null) {
    throw new OffsiteRequestError('NOT_OWNED', 'you can only manage your own listings');
  }
  // A pending revision REQUEST (not mere shadow existence) drives the "already
  // under review" notice — mirrors `getMyListingForEdit`. Kind-agnostic: a revision
  // request carries the parent listing's kind, so match on the shadow relation only.
  const pendingRevisionReq = await dbRead.appListingPublishRequest.findFirst({
    where: { status: 'pending', appListing: { revisionOfId: listing.id } },
    select: { id: true },
  });

  // Resolve the EFFECTIVE edit target before reading assets — WITHOUT creating one.
  // For an approved parent that is its shadow revision IF one already exists; a
  // non-approved listing (draft / pending) has no shadow and is edited in place.
  //
  // 🔴 The existence probe reads the PRIMARY, not the replica. The client invalidates
  // this query after EVERY asset mutation, and the FIRST such mutation is what mints
  // the shadow — so the very next call is a read-after-write on a row inserted
  // milliseconds ago. Missing it on a lagging replica would re-project the PARENT's
  // rows (and their screenshot row ids) right after the shadow started diverging.
  let effectiveId = listing.id;
  let shadowId: string | null = null;
  if (listing.status === 'approved' && listing.revisionOfId == null) {
    const existing = await dbWrite.appListing.findFirst({
      where: { revisionOfId: listing.id },
      select: { id: true },
    });
    if (existing) {
      shadowId = existing.id;
      effectiveId = existing.id;
    }
  }
  // 🔴 READ-AFTER-WRITE: read a SHADOW back from the PRIMARY — always. A shadow read
  // that misses on the replica throws NOT_FOUND → tRPC NOT_FOUND → `<NotFound />`
  // (`retry: false`), discarding the editor mid-upload. Every non-shadow target
  // (draft/pending edited in place, or an approved parent with no shadow yet) is old
  // and stays on the replica.
  const { assets } = await loadListingEditView(
    effectiveId,
    effectiveId !== listing.id ? dbWrite : dbRead
  );

  // 🔴 Only a `removed` listing needs this — it is the ONE status whose editability is not
  // decided by the status column alone (owner self-unpublish and moderator takedown both
  // write it). Gated on the status so the common path keeps its existing round-trip count.
  // PRIMARY, not the replica: see `readLastModerationAction` — a lagging replica can hide
  // a moderator's just-written `delist` behind the owner's older `owner-unpublish`, and
  // reading the primary can only err toward refusing.
  const ownerUnpublished =
    listing.status === 'removed' ? await isOwnerUnpublishedListing(dbWrite, listing.id) : false;

  return {
    appListingId: listing.id,
    status: listing.status,
    role: callerRole,
    // Nullable column; fall back to the safest rating so the asset step's scan
    // threshold is always defined.
    contentRating: listing.contentRating ?? 'g',
    hasPendingRevision: !!pendingRevisionReq,
    shadowId,
    editTargetId: effectiveId,
    editBlockedReason: listingMediaEditBlockedReason(listing, ownerUnpublished),
    assets,
  };
}

/**
 * Why this listing's MEDIA cannot be edited at all, or `null` when it can.
 *
 * The client used to learn this by firing `beginListingRevision` on mount and
 * rendering its `INVALID_REVISION` message inline — the only thing that stopped the
 * media editor mounting against a `removed` / `rejected` listing. Lazy creation
 * removes that call, so the verdict is computed here (read-only) and surfaced on the
 * read. Mirrors `updateListing`'s state routing: draft/pending edit in place,
 * approved edits through a revision, rejected → resubmit, removed → terminal UNLESS the
 * owner removed it themselves. An internal shadow (`revisionOfId != null`) is not a page
 * the owner addresses directly.
 *
 * 🔴 STILL PURE AND STILL SYNCHRONOUS — the one bit that `removed` cannot supply arrives
 * as an ARGUMENT rather than as a DB read inside this function. `status='removed'` is
 * written by both an owner self-unpublish and a moderator takedown, so answering
 * "editable?" needs the listing's last moderation action; making this function fetch that
 * itself would have made it `async` and DB-bound, and the reason it is exported at all is
 * that its branch table is unit-testable WITHOUT a DB. Its only caller already has the
 * listing loaded and is already `async`, so the read belongs there.
 *
 * 🔴 `ownerUnpublished` IS REQUIRED, NOT OPTIONAL-DEFAULTING-TO-FALSE. A default would be
 * the safe VALUE (refuse) but the wrong ERGONOMICS: a future caller could omit it and
 * silently reintroduce exactly the defect this parameter fixes, with nothing going red.
 * Required means every call site has to decide, out loud.
 *
 * Pure + exported so the branch table is unit-testable without a DB.
 */
export function listingMediaEditBlockedReason(
  listing: {
    status: string;
    revisionOfId: string | null;
  },
  /**
   * Did the OWNER take this listing down themselves (last moderation action ===
   * `owner-unpublish`)? Only consulted on `removed`. `false` on a moderator takedown AND
   * on a listing with no recorded events — see `app-listing-owner-unpublish`.
   */
  ownerUnpublished: boolean
): string | null {
  if (listing.revisionOfId != null) {
    return 'this listing is an internal revision draft and cannot be edited directly';
  }
  switch (listing.status) {
    case 'draft':
    case 'pending':
    case 'approved':
      return null;
    case 'rejected':
      return 'this listing was rejected; submit a new listing instead of editing it';
    case 'removed':
      // 🔴 The owner's OWN unpublish is a repair state, not a terminal one: they took the
      // app down to fix it, so the media editor mounts. A MODERATOR takedown stays
      // terminal — and keeps saying so, which for this caller is now only ever the true
      // attribution.
      //
      // 🔴 DO NOT RESTATE THE CLAIM THIS COMMENT USED TO MAKE. It said `republishOwnListing`
      // "re-runs the scan-clean + actionability go-live gates, so editing while it is down
      // cannot sneak anything past review". Those gates exist, but neither is a review:
      // `assertListingAssetsScanCleanInTx` asks whether the images finished scanning
      // without being `Blocked`, `assertOffsiteListingActionableInTx` asks whether an https
      // destination exists. Neither asks whether a moderator ever saw the current values.
      // What actually holds the line is per-surface: for SCALARS, `updateListing`'s
      // MATERIAL_CHANGE_BLOCKED refusal on this same state. For ASSETS — which is what this
      // verdict unblocks — `assertOwnerAssetEditable` refuses only an `approved` top-level
      // listing, so a `removed` listing has been directly asset-editable all along. This
      // verdict changes WHO IS TOLD WHAT, not what the asset procs permit.
      //
      // 🔴 THE LAST SENTENCE OF THAT PARAGRAPH USED TO SAY "`republishOwnListing` runs no
      // rating floor (`resolveListingRatingFloorInTx` is wired into the approve paths
      // only)". THAT HAS BEEN FALSE SINCE #4418 — republish derives and applies the
      // raise-only floor itself, on every arm — and it is the kind of false comment that
      // does damage rather than merely aging: it reads as a licence to skip the floor
      // anywhere else on the republish path, which is exactly the hole #4440 had to close
      // in `approveRequest`'s reset re-approve. The remaining "nothing reviews the assets"
      // half was true when written and is what #4440 closed: an asset change across an
      // owner unpublish/republish now re-enters the moderation queue.
      return ownerUnpublished
        ? null
        : 'this listing has been removed by a moderator and can no longer be edited';
    default:
      return `cannot edit a listing in status ${listing.status}`;
  }
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
  /**
   * The caller's moderator status — threaded into `deriveScopePatch` (same rationale
   * as `updateListing`): a mod editing a shadow whose parent links a foreign OAuth
   * client isn't blocked by the owner re-assertion. Listing OWNERSHIP unaffected.
   */
  isModerator?: boolean;
}): Promise<{ shadowId: string }> {
  const { shadowId, patch, userId, isModerator = false } = opts;
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
    isModerator,
  });
  // Same up-front column gate as `updateListing` — a shadow edit writes the same column
  // through the same builder, so an unapplied migration must refuse here too rather than
  // reach Prisma. (No shadow is opened on this path, so there is nothing to orphan; the
  // check is hoisted anyway to keep the two edit entry points reading identically.)
  if (effectivePatch.sourceRepoUrl !== undefined) {
    assertSourceRepoWritable(shadow.sourceRepoAvailable);
  }
  const data = buildListingPatchData(effectivePatch, {
    connectAllowedScopes,
    sourceRepoAvailable: shadow.sourceRepoAvailable,
  });
  await dbWrite.appListing.update({ where: { id: shadowId }, data });
  return { shadowId };
}

// ---------------------------------------------------------------------------
// Listing-request kinds surfaced by the CONSOLIDATION half of the flow
// (approve/reject + the mod review queue + my-submissions).
//
// 🔴 THERE ARE TWO PRODUCERS OF A `kind='onsite'` `AppListingPublishRequest`, and this
// comment used to name only one. The onsite CODE review still runs over a DIFFERENT
// table (`AppBlockPublishRequest`); what changed is that the LISTING table now carries
// on-site rows of two shapes:
//
//   1. `submitListingRevision` on an onsite SHADOW — a media revision, `revisionOfId`
//      SET on the target listing, the parent slug denormalized onto the request.
//   2. `routeRepublishToReviewInTx` (owner republish whose assets changed since the last
//      approval) — NON-SHADOW, `revisionOfId` NULL, targeting the live listing itself.
//
// So widening these gates from `'offsite'` to this set no longer surfaces "exactly onsite
// media revisions": it surfaces onsite media revisions AND onsite republish re-reviews.
// Both belong in the queue — the modal reads `request.appListingId` and is kind-agnostic —
// but any consumer that reasons "onsite request ⇒ shadow" is now wrong. Check
// `revisionOfId` when you need to tell them apart, never `kind`.
//
// The producer SET is pinned as a ledger in
// `src/server/services/blocks/__tests__/offsite-listing.onsite-revision.service.test.ts`
// (`LISTING_REQUEST_PRODUCERS`), which fails when it GROWS or SHRINKS — this sentence went
// stale precisely because nothing could notice a producer being added.
// ---------------------------------------------------------------------------
const REVIEWABLE_LISTING_KINDS = ['onsite', 'offsite'] as const;

// ---------------------------------------------------------------------------
// approveExternalRequest / rejectExternalRequest (moderator) — PR-b.
//
// Mirror the on-site `publish-request.service` approve/reject state machine over
// the `AppListingPublishRequest` + `AppListing` tables (no bundle / build /
// deploy). Approve flips the DRAFT listing → approved (the read path then
// surfaces it in the store); reject DELETES the draft (releases the slug). Both
// writes are status-guarded `updateMany`/`deleteMany` so a concurrent
// approve/reject/withdraw can never double-act (TOCTOU).
//
// ONSITE (assets-only media revision): an onsite app's `AppListing` is auto-created
// `approved`; its media (icon/cover/screenshots) is edited via the SAME shadow-draft
// revision flow, so an onsite request is always a revision (its listing's
// `revisionOfId != null`) and routes to `applyApprovedRevision`, which — for an
// onsite parent — copies ONLY the asset columns and leaves the manifest-governed
// scalars (name/tagline/description/category/contentRating) untouched. The offsite
// path is unchanged.
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
 * The ON-SITE counterpart of {@link resolveApprovalContentRating}, and the difference is
 * the whole reason it exists rather than being one more branch inside that function.
 *
 * 🔴 OFF-SITE: the rating IS the assets — a listing has no other content, so the derived
 * value REPLACES whatever was stored (`resolveApprovalContentRating` returns `derived`).
 * 🔴 ON-SITE: the rating belongs to the APP, not to its store card. It is manifest-declared
 * by the author and describes what the app DOES; its icon and cover are a strictly smaller
 * surface. Replacing it with an asset-derived value would LOWER a `pg13` app to `g` because
 * its store art happens to be tame — an under-rating of the runtime, produced by looking at
 * a picture. So the app's declaration is a FLOOR that is raised by mature media and never
 * lowered by tame media: exactly {@link resolveListingRatingFloorInTx}, the same helper
 * `approveRequest`'s draft→approved transition and `republishOwnListing` use, so all three
 * on-site rating sites have ONE spelling.
 *
 * A moderator override may still RAISE above the floor (a mod may always rate up) and is
 * ignored when it would lower.
 *
 * 🔴 NOT quite "the same discipline as the off-site clamp above" — that sentence used to
 * live here and it is inaccurate AT EQUAL LEVEL, which is a reachable case rather than a
 * pedantic one. `nsfwLevelFromContentRating` maps BOTH `'g'` and `'pg'` to
 * `NsfwLevel.PG`, so the two ratings are indistinguishable to these comparisons. Off-site
 * asks `override < derived ? derived : override` and therefore returns the OVERRIDE on a
 * tie; on-site asks `override > floored ? override : floored` and returns the FLOOR. So a
 * moderator who explicitly picks `'pg'` for a `'g'`-declared app has that choice honoured
 * off-site and silently dropped on-site.
 *
 * Left as-is deliberately: the two values carry the SAME maturity ceiling, so nothing
 * about who can see the listing changes — the divergence is which LABEL is stored, and
 * deciding that a tie-breaking override should overwrite an author's declaration is a
 * product call, not a safety fix to make in passing. Recorded here so the next reader
 * does not infer symmetry that is not there.
 */
async function resolveOnsiteApprovalContentRating(
  tx: Prisma.TransactionClient,
  args: {
    appListingId: string;
    declared: string | null;
    override?: OffsiteContentRating | null;
  }
): Promise<string | null> {
  const floored = await resolveListingRatingFloorInTx(tx, args.appListingId, args.declared);
  const override = args.override ?? null;
  if (override == null) return floored;
  return nsfwLevelFromContentRating(override) > nsfwLevelFromContentRating(floored)
    ? override
    : floored;
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
 *   1. {@link assertListingMeetsFloor} — the publish FLOOR gate. Approve FAILS
 *      `BAD_REQUEST { missing }` unless the draft has an icon AND a cover.
 *      Screenshots are OPTIONAL (a listing can go live with icon+cover and add
 *      screenshots later); still-missing screenshots surface as advisory
 *      incompleteness, never a block. This relaxed the former full-completeness
 *      gate (which additionally required ≥1 screenshot) down to the floor.
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
  // Accept onsite media revisions too (assets-only apply; see REVIEWABLE_LISTING_KINDS).
  if (!(REVIEWABLE_LISTING_KINDS as readonly string[]).includes(request.kind)) {
    throw new OffsiteRequestError(
      'NOT_FOUND',
      `publish request ${publishRequestId} is not a reviewable listing request`
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
      // `kind` + `slug` also feed the go-live ACTIONABILITY gate in (4c) — the
      // check is off-site-only, so it needs the discriminator, not just the URL.
      kind: true,
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

  const screenshotRows = await dbRead.appListingScreenshot.findMany({
    where: { appListingId, imageId: { not: null } },
    select: { imageId: true },
  });
  const screenshotImageIds = screenshotRows
    .map((s) => s.imageId)
    .filter((id): id is number => id != null);
  const screenshotCount = screenshotImageIds.length;

  // (3) Publish FLOOR gate — icon+cover required, screenshots optional (throws
  // BAD_REQUEST { missing }). Fail-fast copy on the replica; re-asserted
  // authoritatively on the primary in (5).
  assertListingMeetsFloor({
    iconId: listing.iconId,
    coverId: listing.coverId,
    screenshotCount,
  });

  // (3b) Scan-clean gate — every attached asset must be terminally `Scanned` (none
  // still pending, none `Blocked`) before it goes live. Fail-fast copy on the
  // replica; re-asserted AUTHORITATIVELY on the primary/tx in (5) (TOCTOU: a scan
  // can flip between these reads — the in-tx one is the authority). This is the
  // QUALITY gate that lets attach + submit stay permissive with an in-flight scan.
  await assertAssetsScanClean(
    { iconId: listing.iconId, coverId: listing.coverId, screenshotImageIds },
    dbRead
  );

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

  // (4c) 🔴 GO-LIVE ACTIONABILITY gate — an off-site listing may not be published
  // while the store would render it a primary CTA with nothing to click. This is
  // the gate that was MISSING when three connect listings were approved onto the
  // dead "Connecting this app will be available soon." stub (07-24 → 07-28), each
  // one going live with no way for a user to open the app.
  //
  // It re-runs the REAL detail view-model rather than re-deriving a second
  // "is this actionable?" rule — see `app-listing-actionable.service`. On-site
  // requests are a no-op (a model-slot app is legitimately non-navigable).
  // Fail-fast copy on the replica; re-asserted AUTHORITATIVELY on the primary in
  // (5), same TOCTOU discipline as the floor + scan gates above.
  assertOffsiteListingActionable(listing);

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
        // Go-live ACTIONABILITY gate (re-asserted below) — off-site-only, so it
        // needs the kind discriminator; `slug` names the listing in the error.
        kind: true,
        slug: true,
        // ON-SITE approve inputs, read on the PRIMARY with everything else so they are
        // row-consistent with the flip: the app's DECLARED rating (the raise-only floor —
        // see `resolveOnsiteApprovalContentRating`) and the backing block to un-suspend.
        contentRating: true,
        appBlockId: true,
      },
    });
    if (!primaryListing) {
      throw new OffsiteRequestError('NOT_FOUND', `draft listing ${appListingId} not found`);
    }
    const primaryScreenshotRows = await tx.appListingScreenshot.findMany({
      where: { appListingId, imageId: { not: null } },
      select: { imageId: true },
    });
    const primaryScreenshotImageIds = primaryScreenshotRows
      .map((s) => s.imageId)
      .filter((id): id is number => id != null);
    assertListingMeetsFloor({
      iconId: primaryListing.iconId,
      coverId: primaryListing.coverId,
      screenshotCount: primaryScreenshotImageIds.length,
    });
    // AUTHORITATIVE scan-clean gate on the PRIMARY (`tx`) — row-consistent with the
    // flip. A scan that read `Scanned` on the replica in (3b) but flipped to
    // Pending/Blocked on the primary is caught HERE and rolls the whole tx back
    // before anything is approved. Upholds the invariant: no approved listing may
    // ever reference a non-`Scanned` / `Blocked` image.
    await assertAssetsScanClean(
      {
        iconId: primaryListing.iconId,
        coverId: primaryListing.coverId,
        screenshotImageIds: primaryScreenshotImageIds,
      },
      tx
    );
    // AUTHORITATIVE go-live ACTIONABILITY gate on the PRIMARY (`tx`) — row-consistent
    // with the flip below. `externalUrl` is owner-editable in place while the request
    // sits pending, so an owner who cleared the URL after the replica read in (4c) is
    // caught HERE and the whole tx rolls back BEFORE anything is approved. Upholds the
    // invariant: no approved off-site listing may render a primary CTA the viewer
    // cannot click.
    //
    // 🔴 `connectClientId` IS NOT EDITABLE IN PLACE, and this comment used to say it
    // was — one of the seven false-mechanism comments #4126 corrected. `buildListingPatchData`
    // never assigns the column and `updateListingPatchSchema` has no such key, so "or
    // linked an OAuth client" named a mutation no code path can perform. It was also
    // backwards about direction: `assertOffsiteListingActionable` fails on a connect
    // listing with NO usable `href`, so ACQUIRING a client alongside a valid URL would
    // not break actionability anyway. The column is still passed to the gate because it
    // selects the sub-kind the CTA is derived from — a real input, just not a mutable one.
    assertOffsiteListingActionable(primaryListing);
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
      if (
        !connectScopesSubsetOfCeiling(primaryListing.connectRequestedScopes ?? 0, allowedScopes)
      ) {
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
    //
    // 🔴 ON-SITE TAKES THE RAISE-ONLY VARIANT, and this branch is NEW because until the
    // owner-republish asset-review route existed nothing could reach this path with
    // `kind: 'onsite'` — every other on-site listing request is a media REVISION and
    // returns above via `applyApprovedRevision`. An on-site listing's `contentRating`
    // describes the APP (manifest-declared), so it must be raised by mature media and
    // never lowered by tame media. See {@link resolveOnsiteApprovalContentRating}.
    const finalRating =
      request.kind === 'onsite'
        ? await resolveOnsiteApprovalContentRating(tx, {
            appListingId,
            declared: primaryListing.contentRating,
            override: opts.contentRating,
          })
        : await resolveApprovalContentRating(tx, {
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

    // 🔴 ON-SITE: RESTORE THE RUNTIME, NOT ONLY THE STORE CARD. `AppBlock.status` is the
    // ONLY gate on whether a hosted app serves; `AppListing.status` gates store
    // visibility and nothing else. `unpublishOwnListing` suspends the block, and the
    // owner-republish review arm deliberately leaves it suspended so an app whose store
    // card is awaiting review does not serve. Approving the card therefore has to undo
    // BOTH halves, or the listing goes live pointing at a dead app — store-visible and
    // not self-recoverable, the same failure `approveRequest`'s `(3b-reset)` branch
    // exists to prevent on the block-request surface.
    //
    // Guarded to `suspended` so it is a 0-row no-op for every other case: a first-time
    // on-site draft (there is no such listing request today, but the guard means one
    // would be harmless), an on-site listing whose block is already approved, and every
    // off-site listing (no `appBlockId` at all).
    if (request.kind === 'onsite' && primaryListing.appBlockId) {
      await tx.appBlock.updateMany({
        where: { id: primaryListing.appBlockId, status: 'suspended' },
        data: { status: 'approved' },
      });
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
        // Match THIS request's kind (a listing has exactly one kind, so all its
        // requests share it) rather than hard-coding 'offsite' — otherwise an onsite
        // sibling pending request on the same appListingId would be stranded. Byte-
        // identical for offsite (request.kind === 'offsite' here).
        kind: request.kind,
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
  // `kind` drives the assets-only branch below: an ONSITE parent's scalars mirror the
  // manifest/AppBlock (single source), so an onsite media revision copies ONLY the
  // asset columns and leaves name/tagline/description/category/contentRating untouched.
  const parent = await dbRead.appListing.findUnique({
    where: { id: parentId },
    select: { id: true, slug: true, status: true, kind: true },
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

  // Does the MANUAL-APPLY column exist? Asked HERE, OUTSIDE the transaction, and on the
  // same primary the transaction will run against.
  //
  // 🔴 THE POINT IS TO NEVER ISSUE A FAILING STATEMENT INSIDE THE TRANSACTION. The
  // guarded read below swallows P2022 at the application level, but PostgreSQL puts a
  // transaction into the aborted state on ANY statement error, and Prisma's interactive
  // transactions issue no savepoints — so a caught-and-ignored missing-column error can
  // still leave every following statement failing with 25P02 and take the whole revision
  // apply down. Probing first means that when the column is absent the transaction never
  // names it at all, which is what makes "until the SQL runs, the feature is inert" true
  // of this path rather than merely intended.
  const sourceRepoColumnAvailable = await isSourceRepoColumnAvailable(dbWrite);

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
    // The shadow's public source-repository link, read through the MANUAL-APPLY guard
    // rather than added to the select above — a missing column there would abort this
    // whole transaction and make every off-site revision unapprovable until a human
    // runs the migration. Read on `tx` (the PRIMARY, inside the transaction) for the
    // same row-consistency reason the select is.
    //
    // 🔴 `available` — NOT `value != null` — decides whether the copy below writes the
    // column at all. Conflating them would mean an unreadable column looked exactly
    // like "the author removed the link", and the copy would need to distinguish
    // "clear it" from "don't touch it". It can, because it asks the right question.
    const shadowSourceRepo: ListingSourceRepoRead = sourceRepoColumnAvailable
      ? await readListingSourceRepoUrl(shadowId, tx)
      : { available: false, value: null };
    const shadowScreenshotRows = await tx.appListingScreenshot.findMany({
      where: { appListingId: shadowId, imageId: { not: null } },
      select: { imageId: true },
    });
    const shadowScreenshotImageIds = shadowScreenshotRows
      .map((s) => s.imageId)
      .filter((id): id is number => id != null);
    assertListingMeetsFloor({
      iconId: shadow.iconId,
      coverId: shadow.coverId,
      screenshotCount: shadowScreenshotImageIds.length,
    });
    // AUTHORITATIVE scan-clean gate on the PRIMARY (`tx`) — a revision cannot go
    // live while any of its media is still scanning or was `Blocked`. Rolls the
    // whole apply back (parent stays exactly as it was) on any non-`Scanned` asset.
    await assertAssetsScanClean(
      {
        iconId: shadow.iconId,
        coverId: shadow.coverId,
        screenshotImageIds: shadowScreenshotImageIds,
      },
      tx
    );
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

    // (2c) 🔴 GO-LIVE ACTIONABILITY gate on the POST-COPY state. A revision is a
    // CONTENT go-live: it writes no `status`, but the off-site branch below copies
    // the shadow's `externalUrl` + `connectClientId` straight onto an ALREADY-LIVE
    // parent — so a revision that clears the URL is precisely how a working listing
    // becomes a dead CTA without any status write.
    //
    // 🔴 ONLY THE URL. This comment used to add "(or links an OAuth client)" — one of
    // the seven false-mechanism comments #4126 corrected. The shadow's
    // `connectClientId` is `parent.connectClientId` verbatim: `beginListingRevision`
    // copies it in, nothing on the revision edit path can change it
    // (`buildListingPatchData` never assigns it, `updateListingPatchSchema` has no such
    // key), and the copy below writes the same value back. So this copy CANNOT link a
    // client; the round trip is an identity on that column. The column is still passed
    // to the gate because it selects the sub-kind the CTA is derived from.
    //
    // 🔴 Asserted on the PROJECTED result of the copy — the parent's `kind`/`slug`
    // (neither is copied) with the SHADOW's URL/client (which are) — NOT on the
    // parent as it stands. Re-reading the parent here would gate the state we are
    // about to overwrite and would pass every regression this is meant to stop.
    // On-site revisions are a no-op: they copy assets only, never these columns.
    assertOffsiteListingActionable({
      kind: parent.kind,
      slug: parent.slug,
      externalUrl: shadow.externalUrl,
      connectClientId: shadow.connectClientId,
    });

    // (3) Copy the shadow's contents onto the parent (id / slug / appBlockId / status
    // untouched). KIND-AWARE:
    if (parent.kind === 'onsite') {
      // 🔴 ONSITE = ASSETS-ONLY. An onsite listing's name/tagline/description/category/
      // contentRating MIRROR the manifest/AppBlock (single source — the listing must
      // never override the runtime serving gate). An onsite media revision therefore
      // copies ONLY the asset columns (icon/cover; screenshots are reparented in step 4)
      // and leaves ALL manifest-governed scalars untouched. CAP-AT-APP-RATING:
      // `resolveApprovalContentRating`'s asset-floor is deliberately NOT applied here —
      // the listing rating stays the app's manifest rating; over-rated media is a
      // mod-reject at review, never an auto-raise. The connect fields are also left
      // untouched (an onsite listing has no OAuth-connect client — always null).
      await tx.appListing.update({
        where: { id: parentId },
        data: {
          iconId: shadow.iconId,
          coverId: shadow.coverId,
        },
      });
    } else {
      // OFFSITE (byte-identical to the prior behavior). Copy the FULL scalar set. The
      // content rating is DERIVED from the shadow's assets' max nsfwLevel (+ the mod
      // override, floored) rather than trusting the shadow's declared value — same
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
          // The reviewed source-repository link. UNCONDITIONAL in both directions, like
          // every other scalar here: a revision that cleared it clears it on the parent.
          // That is exactly why `beginListingRevision` copies it onto the shadow — and
          // why `OFFSITE_UNCOMPARED_APPLY_FIELDS` names it, so the drift panel cannot
          // tell a moderator this apply "changes nothing" while it rewrites a public
          // outbound link. Omitted (not null) while the manual-apply column is absent.
          ...sourceRepoWriteFragment(shadowSourceRepo),
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
    }

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
  // Accept onsite media revisions too. The reject path (`closeTerminalListing`) is
  // already kind-agnostic — an onsite revision points at a `draft` shadow, so only the
  // shadow is deleted; the live onsite parent is untouched (see REVIEWABLE_LISTING_KINDS).
  if (!(REVIEWABLE_LISTING_KINDS as readonly string[]).includes(request.kind)) {
    throw new OffsiteRequestError(
      'NOT_FOUND',
      `publish request ${publishRequestId} is not a reviewable listing request`
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

  // Post-commit, best-effort: notify the owner their submission was not approved,
  // carrying the mod reason. Skipped for a revision reject (parent still live) and when
  // there was no listing. Keyed by the request → dedups a replay.
  //
  // 🔴 "FIRST-TIME submission" is what this comment used to say, and `revisionOfId == null`
  // is no longer a test for that. The owner-republish asset-review route mints a NON-shadow
  // request on a listing that has been live for as long as the app has existed, so a
  // long-lived app's owner now reaches this branch. That is the right call — the reject
  // ran `closeTerminalListing`, which took the listing OFF the store behind a `delist`, so
  // the owner must be told — and the copy carries it: `app-listing-rejected` renders
  // "<app> was not approved: <reason>", which claims nothing about it being a first
  // submission. What is NOT covered is that the notice does not say the listing has been
  // delisted and now needs a moderator to restore it; distinguishing the two cases needs a
  // second notification type, which is a product decision rather than a correction.
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
 * The byte cap is the LOOSEST per-kind cap: bytes above it satisfy no kind, and the
 * kind is not known until attach, so it is the only size rejection that can happen
 * this early.
 *
 * The DIMENSION ceiling does not need the kind either — it is the same for all of
 * them — so it is applied here too, on the measured (never the declared) pair. A
 * byte cap does not bound decoded dimensions: a small, highly-compressed file can
 * decode to an enormous canvas, and the presigned-upload path had no ceiling at
 * all, so an image far above the bound was stored at full size and only its
 * MINIMUMS were ever checked. Rejecting here keeps the bytes out of `createImage`
 * + the scan pipeline; {@link validateListingImage} re-applies the same bound at
 * attach for rows this path did not create.
 */
const measureListingAssetUpload = async (key: string) => {
  const measured = await measureUploadedImage(key, {
    maxBytes: MAX_LISTING_ASSET_SIZE_BYTES,
    subject: 'listing media',
  });
  const tooLarge = listingAssetTooLargeReason('That image', measured.width, measured.height);
  if (tooLarge) throw new TRPCError({ code: 'BAD_REQUEST', message: `${tooLarge}.` });
  return measured;
};

/**
 * Materialise an uploaded image into an `Image` row (owned by the caller) and
 * return its numeric id, so the submit form's asset step can attach it to the
 * draft listing via the P1 asset-CRUD procs. Kicks off the standard ingestion/scan
 * pipeline (`createImage` with default ingestion) — the P1 attach proc enforces
 * `ingestion === Scanned` + the per-kind image validation.
 *
 * The persisted dimensions / MIME / byte size are DERIVED FROM THE STORED BYTES
 * (see {@link measureListingAssetUpload}); the same fields on the input are
 * ignored. `createImage` and the probe are dynamically imported so the heavy
 * `image.service` / `sharp` graphs stay out of this service's static graph
 * (mirrors the router's dynamic-import discipline + keeps the unit tests, which
 * mock only `dbRead`/`dbWrite`, light).
 */
export async function persistListingAssetImage(opts: {
  input: PersistListingAssetImageInput;
  userId: number;
}): Promise<{ imageId: number }> {
  const { input, userId } = opts;
  const measured = await measureListingAssetUpload(input.url);
  const { createImage } = await import('~/server/services/image.service');
  const image = await createImage({
    url: input.url,
    name: input.name ?? undefined,
    type: 'image',
    width: measured.width,
    height: measured.height,
    mimeType: measured.mimeType,
    // The P1 image validator reads the byte size from `Image.metadata.size`. The
    // entity tag alongside it records WHICH stored object those measurements came
    // from, so the attach gate can re-check that the object still is that one
    // instead of trusting a reading taken before the upload grant expired.
    metadata: { size: measured.sizeBytes, ...storedObjectEtagMetadata(measured.etag) },
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
  // The request KIND ('onsite' | 'offsite') — surfaced so the unified /apps/review
  // queue (PR-2) can badge onsite media revisions vs offsite submissions. Additive:
  // pre-existing consumers ignore it.
  kind: true,
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

/**
 * `submissionSelect` PLUS the advisory listing-completeness projection used ONLY
 * by the author-facing `listMySubmissions` (NOT the mod queues — they don't render
 * the warning). Adds the asset ids + key text fields + a screenshot COUNT (via
 * `_count`, not the rows) so the pure `computeListingProblems` helper can flag a
 * row. Purely additive; `category` is already in `submissionSelect`.
 */
const mySubmissionSelect = {
  ...submissionSelect,
  appListing: {
    select: {
      ...submissionSelect.appListing.select,
      /**
       * The LISTING's kind, feeding `computeListingProblems`' kind-aware empty-text
       * labels.
       *
       * 🔴 THE LISTING'S KIND, NOT THE REQUEST'S, even though `submissionSelect`
       * already carries `kind` on the REQUEST and the two agree today. They are
       * different columns on different tables, and the advisory is a statement about
       * the LISTING — reusing the request's would be a derived surface standing in for
       * the defining one. Selected only on `mySubmissionSelect` (the author-facing
       * read); the mod queues that spread the base `submissionSelect` are untouched.
       */
      kind: true,
      iconId: true,
      coverId: true,
      description: true,
      tagline: true,
      // Filtered COUNT — only screenshots whose Image is still live. A row whose
      // Image was deleted (imageId → null via onDelete: SetNull) has no
      // displayable asset, so it must not inflate the count, else the
      // `no-screenshots` (advisory) warning is a false-negative. Matches the
      // screenshot count query used elsewhere:
      // `appListingScreenshot.count({ where: { imageId: { not: null } } })`.
      _count: { select: { screenshots: { where: { imageId: { not: null } } } } },
      // Screenshot Image ids (imageId-bearing only) so the scan dimension of
      // `computeListingProblems` can look up each asset's ingestion (Item 1). Ordered
      // for a stable per-row problem list.
      screenshots: {
        where: { imageId: { not: null } },
        select: { imageId: true },
        orderBy: { order: 'asc' },
      },
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
export async function listMySubmissions(opts: { userId: number } & ListOffsiteRequestsOptions) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: {
      submittedByUserId: opts.userId,
      kind: { in: [...REVIEWABLE_LISTING_KINDS] },
      // OFFSITE: exclude requests targeting a SHADOW (revision) listing — those are
      // surfaced as a `hasPendingRevision` flag on the PARENT's own submission row.
      // Keep requests with no listing.
      //
      // ONSITE: an onsite listing is auto-created and has NO own publish request, so a
      // SHADOW revision has no parent row to badge — the revision request is its only
      // representation. The `{ kind: 'onsite' }` OR branch surfaces it directly
      // (decision: yes).
      //
      // 🔴 THAT BRANCH IS NO LONGER THE ONLY ROUTE FOR AN ONSITE ROW, and the sentence it
      // used to carry — "all onsite requests are shadow revisions, per the invariant" —
      // is false since the owner-republish asset-review route (see the producer ledger
      // above `REVIEWABLE_LISTING_KINDS`). A republish re-review is NON-shadow, so the
      // middle branch (`revisionOfId: null`) already matches it; `OR` is a set union, so
      // it appears exactly once either way and this query is unchanged in behaviour. What
      // IS affected is downstream: `hasPendingRevision` below is keyed on `revisionOfId`
      // and is correctly `false` for such a row, and `lastActionByListing` populates only
      // for `status: 'removed'`, so a listing sitting in republish review carries no
      // last-action badge. Both are deliberate; neither may be re-derived from "onsite
      // implies shadow".
      OR: [{ appListingId: null }, { appListing: { revisionOfId: null } }, { kind: 'onsite' }],
    },
    orderBy: { submittedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: mySubmissionSelect,
  });
  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;

  // Flag which parent listings on this page have a revision UNDER REVIEW. This is
  // derived from the existence of a PENDING publish request that targets a shadow
  // (a `revisionOfId`-bearing listing) for the parent — NOT from mere shadow
  // existence. An abandoned shadow (opened via beginListingRevision but never
  // submitListingRevision-ed → no pending request) must NOT falsely badge the
  // parent "revision in review".
  const parentIds = page.map((r) => r.appListingId).filter((id): id is string => id != null);
  const pendingRevisionReqs =
    parentIds.length > 0
      ? await dbRead.appListingPublishRequest.findMany({
          where: {
            status: 'pending',
            kind: { in: [...REVIEWABLE_LISTING_KINDS] },
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
  // fetch its MOST-RECENT STATUS-CHANGING moderation-event action so the my-submissions
  // UI can tell an owner-hidden listing (last event `owner-unpublish` →
  // republish-eligible) from a moderator takedown (last event `delist` → republish
  // FORBIDDEN, shown as "removed by a moderator") WITHOUT a per-row history fetch.
  //
  // 🔴 THE `action IN (…)` PREDICATE IS LOAD-BEARING, AND ITS VALUES COME FROM
  // `LISTING_STATUS_CHANGING_MODERATION_ACTIONS` — the same constant the Prisma reads use.
  // This is the PRIMARY surface for the feature, and an unfiltered `DISTINCT ON` answers a
  // different question from the server gate (`republishOwnListing`, the author edit paths):
  // a `message-owner` / `claim` / `report-resolve` row newer than the owner's own
  // `owner-unpublish` would badge the listing "removed by a moderator" and hide Republish on
  // a listing the server would happily republish. Raw SQL is exactly where a second
  // hand-maintained spelling of the set would go unnoticed, so the list is interpolated as
  // BOUND PARAMETERS from the constant rather than typed out. The whole normalised statement
  // is pinned in `offsite-listing.edit.service.test.ts`.
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
            AND action IN (${Prisma.join([...LISTING_STATUS_CHANGING_MODERATION_ACTIONS])})
          ORDER BY app_listing_id, created_at DESC, id DESC
        `)
      : [];
  const lastActionByListing = new Map(
    lastEvents
      .filter((e): e is { appListingId: string; action: string } => e.appListingId != null)
      .map((e) => [e.appListingId, e.action])
  );

  // Scan dimension (Item 1): batch-read the ingestion of every attached asset image
  // on the page so `computeListingProblems` can flag a still-scanning (advisory) or
  // `Blocked` (blocking) asset. One findMany over the union of icon/cover/screenshot
  // image ids — NOT per row.
  const assetImageIds = [
    ...new Set(
      page.flatMap((r) => [
        r.appListing?.iconId,
        r.appListing?.coverId,
        ...(r.appListing?.screenshots ?? []).map((s) => s.imageId),
      ])
    ),
  ].filter((id): id is number => id != null);
  const ingestionRows = assetImageIds.length
    ? await dbRead.image.findMany({
        where: { id: { in: assetImageIds } },
        select: { id: true, ingestion: true },
      })
    : [];
  const ingestionByImageId = new Map(ingestionRows.map((i) => [i.id, i.ingestion ?? null]));
  const scanStatusOf = (ingestion: string | null | undefined): 'scanned' | 'pending' | 'blocked' =>
    ingestion === 'Scanned' ? 'scanned' : ingestion === 'Blocked' ? 'blocked' : 'pending';
  const assetScansFor = (listing: {
    iconId: number | null;
    coverId: number | null;
    screenshots?: { imageId: number | null }[] | null;
  }): { kind: 'icon' | 'cover' | 'screenshot'; status: 'scanned' | 'pending' | 'blocked' }[] => {
    const scans: {
      kind: 'icon' | 'cover' | 'screenshot';
      status: 'scanned' | 'pending' | 'blocked';
    }[] = [];
    if (listing.iconId != null)
      scans.push({ kind: 'icon', status: scanStatusOf(ingestionByImageId.get(listing.iconId)) });
    if (listing.coverId != null)
      scans.push({ kind: 'cover', status: scanStatusOf(ingestionByImageId.get(listing.coverId)) });
    for (const s of listing.screenshots ?? [])
      if (s.imageId != null)
        scans.push({
          kind: 'screenshot',
          status: scanStatusOf(ingestionByImageId.get(s.imageId)),
        });
    return scans;
  };

  const items = page.map((r) => ({
    ...r,
    hasPendingRevision: r.appListingId != null && parentsWithRevision.has(r.appListingId),
    // Null for a non-removed listing (or one with no events) — the UI only reads it
    // when `appListing.status === 'removed'` to gate the Republish affordance.
    lastModerationAction:
      r.appListingId != null ? lastActionByListing.get(r.appListingId) ?? null : null,
    // Advisory listing-completeness problems (missing assets + empty key fields).
    // Empty when there's no backing listing (a rejected/withdrawn row whose listing
    // was deleted) — nothing to flag.
    problems: r.appListing
      ? computeListingProblems({
          // 🔴 `listMySubmissions` IS NOT AN OFF-SITE-ONLY READ despite this file's name:
          // its `where` has an explicit `{ kind: 'onsite' }` OR-branch so on-site MEDIA
          // REVISIONS appear on /apps/my-submissions. A hardcoded 'offsite' here would
          // therefore give manifest-governed listings the author-surface advice — exactly
          // the defect being fixed. A fake that ignores `select` degrades to the original
          // labels rather than throwing.
          kind: (r.appListing.kind ?? 'offsite') as ListingProblemKind,
          iconId: r.appListing.iconId,
          coverId: r.appListing.coverId,
          screenshotCount: r.appListing._count.screenshots,
          description: r.appListing.description,
          tagline: r.appListing.tagline,
          category: r.appListing.category,
          assetScans: assetScansFor(r.appListing),
        }).problems
      : [],
  }));

  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

/**
 * Mod queue: pending listing requests (offsite submissions + onsite media revisions),
 * oldest-first (FIFO), keyset-paginated. Each row carries `kind` so the unified
 * /apps/review queue (PR-2) can badge an onsite media revision vs an offsite submission.
 */
export async function listPendingOffsiteRequests(opts: ListOffsiteRequestsOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { status: 'pending', kind: { in: [...REVIEWABLE_LISTING_KINDS] } },
    orderBy: { submittedAt: 'asc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { ...submissionSelect, submittedBy: submitterChip },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

/** Mod history: approved listing requests (offsite + onsite media revisions), most-recently-reviewed first. */
export async function listApprovedOffsiteRequests(opts: ListOffsiteRequestsOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { status: 'approved', kind: { in: [...REVIEWABLE_LISTING_KINDS] } },
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

/** Mod history: rejected listing requests (offsite + onsite media revisions), most-recently-reviewed first. */
export async function listRejectedOffsiteRequests(opts: ListOffsiteRequestsOptions = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appListingPublishRequest.findMany({
    where: { status: 'rejected', kind: { in: [...REVIEWABLE_LISTING_KINDS] } },
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
