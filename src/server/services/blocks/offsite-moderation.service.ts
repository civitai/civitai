import { TRPCError } from '@trpc/server';
import type { Prisma } from '@prisma/client';

import { dbRead, dbWrite } from '~/server/db/client';
import {
  APP_LISTING_REPORT_REASONS,
  OFFSITE_MOD_REASON_MIN,
  type ClaimListingInput,
  type DelistListingInput,
  type DismissReportInput,
  type ListListingReportsInput,
  type ListModerationEventsInput,
  type ListMyListingModerationEventsInput,
  type PurgeListingInput,
  type RelistListingInput,
  type ReportListingInput,
  type RepublishOwnListingInput,
  type ResetListingToPendingInput,
  type ResolveReportInput,
  type UnpublishOwnListingInput,
} from '~/server/schema/blocks/offsite-moderation.schema';
import { safeCollaboratorQuery } from '~/server/services/blocks/app-access.service';
import { recordOwnershipEvent } from '~/server/services/blocks/app-collaborator.service';
import { notifyAppListingOwner } from '~/server/services/blocks/app-listing-notify';
import {
  assertListingAssetsScanCleanInTx,
  assertListingMeetsFloor,
  resolveListingRatingFloorInTx,
} from '~/server/services/blocks/app-listing-assets.service';
import { assertOffsiteListingActionableInTx } from '~/server/services/blocks/app-listing-actionable.service';
import {
  isOwnerUnpublishAction,
  readLastStatusChangingModerationEvent,
} from '~/server/services/blocks/app-listing-owner-unpublish';
import {
  REPUBLISH_REVIEW_DETAIL,
  type RepublishReviewReason,
  buildApprovedAssetSnapshot,
  readRecordedAssetBaseline,
  resolveRepublishReviewReason,
} from '~/server/services/blocks/app-listing-approved-assets';
import {
  newAppListingModerationEventId,
  newAppListingPublishRequestId,
  newAppListingReportId,
  newUlid,
} from '~/server/utils/app-block-ids';

/**
 * App Store Listings (W13) — P3b OFF-SITE MODERATION service.
 *
 * The post-approval moderation surface for off-site listings. PR2 ships the
 * user-facing REPORT path + the mod-facing report-queue read; PR3 adds the mod
 * actions (delist / relist / claim / resolve / dismiss + the
 * `AppListingModerationEvent` audit writes) in THIS file.
 *
 * Mirrors the P3a `offsite-listing.service` discipline: a typed error class
 * (duck-typed by the router's `mapOffsiteError`, so the router never eagerly
 * imports this module — services are loaded via dynamic `import()` to keep the
 * generated Prisma client out of the router's static graph), DB-layer dedup (the
 * partial-unique `app_listing_reports_one_open_per_reporter` — one PENDING report
 * per (listing, reporter) — caught as P2002, NOT a check-then-insert race), and a
 * caller-forced owner id (mass-assignment / IDOR guard).
 *
 * DARK: `reportListing` is `protectedProcedure` (+ router rate-limit) and
 * `listListingReports` is `moderatorProcedure`; the report affordance renders only
 * on the mod-only store-preview surface, so reports are mod-only until the store
 * widens. The dedup + rate-limit are in from day one regardless, so widening is
 * safe with no service change.
 */

// ---------------------------------------------------------------------------
// Typed failure modes (mirror OffsiteRequestError; duck-typed by mapOffsiteError).
// ---------------------------------------------------------------------------

export type OffsiteModerationErrorCode =
  | 'NOT_FOUND'
  | 'NOT_REPORTABLE'
  | 'ALREADY_REPORTED'
  // W13 post-approval-mgmt owner actions:
  //   NOT_OWNED  — an owner action (unpublish/republish/my-history) on a listing the
  //     caller does not own → FORBIDDEN (router maps NOT_OWNED/FORBIDDEN → FORBIDDEN).
  //   FORBIDDEN  — a forbidden owner transition, notably republish of a listing whose
  //     LAST moderation event is a mod delist/purge (a takedown-for-cause the owner
  //     may not self-restore) → FORBIDDEN.
  | 'NOT_OWNED'
  | 'FORBIDDEN'
  // PR3 mod-action failure modes:
  //   NOT_TRANSITIONABLE — a status-guarded delist/relist/claim matched 0 rows (the
  //     listing was already moved by a concurrent action, or is not in a claimable
  //     status) → BAD_REQUEST.
  //   REPORT_NOT_PENDING — resolve/dismiss on an already-closed report → BAD_REQUEST.
  //   INVALID_TARGET_USER — claim targeted a userId that is not a real User (a
  //     friendly BAD_REQUEST instead of a raw FK 23503 leaking as INTERNAL).
  // A kind mismatch (an on-site listing) reuses NOT_FOUND (generic — a mod caller
  // must not be able to probe a listing's kind through this surface).
  | 'NOT_TRANSITIONABLE'
  | 'REPORT_NOT_PENDING'
  | 'INVALID_TARGET_USER';

export class OffsiteModerationError extends Error {
  readonly code: OffsiteModerationErrorCode;
  constructor(code: OffsiteModerationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OffsiteModerationError';
    this.code = code;
  }
}

/**
 * Generic client-facing message for the not-reportable failure mode.
 *
 * Info-leak guard: the router's `mapOffsiteError` forwards `err.message` straight
 * to the client, so a caller holding an arbitrary listing id must NOT be able to
 * probe (a) whether the id EXISTS and (b) its exact moderation status. Both the
 * missing-listing and the non-approved-listing cases therefore throw the SAME
 * code (`NOT_REPORTABLE` → BAD_REQUEST) with this SAME generic message; the real
 * distinction (not-found vs the actual status) is carried only on `cause`, which
 * `mapOffsiteError` keeps server-side (central fault logger) and never surfaces.
 */
export const REPORT_UNAVAILABLE_MESSAGE = 'This app can no longer be reported.';

/** Server-only (on `cause`) reason for a not-reportable throw — for logs/tests. */
export type NotReportableCause =
  | { reason: 'NOT_FOUND'; appListingId: string }
  | { reason: 'NOT_APPROVED'; status: string };

// ---------------------------------------------------------------------------
// reportListing (any signed-in user).
// ---------------------------------------------------------------------------

export type ReportListingResult = { reportId: string };

/**
 * File a report against an APPROVED off-site listing.
 *
 * Owner-binding (IDOR / mass-assignment): `reporterUserId` is ALWAYS the
 * authenticated caller (`userId`) — the input carries NO reporter field, so a
 * caller can never file a report as another user.
 *
 * Reportable-state gate: the target listing must EXIST and be `approved`. A
 * missing listing AND a non-approved (draft / pending / rejected / removed)
 * listing BOTH raise `NOT_REPORTABLE` with the SAME generic client message
 * (`REPORT_UNAVAILABLE_MESSAGE`) — the caller cannot tell existence apart from
 * non-approvability, nor read the exact status (info-leak guard; the real reason
 * rides on `cause`, server-only). `reason` is re-validated against the shared
 * tuple (defense-in-depth: this fn is exported + unit-tested directly, not only
 * reached through the zod schema).
 *
 * Dedup / anti-spam: the insert relies on the DB partial-unique
 * `app_listing_reports_one_open_per_reporter` (one PENDING report per
 * (listing, reporter)) — a duplicate open report fires P2002, collapsed to a
 * friendly ALREADY_REPORTED. This is DB-layer dedup, NOT a check-then-insert
 * pre-check (which would race). A prior report that a mod later resolved /
 * dismissed does NOT block a new one (the partial index only covers `pending`).
 */
export async function reportListing(opts: {
  input: ReportListingInput;
  userId: number;
}): Promise<ReportListingResult> {
  const { input, userId } = opts;

  // Defense-in-depth reason re-validation (mirrors the offsite submit service's
  // re-checks of URL/surface/category/rating — the fn is exported + unit-tested).
  if (!(APP_LISTING_REPORT_REASONS as readonly string[]).includes(input.reason)) {
    throw new OffsiteModerationError('NOT_REPORTABLE', `unknown report reason "${input.reason}"`);
  }

  // Reportable-state gate: must be an existing, APPROVED listing.
  //
  // Info-leak guard: a missing listing and a non-approved listing are BOTH
  // surfaced to the client as the same code + `REPORT_UNAVAILABLE_MESSAGE`, so a
  // caller cannot distinguish "id doesn't exist" from "exists but not approvable"
  // nor read the exact moderation status. The real reason (and the raw status)
  // rides on `cause` — server-only (logs/tests), never client-visible.
  const listing = await dbRead.appListing.findUnique({
    where: { id: input.appListingId },
    select: { id: true, status: true },
  });
  if (!listing) {
    const cause: NotReportableCause = { reason: 'NOT_FOUND', appListingId: input.appListingId };
    throw new OffsiteModerationError('NOT_REPORTABLE', REPORT_UNAVAILABLE_MESSAGE, { cause });
  }
  if (listing.status !== 'approved') {
    const cause: NotReportableCause = { reason: 'NOT_APPROVED', status: listing.status };
    throw new OffsiteModerationError('NOT_REPORTABLE', REPORT_UNAVAILABLE_MESSAGE, { cause });
  }

  const details = input.details?.trim() ? input.details.trim() : null;
  const reportId = newAppListingReportId();

  try {
    await dbWrite.appListingReport.create({
      data: {
        id: reportId,
        appListingId: input.appListingId,
        // FORCED from the authenticated caller — never from input (IDOR guard).
        reporterUserId: userId,
        reason: input.reason,
        details,
        status: 'pending',
      },
    });
  } catch (err) {
    // Lost the dedup race (or a duplicate open report): the partial-unique
    // `one_open_per_reporter` fires P2002. Collapse to a friendly message.
    if ((err as { code?: unknown })?.code === 'P2002') {
      throw new OffsiteModerationError(
        'ALREADY_REPORTED',
        'You have already reported this app — a moderator is reviewing it.'
      );
    }
    throw err;
  }

  return { reportId };
}

// ---------------------------------------------------------------------------
// listListingReports (moderator) — read-only report queue.
// ---------------------------------------------------------------------------

/**
 * Public-safe report-queue projection: the report fields + the reporter's public
 * chip ({id,username,image}) + the target listing's slug/name/kind. NO PII beyond
 * the public creator-chip shape, no infra / secret fields.
 */
const reportQueueSelect = {
  id: true,
  appListingId: true,
  reason: true,
  details: true,
  status: true,
  createdAt: true,
  resolvedAt: true,
  reporter: { select: { id: true, username: true, image: true } },
  // `status` is included so the report-queue UI can compute the per-row action set
  // (delist only on an approved listing, relist/purge on a removed one) WITHOUT a
  // second fetch. slug/name/kind/status are all public-safe listing fields.
  appListing: { select: { slug: true, name: true, kind: true, status: true } },
} as const;

/**
 * MOD report queue, oldest-first (FIFO), keyset-paginated. Optional `status`
 * filter (the queue UI passes `pending`). The cursor is the report id (an
 * `alrp_<ULID>`, time-sortable so it tracks the `createdAt asc` order).
 */
export async function listListingReports(opts: ListListingReportsInput = {}) {
  const limit = Math.min(opts.limit ?? 25, 50);
  const rows = await dbRead.appListingReport.findMany({
    where: opts.status ? { status: opts.status } : {},
    // Total order: `createdAt` alone is non-unique (default now()), so
    // same-millisecond inserts could skip/duplicate a row across a page boundary.
    // The `id` tie-break makes the ordering deterministic; the native cursor
    // (cursor:{id}, skip:1) still paginates on the unique id.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: reportQueueSelect,
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

// ---------------------------------------------------------------------------
// PR3/PR4 — mod ACTIONS (delist / relist / claim / purge / resolve / dismiss). Each
// writes EXACTLY ONE `AppListingModerationEvent` in the SAME transaction as its
// mutation (a crash can't split the mutation from its audit record). All mod-only at
// the router (`moderatorProcedure` + `isModerator` recheck). `claim` (PR4) reassigns
// the listing OWNER (`AppListing.userId`) — the historical
// `AppListingPublishRequest.submittedByUserId` is left INTACT.
//
// Discipline mirrored from the P3a offsite-listing approve/reject:
//   - CLASSIFY on the replica (kind guard), then MUTATE with a status-guarded
//     `updateMany`/`deleteMany` so a concurrent action can't double-act (TOCTOU);
//     a 0-count rolls the whole tx back BEFORE the audit event is written.
//   - A missing listing AND an on-site listing both raise the SAME generic
//     NOT_FOUND — a mod caller can't probe a listing's kind/existence here.
// ---------------------------------------------------------------------------

/**
 * Trim + re-assert the mod reason floor (defense-in-depth — these fns are exported
 * and unit-tested directly, not only reached through the zod schema). A too-short
 * reason is a plain BAD_REQUEST (passed through by `mapOffsiteError`).
 */
function requireModReason(raw: string): string {
  const reason = raw.trim();
  if (reason.length < OFFSITE_MOD_REASON_MIN) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `reason must be at least ${OFFSITE_MOD_REASON_MIN} characters`,
    });
  }
  return reason;
}

/**
 * Load + classify an off-site listing for a mod action. A missing listing AND an
 * on-site (kind!=='offsite') listing BOTH raise the SAME generic NOT_FOUND — the
 * kind guard (delist/relist/purge are offsite-only, §8 of the scope doc) must not
 * let a mod caller probe a listing's kind or existence through this surface.
 */
async function classifyOffsiteListing(
  appListingId: string
): Promise<{ id: string; status: string; slug: string }> {
  const listing = await dbRead.appListing.findUnique({
    where: { id: appListingId },
    select: { id: true, kind: true, status: true, slug: true },
  });
  if (!listing || listing.kind !== 'offsite') {
    throw new OffsiteModerationError('NOT_FOUND', 'Standalone listing not found.');
  }
  return { id: listing.id, status: listing.status, slug: listing.slug };
}

/**
 * The Prisma predicate for "a listing a mod may PURGE".
 *
 * Two disjoint shapes:
 *   - any OFF-SITE listing (unchanged — purge has always been the off-site final expunge);
 *   - an ON-SITE **orphan pre-approval draft**: `status:'draft'` + `appBlockId: null`
 *     (never approved, so no backing `AppBlock`) + `revisionOfId: null`.
 *
 * 🔴 `revisionOfId: null` IS LOAD-BEARING — it is the whole difference between this and
 * `deleteOnsiteDraftListingForSlug`'s clause, which looks identical and is NOT safe to
 * reuse here. A SHADOW media revision (`beginListingRevision`) is created with the
 * PARENT's `kind`, `status:'draft'` and `appBlockId: null` — so it matches every other
 * term. That clause gets away with it only because it resolves BY SLUG and a shadow's
 * slug is a synthetic `rev-<ulid>`; a purge resolves BY ID, so without this term a mod
 * could hard-delete an in-flight media revision of a LIVE, approved on-site app.
 *
 * 🔴 And the on-site arm must NEVER widen past `draft`: an `approved`/`removed` on-site
 * listing has a backing `AppBlock` whose runtime serving gate reads `app_blocks.status`,
 * so deleting the listing row would hide the store card while leaving the hosted app
 * serving. `delistListing` is the correct action for those, and it is deliberately
 * status-guarded to `{approved, removed}` — the two sets do not overlap.
 */
const PURGEABLE_LISTING_WHERE = {
  OR: [
    { kind: 'offsite' },
    { kind: 'onsite', status: 'draft', appBlockId: null, revisionOfId: null },
  ],
} satisfies Prisma.AppListingWhereInput;

/** Does an already-loaded row satisfy {@link PURGEABLE_LISTING_WHERE}? Kept beside it so
 * the in-memory guard and the SQL guard can only drift together. */
function isPurgeableListing(row: {
  kind: string;
  status: string;
  appBlockId: string | null;
  revisionOfId: string | null;
}): boolean {
  if (row.kind === 'offsite') return true;
  return (
    row.kind === 'onsite' &&
    row.status === 'draft' &&
    row.appBlockId === null &&
    row.revisionOfId === null
  );
}

/**
 * Load + classify a listing for PURGE. A missing listing, and any listing outside
 * {@link PURGEABLE_LISTING_WHERE}, BOTH raise the SAME generic NOT_FOUND — same
 * info-leak parity as `classifyOffsiteListing`, so a mod caller cannot probe a
 * listing's kind, status or existence through this surface.
 */
async function classifyPurgeableListing(
  appListingId: string
): Promise<{ id: string; kind: string; status: string; slug: string }> {
  const listing = await dbRead.appListing.findUnique({
    where: { id: appListingId },
    select: {
      id: true,
      kind: true,
      status: true,
      slug: true,
      appBlockId: true,
      revisionOfId: true,
    },
  });
  if (!listing || !isPurgeableListing(listing)) {
    throw new OffsiteModerationError('NOT_FOUND', 'Standalone listing not found.');
  }
  return { id: listing.id, kind: listing.kind, status: listing.status, slug: listing.slug };
}

/**
 * Load + classify a listing for the DUAL-KIND delist/relist actions (which apply to BOTH
 * kinds at any status, unlike `claim` — still offsite-only via `classifyOffsiteListing` —
 * and `purge`, which takes any off-site listing but only ONE on-site shape, the orphan
 * pre-approval draft, via `classifyPurgeableListing`).
 * Returns the fields those actions need: kind (to branch the on-site dual-table flip),
 * status/slug, the backing `appBlockId` (on-site: flip the block's status too), and
 * the owner `userId` (the hide-notification target, for either kind). A missing listing →
 * generic NOT_FOUND (no kind guard here — both kinds are valid targets).
 */
async function classifyListingForAction(appListingId: string): Promise<{
  id: string;
  kind: string;
  status: string;
  slug: string;
  name: string | null;
  appBlockId: string | null;
  userId: number;
}> {
  const listing = await dbRead.appListing.findUnique({
    where: { id: appListingId },
    select: {
      id: true,
      kind: true,
      status: true,
      slug: true,
      name: true,
      appBlockId: true,
      userId: true,
    },
  });
  if (!listing) {
    throw new OffsiteModerationError('NOT_FOUND', 'Listing not found.');
  }
  return {
    id: listing.id,
    kind: listing.kind,
    status: listing.status,
    slug: listing.slug,
    name: listing.name,
    appBlockId: listing.appBlockId,
    userId: listing.userId,
  };
}

/**
 * Shared ON-SITE dual-table status flip. An on-site `AppListing` is 1:1 with a
 * backing `AppBlock`, and the block RUNTIME serving gate (`<slug>.civit.ai` / the
 * in-host page) reads `app_blocks.status` — NOT the listing status. So any action
 * that hides/restores an on-site listing must flip the backing block IN THE SAME TX
 * or store-visibility and runtime-serving drift apart (hidden in the store but still
 * serving, or restored in the store but a suspended/blank block).
 *
 * Factored out of the mod `delistListing`/`relistListing` (approved↔suspended) so the
 * OWNER `unpublishOwnListing`/`republishOwnListing` reuse the EXACT same flip. The
 * write is status-guarded to the expected `from` (don't clobber a drifted/already-set
 * state) and NON-FATAL on a 0-count (the LISTING flip is the authoritative visibility
 * gate; a drifted block is a benign blank/broken surface, not an exposure). No-op for
 * an off-site listing (no backing block). Returns true when a block row was flipped,
 * false on a 0-count (drift) or an off-site listing — the caller may log the drift.
 */
async function flipBackingBlockStatus(
  tx: Prisma.TransactionClient,
  opts: { isOnsite: boolean; appBlockId: string | null; from: string; to: string }
): Promise<boolean> {
  if (!opts.isOnsite || !opts.appBlockId) return false;
  const flip = await tx.appBlock.updateMany({
    where: { id: opts.appBlockId, status: opts.from },
    data: { status: opts.to },
  });
  return flip.count > 0;
}

export type DelistListingResult = { appListingId: string; status: 'removed' };

/**
 * MOD delist an APPROVED listing (approved → removed) — now DUAL-KIND (W13
 * post-approval mgmt). The store read path is approved-only, so a `removed` listing
 * drops out of `listAvailableListings` + `getListingDetail` automatically.
 *
 *   - OFF-SITE: flip only `app_listings.status` approved → removed.
 *   - ON-SITE: flip BOTH `app_listings.status` (approved → removed) AND the backing
 *     `app_blocks.status` (approved → suspended) in the SAME tx — a hosted block's
 *     runtime serving gate reads `app_blocks.status`, so hiding it from the store
 *     WITHOUT suspending the block would leave the hosted app still serving. The
 *     listing flip is the authoritative guard; the block flip is status-guarded to
 *     avoid clobbering a drifted state but is non-fatal on a 0-count (the store
 *     status is the source of truth for visibility).
 *
 * BOTH kinds then notify the owner their app was hidden (post-commit, carrying the
 * mod reason). The on-site owner is notified for the SAME reason the off-site one is,
 * and more urgently: an on-site delist also suspends the backing block, so the hosted
 * app goes dark. The owner's submissions/history view already renders the mod reason
 * for both kinds — the notification is what tells them to go look.
 *
 * STATUS: a delist is allowed on an `approved` OR an already-`removed` listing. The
 * `removed → removed` case is the 🔴 "convert an owner-hide into an ENFORCED takedown"
 * path: an owner who self-unpublished (last event = `owner-unpublish`) could otherwise
 * freely `republishOwnListing` — a mod delist on the removed listing is idempotent
 * (stays `removed`) but ALWAYS writes a `delist` event, making the LAST event a mod
 * takedown so the republish guard then FORBIDS the owner from re-exposing it (a
 * reversible lock-down without a hard `purge`). Status-guarded to `{approved,removed}`;
 * a 0-count means a concurrent action moved the row out of that set → NOT_TRANSITIONABLE
 * and the tx rolls back BEFORE the event is written (ZERO events on a guarded failure).
 * Optionally resolves the triggering `reportId` in the same tx.
 */
export async function delistListing(opts: {
  input: DelistListingInput;
  reviewerUserId: number;
}): Promise<DelistListingResult> {
  const { input, reviewerUserId } = opts;
  const reason = requireModReason(input.reason);
  const listing = await classifyListingForAction(input.appListingId);
  const isOnsite = listing.kind === 'onsite';
  const eventId = newAppListingModerationEventId();

  await dbWrite.$transaction(async (tx) => {
    // Allow approved → removed AND removed → removed (the enforced-takedown lock). The
    // idempotent removed→removed write keeps status `removed` but still counts (1 row),
    // so the event below is ALWAYS written on a matched row.
    const flipped = await tx.appListing.updateMany({
      where: {
        id: input.appListingId,
        kind: listing.kind,
        status: { in: ['approved', 'removed'] },
      },
      data: { status: 'removed' },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be delisted.'
      );
    }
    // ON-SITE: also suspend the backing AppBlock so the block runtime stops serving.
    // Guarded to `approved` (don't clobber a drifted/already-suspended state); non-fatal
    // on 0-count (also covers the removed→removed lock, where the block is already
    // suspended). Shared with relist + the owner unpublish/republish procs.
    await flipBackingBlockStatus(tx, {
      isOnsite,
      appBlockId: listing.appBlockId,
      from: 'approved',
      to: 'suspended',
    });
    await tx.appListingModerationEvent.create({
      data: {
        id: eventId,
        appListingId: input.appListingId,
        slug: listing.slug,
        action: 'delist',
        actorUserId: reviewerUserId,
        reason,
        reportId: input.reportId ?? null,
        // Reflect the actual pre-state (approved for a hide, removed for the lock-down).
        before: { status: listing.status },
        after: { status: 'removed' },
      },
    });
    if (input.reportId) {
      // Resolve the triggering report in the same tx. Best-effort + status-guarded
      // AND SCOPED to the delisted listing (`appListingId`): a caller passing a
      // `reportId` that belongs to a DIFFERENT listing matches 0 rows (no
      // cross-listing report closure) — the delist of THIS listing still stands and
      // its event still links the supplied reportId; the mismatched report is just
      // left untouched (silent no-op, not a hard failure — the delist is the primary
      // action, a bad reportId must not fail it). A report a concurrent action
      // already closed is likewise left as-is (0 rows).
      await tx.appListingReport.updateMany({
        where: { id: input.reportId, appListingId: input.appListingId, status: 'pending' },
        data: { status: 'resolved', resolvedByUserId: reviewerUserId, resolvedAt: new Date() },
      });
    }
  });

  // BOTH KINDS: post-commit, best-effort — notify the owner their app was hidden,
  // carrying the mod reason. An on-site delist is the MORE adverse of the two (it also
  // suspends the backing block, so the hosted app stops serving), so withholding the
  // notification there left the owner with no signal at all that their app went dark.
  // The reason is mandatory on delist and is what makes the message actionable.
  await notifyAppListingOwner({
    type: 'app-listing-hidden',
    userId: listing.userId,
    // Keyed by the audit event id so each distinct hide (delist→relist→delist)
    // notifies once, without a fresh nonce.
    key: `app-listing-hidden:${eventId}`,
    details: { slug: listing.slug, name: listing.name, listingId: input.appListingId, reason },
  });

  return { appListingId: input.appListingId, status: 'removed' };
}

export type RelistListingResult = { appListingId: string; status: 'approved' };

/**
 * MOD relist a REMOVED listing (removed → approved) — DUAL-KIND reversibility for a
 * mistaken/appealed takedown; restores store visibility instantly. The mirror of
 * delist:
 *   - OFF-SITE: flip only `app_listings.status` removed → approved.
 *   - ON-SITE: flip BOTH `app_listings.status` (removed → approved) AND the backing
 *     `app_blocks.status` (suspended → approved) in the SAME tx, so the block starts
 *     serving again. The block flip is status-guarded (suspended-only) + non-fatal on
 *     a 0-count (drift-tolerant), same as delist.
 * Status-guarded (`status:'removed'`) + one audit event, same TOCTOU discipline as
 * delist. No owner notification (a relist is a RESTORE — nothing adverse to notify).
 */
export async function relistListing(opts: {
  input: RelistListingInput;
  reviewerUserId: number;
}): Promise<RelistListingResult> {
  const { input, reviewerUserId } = opts;
  const reason = requireModReason(input.reason);
  const listing = await classifyListingForAction(input.appListingId);
  const isOnsite = listing.kind === 'onsite';
  // Set when the on-site block-restore flip matched 0 rows (drift — see below).
  let onsiteBlockRestoreDrift = false;

  await dbWrite.$transaction(async (tx) => {
    // 🔴 Scan-clean go-live gate — a relist (removed → approved) republishes the
    // listing's EXISTING assets; refuse if any is still scanning or was `Blocked`
    // (the removed listing was directly asset-editable). No-op for a normally-scanned
    // listing. Runs BEFORE the flip so a scan-dirty listing is never made live.
    await assertListingAssetsScanCleanInTx(tx, input.appListingId);
    // 🔴 GO-LIVE ACTIONABILITY gate — a relist (removed → approved) puts the listing
    // back on the store, so it is a go-live like any other and gets the same check:
    // an off-site listing may not become visible while its primary CTA would render
    // with nothing to click. Read on the PRIMARY (`tx`) so the verdict is
    // row-consistent with the flip; a removed listing stays owner-editable, so its
    // URL/OAuth-client can have changed since the takedown. On-site relists no-op.
    await assertOffsiteListingActionableInTx(tx, input.appListingId);
    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: listing.kind, status: 'removed' },
      data: { status: 'approved' },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be relisted.'
      );
    }
    // ON-SITE: restore the backing AppBlock so the block runtime serves again.
    // Guarded to `suspended` (don't clobber a drifted state); non-fatal on 0-count.
    //
    // DRIFT CAVEAT: if the block was NOT `suspended` (e.g. `deprecated`, or already
    // `approved`) the guard matches 0 rows and the block is left as-is. The listing
    // then shows `approved` while the block may not serve — a BLANK/BROKEN block
    // surface, NOT an exposure (the store card links to a block that renders nothing).
    // Non-fatal (store visibility IS restored); flagged for a post-commit warn so the
    // divergence is observable rather than silent.
    if (isOnsite && listing.appBlockId) {
      const flipped = await flipBackingBlockStatus(tx, {
        isOnsite,
        appBlockId: listing.appBlockId,
        from: 'suspended',
        to: 'approved',
      });
      if (!flipped) onsiteBlockRestoreDrift = true;
    }
    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: input.appListingId,
        slug: listing.slug,
        action: 'relist',
        actorUserId: reviewerUserId,
        reason,
        before: { status: 'removed' },
        after: { status: 'approved' },
      },
    });
  });

  // Post-commit, best-effort: warn when an on-site relist restored the LISTING but the
  // backing block wasn't `suspended` (so it may not serve) — observability for the
  // drift caveat above. Dynamic import keeps the logging graph out of the tx path.
  if (onsiteBlockRestoreDrift) {
    void import('~/server/logging/client')
      .then(({ logToAxiom }) =>
        logToAxiom(
          {
            type: 'warning',
            name: 'app-listing-relist-block-drift',
            message: 'onsite relist: backing app_block was not suspended; the block may not serve',
            details: { appListingId: input.appListingId, appBlockId: listing.appBlockId },
          },
          'app-blocks'
        )
      )
      .catch(() => undefined);
  }

  return { appListingId: input.appListingId, status: 'approved' };
}

export type ClaimListingResult = { appListingId: string; userId: number };

/**
 * MOD claim (reassign ownership of) an off-site listing (PR4) — the mod-arbitrated
 * ownership transfer that resolves an impersonation / verified-owner dispute. A mod
 * verifies ownership OUT-OF-BAND, then re-points `AppListing.userId` from the current
 * owner to `targetUserId`; the mod IS the whole trust boundary (there is NO
 * self-service `protectedProcedure` claim endpoint — a user cannot claim their own
 * listing).
 *
 * Guards (mirror delist/relist/purge):
 *   - KIND: offsite-only. An on-site `AppListing` is 1:1 with an owned `AppBlock`, so
 *     reassigning its `userId` would desync it from the backing block's real owner —
 *     rejected via the shared `classifyOffsiteListing` (missing/on-site → generic
 *     NOT_FOUND, no tx; info-leak parity with the other actions).
 *   - STATUS: only `approved` OR `removed` (a mod-verified owner may reclaim a live
 *     OR a delisted listing). A draft/pending/rejected listing → NOT_TRANSITIONABLE,
 *     no event.
 *   - TARGET USER: `targetUserId` must be a REAL `User` — validated on the PRIMARY
 *     inside the tx so a bad id is a friendly INVALID_TARGET_USER (BAD_REQUEST), NOT
 *     a raw FK 23503 leaking as an INTERNAL error.
 *
 * The pre-state (`before.userId` + `slug` + the status/kind re-check) is snapshotted
 * from the PRIMARY inside the tx (mirroring purge's in-tx-snapshot fix) — a replica
 * read could otherwise stamp a stale owner under replica lag. The reassign is a
 * status-guarded `updateMany` (`status IN (approved,removed)`); a 0-count means a
 * concurrent action moved the row → NOT_TRANSITIONABLE, and the tx rolls back BEFORE
 * the audit event is written (ZERO events on a guarded/rolled-back claim).
 *
 * 🔴 `AppListingPublishRequest.submittedByUserId` is left INTACT (the locked
 * decision): claim reassigns the listing OWNER only; the historical submission record
 * is preserved for audit fidelity (who actually submitted it). This fn NEVER touches
 * the publish request. The audit event's before/after userId captures the transfer.
 *
 * 🔴 IT DOES, HOWEVER, CLEAR THE COLLABORATOR SEATS — and that is NEW, because until
 * seats were re-keyed to `app_listings` an off-site listing could not hold one, so
 * "reassign `userId`" WAS the complete remediation. It no longer is. This is the
 * IMPERSONATION remedy (report → delist → claim → ban): the row being claimed was set up
 * by someone pretending to be the rightful owner, and everything that impersonator
 * attached to it is part of what is being taken away. Left behind, their seats would
 * survive the claim as live editor capability on the REAL owner's listing —
 * `listingContent`, `submitForReview` and `analytics` — their PENDING invites would stay
 * acceptable, their accepted-and-displayed seats would keep appearing in the PUBLIC
 * BYLINE under the new owner's name, and a pending ownership TRANSFER they had already
 * offered would stay acceptable, handing the listing straight back out. So, in the SAME
 * transaction as the reassign: every seat is deleted (any status), every pending
 * transfer is cancelled, and each is recorded as an `AppOwnershipEvent` so the removal
 * is auditable rather than silent. The new owner re-invites whoever they actually want.
 *
 * 🔴 That cleanup is CONDITIONAL on the collaborator tables existing, checked ONCE
 * before the transaction opens. They are manual-apply (DB rule #8), and a statement
 * against a missing relation ABORTS the surrounding Postgres transaction — a `catch`
 * cannot undo that (every later statement fails 25P02), so `safeCollaboratorQuery`'s
 * degrade-to-fallback CANNOT be used inside a tx. Probing outside it keeps the claim
 * working unchanged in the pre-migration window, where no seat can exist anyway.
 *
 * Optionally links + resolves the triggering `reportId` in the SAME tx (mirrors
 * delist EXACTLY, listing-scoped): in the impersonation workflow (report → delist →
 * claim → ban) the claim is the substantive resolution, so it ties to and closes the
 * report just like delist. A mismatched/already-closed reportId is a silent no-op —
 * the claim still succeeds.
 */
export async function claimListing(opts: {
  input: ClaimListingInput;
  reviewerUserId: number;
}): Promise<ClaimListingResult> {
  const { input, reviewerUserId } = opts;
  const reason = requireModReason(input.reason);
  const now = new Date();
  // Fail-fast + info-leak parity (replica): a missing OR on-site listing throws the
  // same generic NOT_FOUND before any tx is opened. The authoritative snapshot is
  // re-read on the primary inside the tx below.
  await classifyOffsiteListing(input.appListingId);

  // 🔴 OUTSIDE THE TX ON PURPOSE — see the header. A query against a missing relation
  // aborts the whole Postgres transaction, so the missing-table degrade has to happen
  // before one is opened. `false` ⇒ the manual-apply migration has not landed ⇒ no seat
  // can exist ⇒ the claim behaves exactly as it did before this feature.
  const seatsTableLive = await safeCollaboratorQuery(async () => {
    await dbRead.appCollaborator.count({ where: { appListingId: input.appListingId } });
    return true;
  }, false);

  await dbWrite.$transaction(async (tx) => {
    // Authoritative pre-state snapshot from the PRIMARY (not the replica classify),
    // so `before.userId` + `slug` reflect the TRUE current row and the kind/status
    // guards are re-checked on the primary. A row that vanished (or turned
    // non-offsite) between classify and here → generic NOT_FOUND, tx rolls back with
    // no event written.
    const current = await tx.appListing.findUnique({
      where: { id: input.appListingId },
      select: { userId: true, status: true, slug: true, kind: true },
    });
    if (!current || current.kind !== 'offsite') {
      throw new OffsiteModerationError('NOT_FOUND', 'Standalone listing not found.');
    }
    // Status guard: claim is allowed only on an approved OR removed listing (a
    // mod-verified owner may reclaim a live OR a delisted listing). draft/pending/
    // rejected → NOT_TRANSITIONABLE, no event.
    if (current.status !== 'approved' && current.status !== 'removed') {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'Only an approved or delisted listing can be reassigned.'
      );
    }
    // Validate the target is a REAL user — a friendly error rather than relying on
    // the FK to 23503-fail (which would surface as a generic INTERNAL). Read on the
    // primary (inside the tx) so the check is consistent with the write below.
    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select: { id: true },
    });
    if (!target) {
      throw new OffsiteModerationError(
        'INVALID_TARGET_USER',
        'The target user could not be found.'
      );
    }
    // Status-guarded reassign (TOCTOU): a 0-count means a concurrent action moved the
    // row out of {approved,removed} → NOT_TRANSITIONABLE, rolls the tx (incl. the
    // event) back. `AppListingPublishRequest.submittedByUserId` is deliberately NOT
    // touched (locked decision — the submission record is historical).
    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: 'offsite', status: { in: ['approved', 'removed'] } },
      data: { userId: input.targetUserId },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be reassigned.'
      );
    }
    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: input.appListingId,
        slug: current.slug,
        action: 'claim',
        actorUserId: reviewerUserId,
        reason,
        reportId: input.reportId ?? null,
        before: { userId: current.userId },
        after: { userId: input.targetUserId },
      },
    });

    // 🔴 SEAT REMEDIATION — in the SAME tx as the reassign, so a rolled-back claim
    // leaves the seats untouched exactly as it leaves zero moderation events. See the
    // header for why "reassign userId" stopped being the whole remedy.
    if (seatsTableLive) {
      // Read the ids BEFORE deleting: `deleteMany` returns a count, and a count cannot
      // name who lost what. An impersonation remedy that cannot say whose access it
      // revoked is not an audit trail.
      const seats = (await tx.appCollaborator.findMany({
        where: { appListingId: input.appListingId },
        select: { userId: true, status: true },
      })) as Array<{ userId: number; status: string }>;
      if (seats.length > 0) {
        await tx.appCollaborator.deleteMany({ where: { appListingId: input.appListingId } });
        for (const seat of seats) {
          await recordOwnershipEvent(tx, {
            appListingId: input.appListingId,
            slug: current.slug,
            action: 'remove',
            actorUserId: reviewerUserId,
            targetUserId: seat.userId,
            metadata: { via: 'claim', previousStatus: seat.status },
          });
        }
      }
      // A pending transfer the previous (impersonating) owner had already offered would
      // otherwise stay acceptable and hand the listing straight back out. Guarded on
      // `status:'pending'` so a terminal row is never re-written.
      const cancelled = await tx.appOwnershipTransfer.updateMany({
        where: { appListingId: input.appListingId, status: 'pending' },
        data: { status: 'cancelled', respondedAt: now },
      });
      if (cancelled.count > 0) {
        await recordOwnershipEvent(tx, {
          appListingId: input.appListingId,
          slug: current.slug,
          action: 'transfer_cancelled',
          actorUserId: reviewerUserId,
          metadata: { via: 'claim', cancelled: cancelled.count },
        });
      }
    }

    if (input.reportId) {
      // Resolve the triggering report in the same tx — mirrors delist EXACTLY. In the
      // impersonation flow (report → delist → claim → ban) the claim is the substantive
      // resolution, so it ties to + closes the report just like delist. Best-effort +
      // status-guarded AND SCOPED to THIS listing (`appListingId`): a `reportId` that
      // belongs to a DIFFERENT listing matches 0 rows (no cross-listing report closure)
      // — the claim of THIS listing still stands and its event still links the supplied
      // reportId; the mismatched (or already-closed) report is left untouched (silent
      // no-op, not a hard failure — the claim is the primary action, a bad reportId
      // must not fail it).
      await tx.appListingReport.updateMany({
        where: { id: input.reportId, appListingId: input.appListingId, status: 'pending' },
        data: { status: 'resolved', resolvedByUserId: reviewerUserId, resolvedAt: new Date() },
      });
    }
  });

  return { appListingId: input.appListingId, userId: input.targetUserId };
}

export type PurgeListingResult = { appListingId: string; purged: true };

/**
 * MOD hard-delete (purge) a listing — the genuine final expunge that also makes the
 * delist round-trip self-cleaning. Targets are {@link PURGEABLE_LISTING_WHERE}: any
 * OFF-SITE listing, or an ON-SITE orphan pre-approval draft.
 *
 * 🔴 THE ON-SITE ARM IS THE DELIBERATE REPLACEMENT FOR A SILENT SIDE-EFFECT, NOT NEW
 * DESTRUCTIVE POWER. `rejectRequest` used to run `deleteOnsiteDraftListingForSlug` on
 * every reject, so rejecting a first-time developer over a fixable problem destroyed the
 * store listing they had built and released their slug — invisibly, with no reason
 * recorded and no way for a reviewer to decline it. That call is gone (clawgate #302).
 * The same delete now happens only when a mod ASKS for it, through this path: explicit
 * target, required reason, and an `action:'purge'` audit event. Same bytes removed, but
 * chosen and attributable. Removing this arm without restoring some other on-site
 * removal path would leave an orphan draft holding its slug with NO recourse —
 * `delistListing` is status-guarded to `{approved, removed}` and cannot touch a draft.
 *
 * 🔴 ORDER MATTERS: the audit event is written FIRST (capturing the slug snapshot +
 * the pre-delete status), THEN the `AppListing` row is deleted. The event's
 * `appListingId` FK is `ON DELETE SET NULL`, so the delete nulls the event's
 * `appListingId` but the event row + its denormalized `slug` survive at the ROW
 * level (compliance/forensics — an append-only audit trail must outlive the row it
 * references). NOTE: because the FK is nulled on purge, a purged listing's events
 * are NOT retrievable via `listModerationEvents({appListingId})` (the per-listing
 * history read) — post-purge they're reachable only via the actor index or raw SQL
 * (a slug-keyed orphaned-events read path is deferred to pre-GA).
 * `AppListingScreenshot` + `AppListingReport` cascade-delete with the listing
 * (intended). Both the event write + the delete are in ONE tx; a 0-count delete
 * (raced) rolls the event back.
 *
 * The pre-delete snapshot (status/slug + the kind guard) is re-read INSIDE the tx
 * from the PRIMARY (`tx.appListing.findUnique`), NOT from the replica classify —
 * under replica lag the replica read could otherwise stamp a stale `before.status`
 * (e.g. `approved` on a row already `removed`). The early replica `classify` is
 * kept only as a fail-fast + info-leak-parity gate (missing/on-site → generic
 * NOT_FOUND with no tx opened).
 */
export async function purgeListing(opts: {
  input: PurgeListingInput;
  reviewerUserId: number;
}): Promise<PurgeListingResult> {
  const { input, reviewerUserId } = opts;
  const reason = requireModReason(input.reason);
  // Fail-fast + info-leak parity (replica): a missing listing, and any listing outside
  // PURGEABLE_LISTING_WHERE, both throw the same generic NOT_FOUND before any tx is
  // opened. The authoritative snapshot is re-read on the primary inside the tx below.
  await classifyPurgeableListing(input.appListingId);

  await dbWrite.$transaction(async (tx) => {
    // Authoritative pre-delete snapshot from the PRIMARY (not the replica classify),
    // so `before.status` + `slug` reflect the true current row and the purgeability
    // guard is re-checked on the primary. A row that vanished (or moved out of the
    // purgeable set) between classify and here → generic NOT_FOUND, tx rolls back with
    // no event written.
    //
    // 🔴 RE-CHECKING ON THE PRIMARY IS NOT REDUNDANT FOR THE ON-SITE ARM — it is the
    // race that matters. `approveRequest` turns exactly this row from an orphan draft
    // into an APPROVED listing with a backing AppBlock, so a purge that classified
    // against a lagging replica could otherwise delete a live app's store card. The
    // predicate is re-evaluated here and AGAIN in the `deleteMany` below.
    const current = await tx.appListing.findUnique({
      where: { id: input.appListingId },
      select: {
        status: true,
        slug: true,
        kind: true,
        appBlockId: true,
        revisionOfId: true,
      },
    });
    if (!current || !isPurgeableListing(current)) {
      throw new OffsiteModerationError('NOT_FOUND', 'Standalone listing not found.');
    }
    // Event FIRST (so the slug/state snapshot is captured before the row is gone).
    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: input.appListingId,
        slug: current.slug,
        action: 'purge',
        actorUserId: reviewerUserId,
        reason,
        before: { status: current.status },
      },
    });
    // THEN the hard delete (nulls the event's appListingId via SetNull; cascades
    // screenshots + reports). The inline purgeability guard mirrors delist/relist for
    // defense-in-depth on a DESTRUCTIVE op — a 0-count delete (raced, or a row slipping
    // past both classify AND the primary re-read) throws → the tx (incl. the event)
    // rolls back. This is the SQL twin of `isPurgeableListing` above; they are kept
    // next to each other so they can only drift together.
    const deleted = await tx.appListing.deleteMany({
      where: { id: input.appListingId, ...PURGEABLE_LISTING_WHERE },
    });
    if (deleted.count === 0) {
      // Raced (concurrently purged between the snapshot and here) → roll the event back.
      throw new OffsiteModerationError('NOT_FOUND', 'Standalone listing not found.');
    }
  });

  return { appListingId: input.appListingId, purged: true };
}

/**
 * Shared close-a-report path for resolve/dismiss: status-guarded flip
 * (pending → resolved|dismissed) + one audit event in the same tx. A non-pending
 * report → REPORT_NOT_PENDING (rolls back before the event). The optional `note`
 * lands on the event's `reason` (nullable — no note is fine).
 */
async function closeReport(opts: {
  reportId: string;
  reviewerUserId: number;
  note?: string;
  target: 'resolved' | 'dismissed';
  action: 'report-resolve' | 'report-dismiss';
}): Promise<void> {
  const report = await dbRead.appListingReport.findUnique({
    where: { id: opts.reportId },
    select: { id: true, status: true, appListingId: true, appListing: { select: { slug: true } } },
  });
  if (!report) throw new OffsiteModerationError('NOT_FOUND', 'Report not found.');

  const note = opts.note?.trim() ? opts.note.trim() : null;

  await dbWrite.$transaction(async (tx) => {
    const flipped = await tx.appListingReport.updateMany({
      where: { id: opts.reportId, status: 'pending' },
      data: { status: opts.target, resolvedByUserId: opts.reviewerUserId, resolvedAt: new Date() },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'REPORT_NOT_PENDING',
        'This report has already been handled.'
      );
    }
    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: report.appListingId,
        slug: report.appListing?.slug ?? '(unknown)',
        action: opts.action,
        actorUserId: opts.reviewerUserId,
        reason: note,
        reportId: opts.reportId,
        before: { status: 'pending' },
        after: { status: opts.target },
      },
    });
  });
}

/** MOD resolve a pending report (pending → resolved). */
export async function resolveReport(opts: {
  input: ResolveReportInput;
  reviewerUserId: number;
}): Promise<void> {
  await closeReport({
    reportId: opts.input.reportId,
    reviewerUserId: opts.reviewerUserId,
    note: opts.input.note,
    target: 'resolved',
    action: 'report-resolve',
  });
}

/** MOD dismiss a pending report (pending → dismissed; no action taken). */
export async function dismissReport(opts: {
  input: DismissReportInput;
  reviewerUserId: number;
}): Promise<void> {
  await closeReport({
    reportId: opts.input.reportId,
    reviewerUserId: opts.reviewerUserId,
    note: opts.input.note,
    target: 'dismissed',
    action: 'report-dismiss',
  });
}

// ---------------------------------------------------------------------------
// listModerationEvents (moderator) — per-listing append-only audit history.
// ---------------------------------------------------------------------------

/**
 * PII-safe moderation-event projection: the audit fields + the acting mod's public
 * chip ({id,username,image}) + the denormalized slug. No raw actorUserId FK. Used by
 * the MOD-facing `listModerationEvents` only.
 */
const moderationEventSelect = {
  id: true,
  appListingId: true,
  slug: true,
  action: true,
  reason: true,
  detail: true,
  before: true,
  after: true,
  reportId: true,
  createdAt: true,
  actor: { select: { id: true, username: true, image: true } },
} as const;

/**
 * OWNER-scoped projection for a listing OWNER reading their OWN moderation history
 * ("why was this hidden / un-approved"). 🔴 Privacy: deliberately DROPS the acting
 * moderator's chip (`actor`), the linked `reportId`, the `detail` blob, and the
 * `before`/`after` snapshots — so a taken-down app's owner never learns WHICH mod
 * delisted/purged it (a harassment vector) nor sees internal report/detail fields.
 * Returns only what the owner history modal renders: the action, when, and the
 * verbatim reason (+ `id` for the React key / keyset cursor). The mod-facing
 * `moderationEventSelect` above is UNCHANGED (mods still see the actor).
 */
const ownerModerationEventSelect = {
  id: true,
  action: true,
  reason: true,
  createdAt: true,
} as const;

/**
 * Per-listing moderation history, NEWEST-first, keyset-paginated. The cursor is the
 * event id (`alme_<ULID>`, time-sortable so it tracks the `createdAt desc` order);
 * the `id` tie-break makes same-millisecond ordering deterministic. `ownerScoped`
 * selects the privacy-minimal `ownerModerationEventSelect` (no mod identity / report/
 * detail) for the owner read; the mod read keeps the full `moderationEventSelect`.
 */
async function queryModerationEvents(opts: {
  appListingId: string;
  cursor?: string;
  limit?: number;
  ownerScoped?: boolean;
}) {
  const limit = Math.min(opts.limit ?? 25, 50);
  const rows = await dbRead.appListingModerationEvent.findMany({
    where: { appListingId: opts.appListingId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: opts.ownerScoped ? ownerModerationEventSelect : moderationEventSelect,
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}

export async function listModerationEvents(opts: ListModerationEventsInput) {
  return queryModerationEvents(opts);
}

// ---------------------------------------------------------------------------
// W13 post-approval listing management (Phase 1).
//   resetListingToPending  — MOD bounce an approved off-site listing back to review.
//   unpublishOwnListing    — OWNER self-hide an approved off-site listing.
//   republishOwnListing    — OWNER restore an OWNER-unpublished off-site listing
//                            (forbidden if the last event was a mod takedown).
//   listMyListingModerationEvents — OWNER-scoped per-listing audit history.
//
// resetListingToPending is offsite-only + `moderatorProcedure`; the three owner
// procs are offsite-only + `appDeveloperProcedure`, and every owner proc is bound to
// the caller (`AppListing.userId === callerUserId`, else NOT_OWNED → FORBIDDEN). All
// write exactly one `AppListingModerationEvent` in the same tx as their mutation
// (a guarded 0-count rolls the whole tx — incl. the event — back).
// ---------------------------------------------------------------------------

export type ResetListingToPendingResult = {
  appListingId: string;
  status: 'pending';
  publishRequestId: string;
};

/**
 * MOD reset an APPROVED off-site listing back into the review queue (approved →
 * pending). In ONE tx (authoritative on the PRIMARY): guard-flip the listing
 * approved → pending (offsite + status-guarded; 0-count → NOT_TRANSITIONABLE),
 * mint a FRESH `pending` `AppListingPublishRequest` owned by the listing owner
 * (`submittedByUserId = AppListing.userId`) so the listing re-enters the mod queue
 * (a NON-shadow request — `approveExternalRequest`'s widened `{draft,pending}` guard
 * re-approves it), and write a `reset-to-pending` audit event. Post-commit,
 * best-effort: notify the owner their app needs another review (carrying the reason).
 *
 * Offsite-only (mirrors claim/purge): a missing OR on-site listing → generic
 * NOT_FOUND. The owner snapshot is read on the PRIMARY inside the tx (a replica read
 * could stamp a stale owner under lag).
 */
export async function resetListingToPending(opts: {
  input: ResetListingToPendingInput;
  reviewerUserId: number;
}): Promise<ResetListingToPendingResult> {
  const { input, reviewerUserId } = opts;
  const reason = requireModReason(input.reason);
  // Fail-fast + info-leak parity (replica): missing/on-site → generic NOT_FOUND
  // before any tx. The authoritative snapshot is re-read on the primary in the tx.
  await classifyOffsiteListing(input.appListingId);

  const eventId = newAppListingModerationEventId();
  const publishRequestId = newAppListingPublishRequestId();
  let ownerUserId = 0;
  let slug = '';
  let name: string | null = null;

  await dbWrite.$transaction(async (tx) => {
    const current = await tx.appListing.findUnique({
      where: { id: input.appListingId },
      select: { userId: true, status: true, kind: true, slug: true, name: true },
    });
    if (!current || current.kind !== 'offsite') {
      throw new OffsiteModerationError('NOT_FOUND', 'Standalone listing not found.');
    }
    ownerUserId = current.userId;
    slug = current.slug;
    name = current.name;

    // Guard-flip approved → pending (offsite + status-guarded TOCTOU).
    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: 'offsite', status: 'approved' },
      data: { status: 'pending' },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'Only an approved listing can be reset to pending.'
      );
    }

    // Re-enter the review queue: a fresh pending request pointing at the (now
    // pending) listing, submitted-by the OWNER (not the acting mod) so the queue +
    // my-submissions attribute it to the owner. Non-shadow (no revisionOfId), so
    // re-approve runs the first-time approve path.
    await tx.appListingPublishRequest.create({
      data: {
        id: publishRequestId,
        appListingId: input.appListingId,
        kind: 'offsite',
        slug: current.slug,
        submittedByUserId: current.userId,
        status: 'pending',
      },
    });

    await tx.appListingModerationEvent.create({
      data: {
        id: eventId,
        appListingId: input.appListingId,
        slug: current.slug,
        action: 'reset-to-pending',
        actorUserId: reviewerUserId,
        reason,
        before: { status: 'approved' },
        after: { status: 'pending' },
      },
    });
  });

  await notifyAppListingOwner({
    type: 'app-listing-reset-to-pending',
    userId: ownerUserId,
    key: `app-listing-reset-to-pending:${eventId}`,
    details: { slug, name, listingId: input.appListingId, reason },
  });

  return { appListingId: input.appListingId, status: 'pending', publishRequestId };
}

export type ResetOnsiteListingToPendingResult = {
  appListingId: string;
  status: 'pending';
  publishRequestId: string;
};

/**
 * MOD reset an APPROVED ON-SITE (hosted app-block) listing back into the block
 * review queue (the W13-deferred onsite reset-to-pending — now built). Mirrors the
 * offsite `resetListingToPending` semantics across the DIFFERENT onsite plumbing:
 * onsite review runs through the SEPARATE `app_block_publish_requests` table + the
 * iframe sandbox (not the offsite `AppListingPublishRequest` queue), and the block's
 * RUNTIME serving gate reads `app_blocks.status` — so an onsite reset must ALSO stop
 * the block serving, not merely hide the store listing.
 *
 * PARALLEL PATH (design choice): kept as a SEPARATE function rather than folding
 * onsite into `resetListingToPending`, because the two re-queue mechanics share no
 * writes — offsite mints an `AppListingPublishRequest`, onsite CLONES the most-recent
 * approved `AppBlockPublishRequest` (assets/version/manifest KEPT) so the block
 * re-enters the queue with NO owner resubmit. A dual-kind merge would be a tangle of
 * `if (onsite)` branches over two tables; two focused functions read cleaner.
 *
 * In ONE tx (authoritative on the PRIMARY):
 *   1. guard-flip the listing approved → pending (onsite + status-guarded; 0-count →
 *      NOT_TRANSITIONABLE),
 *   2. suspend the backing block approved → suspended (`flipBackingBlockStatus`) — the
 *      REAL runtime stop, so `<slug>.civit.ai` / the run page stops serving while it
 *      re-reviews (a store-hide alone would leave it live),
 *   3. clone the latest APPROVED block publish request into a FRESH `pending` one
 *      (owned by the listing owner) so it re-enters `listPendingRequests`; a mod then
 *      re-approves it through the EXISTING `approveRequest` flow (which restores the
 *      listing pending → approved + un-suspends the block — see the approve widen),
 *   4. write a `reset-to-pending` audit event.
 * Post-commit, best-effort: notify the owner their app needs another review.
 *
 * ONSITE-only (mirrors the offsite kind guard): a missing OR off-site listing → generic
 * NOT_FOUND. No approved version to clone (an app never fully approved) → NOT_TRANSITIONABLE.
 * A pending block request already open for the slug → NOT_TRANSITIONABLE (the partial-
 * unique `app_block_publish_requests_one_pending_per_slug` also enforces it; we
 * pre-check for a friendly error and catch its P2002 as a race backstop).
 */
export async function resetOnsiteListingToPending(opts: {
  input: ResetListingToPendingInput;
  reviewerUserId: number;
}): Promise<ResetOnsiteListingToPendingResult> {
  const { input, reviewerUserId } = opts;
  const reason = requireModReason(input.reason);

  // Classify on the replica: must be an ON-SITE listing with a backing block. A
  // missing/off-site listing → generic NOT_FOUND (kind-probe guard, mirrors offsite).
  const listing = await dbRead.appListing.findUnique({
    where: { id: input.appListingId },
    select: {
      id: true,
      kind: true,
      status: true,
      slug: true,
      name: true,
      userId: true,
      appBlockId: true,
    },
  });
  if (!listing || listing.kind !== 'onsite' || !listing.appBlockId) {
    throw new OffsiteModerationError('NOT_FOUND', 'On-site listing not found.');
  }
  const appBlockId = listing.appBlockId;

  // The version to re-review is the CURRENTLY-approved one: clone the most-recent
  // approved block publish request (assets/version/manifest KEPT — no owner resubmit).
  const lastApproved = await dbRead.appBlockPublishRequest.findFirst({
    where: { slug: listing.slug, status: 'approved' },
    orderBy: [{ submittedAt: 'desc' }],
    select: {
      appBlockId: true,
      version: true,
      manifest: true,
      bundleKey: true,
      bundleSha256: true,
      bundleSizeBytes: true,
      fileSummary: true,
      manifestDiffSummary: true,
      forgejoCommitSha: true,
      // #4059 — selected so the clone below can CARRY them. See the create.
      sourceCommit: true,
      sourceDirty: true,
    },
  });
  if (!lastApproved) {
    throw new OffsiteModerationError(
      'NOT_TRANSITIONABLE',
      'This app has no approved version to re-review.'
    );
  }

  // Friendly pre-check: an open pending request for this slug means a review is
  // already in flight — the DB partial-unique index would otherwise reject the clone
  // with a raw P2002.
  const openPending = await dbRead.appBlockPublishRequest.findFirst({
    where: { slug: listing.slug, status: 'pending' },
    select: { id: true },
  });
  if (openPending) {
    throw new OffsiteModerationError(
      'NOT_TRANSITIONABLE',
      'A review is already pending for this app.'
    );
  }

  const eventId = newAppListingModerationEventId();
  const publishRequestId = `pubreq_${newUlid()}`;

  try {
    await dbWrite.$transaction(async (tx) => {
      // (1) guard-flip listing approved → pending (onsite + status-guarded TOCTOU).
      const flipped = await tx.appListing.updateMany({
        where: { id: input.appListingId, kind: 'onsite', status: 'approved' },
        data: { status: 'pending' },
      });
      if (flipped.count === 0) {
        throw new OffsiteModerationError(
          'NOT_TRANSITIONABLE',
          'Only an approved listing can be reset to pending.'
        );
      }

      // (2) suspend the backing block (approved → suspended) — the real runtime stop.
      // Status-guarded to `approved`; non-fatal on a 0-count (a drifted/already-
      // suspended block; the LISTING flip is the authoritative gate). Mirrors delist.
      await flipBackingBlockStatus(tx, {
        isOnsite: true,
        appBlockId,
        from: 'approved',
        to: 'suspended',
      });

      // (3) re-enter the review queue: clone the latest approved request into a FRESH
      // `pending` one, submitted-by the OWNER (so my-submissions + the queue attribute
      // it to the owner, not the acting mod). Same assets/version/manifest → a mod
      // re-approves with no owner resubmit. The partial-unique index (one pending per
      // slug) is satisfied (we pre-checked); a raced create fires P2002 → caught below.
      await tx.appBlockPublishRequest.create({
        data: {
          id: publishRequestId,
          appBlockId: lastApproved.appBlockId ?? appBlockId,
          slug: listing.slug,
          submittedByUserId: listing.userId,
          version: lastApproved.version,
          manifest: lastApproved.manifest as Prisma.InputJsonValue,
          bundleKey: lastApproved.bundleKey,
          bundleSha256: lastApproved.bundleSha256,
          bundleSizeBytes: lastApproved.bundleSizeBytes,
          fileSummary: lastApproved.fileSummary as Prisma.InputJsonValue,
          manifestDiffSummary: lastApproved.manifestDiffSummary as Prisma.InputJsonValue,
          forgejoCommitSha: lastApproved.forgejoCommitSha,
          // #4059 — carry the client's provenance CLAIM forward, verbatim.
          //
          // The justification is narrow and it is the only one: this clone
          // re-submits BYTE-IDENTICAL bundle bytes (same `bundleKey`, same
          // `bundleSha256` as the approved row above). A claim about which tree
          // those exact bytes came from is still the SAME claim about the SAME
          // bytes — copying it invents nothing. Dropping it would permanently
          // lose the answer to "which tree did these bytes come from?" for any
          // app that goes through a suspend → reset-to-pending cycle, which is
          // the archaeology #4059 exists to make unnecessary.
          //
          // Copied RAW, including NULL: a NULL on the source row means UNKNOWN
          // and must stay UNKNOWN here. No `??` fallback of any kind — least of
          // all to `forgejoCommitSha`, which is a SERVER-side sha in the
          // platform's own repo and would fabricate an author's-tree claim
          // nobody made. `false` likewise stays `false` (asserted CLEAN), never
          // folded into UNKNOWN.
          //
          // 🔴 NOT the `recordPendingFromPush` case, which correctly writes
          // NEITHER: that path has no client and no author work tree, so there
          // is no claim in existence to carry.
          sourceCommit: lastApproved.sourceCommit,
          sourceDirty: lastApproved.sourceDirty,
          status: 'pending',
        },
      });

      // (4) audit event.
      await tx.appListingModerationEvent.create({
        data: {
          id: eventId,
          appListingId: input.appListingId,
          slug: listing.slug,
          action: 'reset-to-pending',
          actorUserId: reviewerUserId,
          reason,
          before: { status: 'approved' },
          after: { status: 'pending' },
        },
      });
    });
  } catch (err) {
    // A concurrent submit/reset won the one-pending-per-slug race → friendly error.
    if ((err as { code?: unknown })?.code === 'P2002') {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'A review is already pending for this app.'
      );
    }
    throw err;
  }

  await notifyAppListingOwner({
    type: 'app-listing-reset-to-pending',
    userId: listing.userId,
    key: `app-listing-reset-to-pending:${eventId}`,
    details: { slug: listing.slug, name: listing.name, listingId: input.appListingId, reason },
  });

  return { appListingId: input.appListingId, status: 'pending', publishRequestId };
}

/**
 * Load a listing the caller OWNS for an owner action, on the PRIMARY inside a tx.
 * DUAL-KIND (W13 P4): both on-site AND off-site listings are valid owner self-service
 * targets — the on-site path additionally flips the backing block (see
 * {@link flipBackingBlockStatus}), so `kind` + `appBlockId` are returned to branch it.
 * A missing listing → generic NOT_FOUND; a listing owned by someone else → NOT_OWNED
 * (router → FORBIDDEN). (Widened from the P3 offsite-only `loadOwnedOffsiteInTx`.)
 */
async function loadOwnedListingInTx(
  tx: Prisma.TransactionClient,
  appListingId: string,
  callerUserId: number
): Promise<{
  userId: number;
  status: string;
  kind: string;
  slug: string;
  name: string | null;
  appBlockId: string | null;
  contentRating: string | null;
  iconId: number | null;
  coverId: number | null;
}> {
  const listing = await tx.appListing.findUnique({
    where: { id: appListingId },
    select: {
      userId: true,
      status: true,
      kind: true,
      slug: true,
      name: true,
      appBlockId: true,
      // The DECLARED rating, the input to `republishOwnListing`'s go-live rating floor.
      // `unpublishOwnListing` ignores it — a self-hide never touches the rating.
      contentRating: true,
      // The two scalar halves of the reviewable ASSET SURFACE (the third — screenshots —
      // is a child table). Selected HERE, on the row both owner procs already load on the
      // primary inside their transaction, so `buildApprovedAssetSnapshot` neither re-reads
      // them nor opens a second window in which they could move relative to the
      // screenshots it does read. See `app-listing-approved-assets`.
      iconId: true,
      coverId: true,
    },
  });
  if (!listing) {
    throw new OffsiteModerationError('NOT_FOUND', 'Listing not found.');
  }
  if (listing.userId !== callerUserId) {
    throw new OffsiteModerationError('NOT_OWNED', 'You can only manage your own listings.');
  }
  return {
    userId: listing.userId,
    status: listing.status,
    kind: listing.kind,
    slug: listing.slug,
    name: listing.name,
    appBlockId: listing.appBlockId,
    contentRating: listing.contentRating,
    iconId: listing.iconId,
    coverId: listing.coverId,
  };
}

export type UnpublishOwnListingResult = { appListingId: string; status: 'removed' };

/**
 * OWNER self-hide their OWN approved listing (approved → removed) — DUAL-KIND
 * (W13 P4). A pure visibility toggle: NO content-rating re-derive, NO asset change,
 * NO publish request. In ONE tx (primary): owner-load + guard owner/status, guard-flip
 * the listing approved → removed (0-count → NOT_TRANSITIONABLE), write an
 * `owner-unpublish` event.
 *
 * ON-SITE: it's a FULL TAKEDOWN — the backing `AppBlock` is also flipped approved →
 * suspended in the SAME tx (via {@link flipBackingBlockStatus}), so the app leaves the
 * store AND stops serving at `<slug>.civit.ai` / the run page (the block runtime gate
 * reads `app_blocks.status`). OFF-SITE: only the listing flips (no backing block). No
 * notification (the owner performed the action). `reason` optional.
 */
export async function unpublishOwnListing(opts: {
  input: UnpublishOwnListingInput;
  userId: number;
}): Promise<UnpublishOwnListingResult> {
  const { input, userId } = opts;
  const reason = input.reason?.trim() ? input.reason.trim() : null;

  await dbWrite.$transaction(async (tx) => {
    const listing = await loadOwnedListingInTx(tx, input.appListingId, userId);
    if (listing.status !== 'approved') {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'Only an approved listing can be unpublished.'
      );
    }
    const isOnsite = listing.kind === 'onsite';
    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: listing.kind, status: 'approved' },
      data: { status: 'removed' },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be unpublished.'
      );
    }
    // ON-SITE full takedown: suspend the backing block so the runtime stops serving.
    await flipBackingBlockStatus(tx, {
      isOnsite,
      appBlockId: listing.appBlockId,
      from: 'approved',
      to: 'suspended',
    });
    // 🔴 RECORD THE APPROVED ASSET SURFACE. This is the ONLY place the store learns what
    // imagery a moderator last signed off on — nothing else in the schema captures it (no
    // approve path writes a moderation event at all, and every existing `before`/`after`
    // payload is `{status}`/`{userId}`). `republishOwnListing` compares against it to
    // decide whether a republish may go live immediately or has to re-enter review.
    //
    // WHY IT IS SOUND HERE AND NOWHERE CHEAPER: the flip above ran on a listing that was
    // `approved`, and an approved non-shadow listing is NOT owner-asset-editable
    // (`assertOwnerAssetEditable`), so the assets read here ARE the last-approved ones. It
    // is read on the PRIMARY inside the SAME tx as the flip, so a concurrent asset write
    // cannot slip between the snapshot and the removal.
    //
    // It goes in `before` because that is the state this event moved AWAY from — the
    // approved one. `after` describes the `removed` state, whose assets are about to
    // become freely editable and therefore mean nothing to a later reviewer.
    const approvedAssets = await buildApprovedAssetSnapshot(tx, input.appListingId, listing);
    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: input.appListingId,
        slug: listing.slug,
        action: 'owner-unpublish',
        actorUserId: userId,
        reason,
        before: { status: 'approved', assets: approvedAssets },
        after: { status: 'removed' },
      },
    });
  });

  return { appListingId: input.appListingId, status: 'removed' };
}

/**
 * Where an owner republish LANDED.
 *
 * 🔴 `'pending'` IS A REAL, EXPECTED OUTCOME, NOT AN ERROR — the listing did not go live
 * and every surface that reports the result must branch on this field rather than
 * assuming success means "live". Telling an owner "it is live again" when it is sitting
 * in a review queue is a lie the type system now refuses to let you tell silently.
 */
export type RepublishOwnListingResult = {
  appListingId: string;
  status: 'approved' | 'pending';
  /** Set only on the `'pending'` arm — why the republish had to be reviewed. */
  reviewReason?: RepublishReviewReason;
};

/**
 * OWNER restore their OWN owner-unpublished listing — DUAL-KIND (W13 P4).
 *
 * 🔴 ASSET-CHANGE REVIEW GATE (removed → approved, OR removed → pending). An owner may
 * unpublish their own listing, swap the icon/cover/screenshots — a `removed` listing is
 * DIRECTLY asset-editable, `assertOwnerAssetEditable` refuses only an `approved`
 * non-shadow row — and republish. Before this gate that put brand-new imagery on a public
 * store card with NO content review: the two go-live gates below read scan STATUS and the
 * destination href, and #4418's floor reads MATURITY. None of them is a review.
 *
 * So: if ANY listing asset differs from what was recorded at the last approval, the
 * republish routes the listing to `pending` (re-review) instead of `approved` and mints a
 * fresh pending non-shadow `AppListingPublishRequest` — FOR BOTH KINDS. That queue is the
 * one whose moderator modal actually renders this listing's icon, cover and screenshots;
 * see {@link routeRepublishToReviewInTx} for why the on-site arm does NOT re-queue on the
 * block-request surface (a clone of the approved block request is byte-identical to what
 * the moderator already approved and shows none of the imagery under review).
 *
 * If NOTHING changed, republish is immediate exactly as it was — no extra queue entry, no
 * moderator involvement, no behaviour change at all.
 *
 * 🔴 THE SIGNAL IS RECORDED, NOT INFERRED. Nothing in the schema previously captured the
 * approved asset set (no approve path writes a moderation event; every existing
 * `before`/`after` payload is `{status}`/`{userId}`; `updatedAt` is bumped by the republish
 * flip itself and a DELETED screenshot leaves no timestamp at all).
 * {@link unpublishOwnListing} now records it into the `owner-unpublish` event's
 * `before.assets`.
 *
 * 🔴 A LISTING UNPUBLISHED BEFORE THAT SHIPPED HAS NO BASELINE, AND THAT ARM IS
 * DELIBERATELY FAIL-OPEN — it republishes immediately, exactly as it did before this PR.
 * Routing it to review would not make anyone look at a change (there is no recorded
 * "before" to compare against, so there is nothing to describe); it would only take the
 * entire already-removed population offline behind a moderator on ship day. A baseline
 * that EXISTS and does not parse is the opposite case — unbounded, and evidence something
 * is wrong right now — and it fails CLOSED. See `app-listing-approved-assets`.
 *
 * 🔴 THIS ADDS A SECOND WRITER OF `app_listings.status = 'pending'` ON A FORMERLY-LIVE
 * LISTING. `closeTerminalListing` (`offsite-listing.service`) and
 * `closeOnsiteResetListingOnWithdraw` (`publish-request.service`) both reason that such a
 * listing is ALWAYS mod-mandated and unconditionally write a `delist` on withdraw/reject.
 * That is now narrower than the truth, and the consequence is deliberate but not free:
 * an owner who routes themselves into review and then WITHDRAWS the request lands on
 * `removed` + `delist`, so `republishOwnListing` forbids them and a moderator must
 * `relistListing`. Fail-CLOSED, and no content reaches the store unreviewed — but it is a
 * self-inflicted lockout that did not exist before, so the withdraw affordance now SAYS SO
 * before and after the click (`ListingHistoryPanel`). Left as-is rather than loosened:
 * that predicate was made unconditional to close a real exploit (an intervening
 * `report-resolve` shifted the newest event and let an owner self-restore mod-mandated
 * content), and re-opening it is a product decision, not an implementation detail. Both
 * comments are corrected in place; see the PR body.
 *
 * 🔴 SAFETY GUARD (load-bearing, unchanged): republish is allowed ONLY when the
 * MOST-RECENT status-changing `AppListingModerationEvent` is an `owner-unpublish`. If the
 * last event is a moderator `delist`/`purge` (a takedown-for-cause), republish is
 * FORBIDDEN — an owner must NOT be able to self-restore a listing a moderator
 * removed. No events at all → also FORBIDDEN (can't prove owner-initiated removal).
 * The latest-event read + the flip are in ONE tx on the PRIMARY so a concurrent mod
 * takedown can't slip between the check and the restore.
 *
 * ON-SITE: on the IMMEDIATE arm the backing `AppBlock` is also restored suspended →
 * approved in the SAME tx (via {@link flipBackingBlockStatus}), so the app serves again.
 * On the REVIEW arm it is deliberately LEFT SUSPENDED — the app must not serve while its
 * store card is unreviewed, the same posture {@link resetOnsiteListingToPending} takes —
 * and `approveExternalRequest` un-suspends it on approve, gated on exactly the `pending`
 * on-site listing this route writes. OFF-SITE: only the listing flips. `reason` optional.
 *
 * 🔴 MATURITY IS RE-DERIVED AT GO-LIVE, UNIFORMLY FOR BOTH KINDS (this used to be a
 * pure visibility toggle with NO re-derive, which was the hole). A `removed` listing is
 * directly asset-editable and the attach path never rejects a `Scanned` MATURE image, so
 * `unpublish → attach mature media → republish` re-published mature store art under an
 * unchanged declared rating. The stored rating is therefore FLOORED at the media-derived
 * one ({@link resolveListingRatingFloorInTx}, RAISE-ONLY — tame media never lowers a
 * deliberately higher rating).
 *
 * Fail-closed: the derive runs INSIDE the tx and is not caught, so a throw leaves the
 * listing `removed`.
 */
export async function republishOwnListing(opts: {
  input: RepublishOwnListingInput;
  userId: number;
}): Promise<RepublishOwnListingResult> {
  const { input, userId } = opts;
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  // Set when the on-site block-restore flip matched 0 rows (drift — mirrors relist).
  let onsiteBlockRestoreDrift = false;
  let onsiteBlockId: string | null = null;
  // Set by the REVIEW arm; `null` means the republish went live immediately.
  let reviewReason: RepublishReviewReason | null = null;

  await dbWrite.$transaction(async (tx) => {
    const listing = await loadOwnedListingInTx(tx, input.appListingId, userId);
    if (listing.status !== 'removed') {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'Only a removed listing can be republished.'
      );
    }
    // 🔴 The most-recent moderation event must be the OWNER's own unpublish. Read on
    // the PRIMARY inside the tx (a concurrent mod delist/purge would otherwise race
    // between a replica read and the flip). A mod delist/purge (or NO event) → the
    // owner may not self-restore.
    //
    // ONE read, not two: the same row also carries the asset snapshot the review gate
    // below compares against, and the verb and the payload MUST come from the same event
    // (see `readLastStatusChangingModerationEvent`).
    const lastEvent = await readLastStatusChangingModerationEvent(tx, input.appListingId);
    if (!isOwnerUnpublishAction(lastEvent?.action)) {
      throw new OffsiteModerationError(
        'FORBIDDEN',
        'This listing was removed by a moderator and cannot be restored by its owner.'
      );
    }
    // 🔴 Scan-clean go-live gate — republish (removed → approved) puts the listing's
    // EXISTING assets back on the store; refuse if any is still scanning or was
    // `Blocked`. This is the primary hole the audit found: owner-unpublish leaves
    // iconId/coverId set, the removed listing stays directly asset-editable, so an
    // owner could attach a Pending/later-Blocked image then self-restore. No-op for a
    // normally-scanned listing; runs BEFORE the flip.
    await assertListingAssetsScanCleanInTx(tx, input.appListingId);
    // 🔴 GO-LIVE ACTIONABILITY gate — republish (removed → approved) is an OWNER-driven
    // go-live, and a removed listing is directly owner-editable, so this is the path
    // where an owner can clear the external URL (or link an OAuth client) and then
    // self-restore a listing the store cannot send anyone to. Read on the PRIMARY
    // (`tx`), row-consistent with the flip. On-site republishes no-op.
    await assertOffsiteListingActionableInTx(tx, input.appListingId);
    const isOnsite = listing.kind === 'onsite';

    // 🔴 GO-LIVE RATING FLOOR — UNIFORM, BOTH KINDS.
    //
    // Republish is an OWNER-DRIVEN go-live with NO human in the loop, and a `removed`
    // listing is DIRECTLY asset-editable (`assertOwnerAssetEditable` refuses only an
    // `approved` non-shadow row). The attach path rejects only `Blocked`/`NotFound`
    // images — never a `Scanned` MATURE one — and neither gate above inspects maturity:
    // `assertListingAssetsScanCleanInTx` reads scan STATUS, `assertOffsiteListingActionableInTx`
    // reads the href. So `unpublish → attach mature media → republish` put mature store
    // art back on a `g`-rated card, which passes `listingMatureFilter(redCapable=false)`
    // (`content_rating NOT IN ('r','x')`) and shows it to SFW-ONLY users.
    //
    // 🔴 WHY ON-SITE IS FLOORED TOO (this is EXISTING precedent, not a new policy). The
    // on-site DRAFT go-live already does exactly this: `approveRequest` reads the
    // AppBlock's manifest-declared `contentRating`, passes it through THIS SAME helper
    // and writes the floored result to the listing — for the same stated reason
    // (`publish-request.service.ts`, "🔴 RATING FLOOR (go-live)"). Two properties make
    // it safe on both kinds:
    //   - it writes `AppListing.contentRating` (the STORE CARD). The runtime .red/.com
    //     serving gate reads `AppBlock.contentRating` / `AppBlock.manifest.contentRating`
    //     — SEPARATE columns — so a raise here cannot change what the block is allowed to
    //     render. Enumerated over `src/`: no runtime gate reads the listing column, and
    //     nothing ever copies listing → block (the mirror runs block → listing only).
    //     The raise's real effect is STORE VISIBILITY, and only ever NARROWING it:
    //     `listingMatureFilter` hides the card and `getListingDetail` 404s it for
    //     SFW-only viewers. That is the point of the fix.
    //   - the raise PERSISTS: `buildListingScalarSync` deliberately EXCLUDES
    //     `contentRating` from the manifest re-sync ("mod override, floored at the
    //     derived rating" — `app-listing-mapper.ts`, restated at the approve call site in
    //     `publish-request.service.ts`), so a later version approve does not undo it.
    // 🔴 Three comments elsewhere still assert an UNQUALIFIED "on-site listings MIRROR
    // AppBlock.content_rating" (the `AppListing.contentRating` schema comment, the
    // mapper's create path, the backfill service) and the on-site media-revision copy
    // step declines to floor. Those describe the block → listing MIRROR and that one copy
    // step; they are narrower than the code, which already floors on-site at draft
    // go-live and on mod live-edit. Not rewritten here — see the PR body's open item.
    //
    // Derived BEFORE the flip and NOT wrapped in try/catch: a throw here aborts the tx,
    // so a listing whose rating cannot be derived does NOT go live (fail-closed).
    //
    // RAISE-ONLY is the helper's contract — it returns `declaredRating` unchanged unless
    // the derived ceiling is strictly higher — so writing the result UNCONDITIONALLY is
    // safe: tame media can never lower a deliberately higher declaration, and an
    // unchanged rating writes its own value back. Same shape as `approveRequest`'s.
    const flooredRating = await resolveListingRatingFloorInTx(
      tx,
      input.appListingId,
      listing.contentRating
    );

    // 🔴 THE ASSET-CHANGE REVIEW GATE. Compare the listing's CURRENT reviewable asset
    // surface against the one recorded when the owner unpublished it (= the one a
    // moderator last approved — see the function doc). Read on the PRIMARY, inside this
    // tx, so it is row-consistent with the flip it decides.
    //
    // 🔴 A MISSING BASELINE AND AN UNREADABLE ONE GO OPPOSITE WAYS, which is the whole
    // reason this is not a bare `!==` and not a bare null-check either.
    // `readRecordedAssetBaseline` distinguishes "this event carries no `assets` key"
    // (every listing unpublished before this feature shipped — a bounded, shrinking set
    // with no change to review, so republish stays immediate exactly as it always was)
    // from "it carries one and it does not parse" (unbounded, something is wrong now →
    // review). See `app-listing-approved-assets`.
    //
    // 🔴 IT RUNS AFTER THE RATING FLOOR ON PURPOSE. The floor is applied on BOTH arms —
    // #4418's guarantee must not depend on which arm a republish takes.
    const liveAssets = await buildApprovedAssetSnapshot(tx, input.appListingId, listing);
    reviewReason = resolveRepublishReviewReason(
      readRecordedAssetBaseline(lastEvent?.before),
      liveAssets
    );

    if (reviewReason) {
      await routeRepublishToReviewInTx(tx, {
        appListingId: input.appListingId,
        listing,
        userId,
        reason,
        reviewReason,
        flooredRating,
      });
      return;
    }

    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: listing.kind, status: 'removed' },
      data: { status: 'approved', contentRating: flooredRating },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be republished.'
      );
    }
    // ON-SITE: restore the backing block so the runtime serves again. Guarded to
    // `suspended` + non-fatal on a 0-count; a 0-count means the block wasn't suspended
    // (drift) → the listing shows approved but the block may not serve (store card →
    // a blank/broken block; Open 404s). Non-fatal (store visibility IS restored), but
    // flagged for a post-commit warn so the divergence is observable on the OWNER path
    // too (mirrors the mod `relistListing` drift warn).
    if (isOnsite && listing.appBlockId) {
      onsiteBlockId = listing.appBlockId;
      const flippedBlock = await flipBackingBlockStatus(tx, {
        isOnsite,
        appBlockId: listing.appBlockId,
        from: 'suspended',
        to: 'approved',
      });
      if (!flippedBlock) onsiteBlockRestoreDrift = true;
    }

    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: input.appListingId,
        slug: listing.slug,
        action: 'owner-republish',
        actorUserId: userId,
        reason,
        before: { status: 'removed' },
        after: { status: 'approved' },
      },
    });
  });

  // Post-commit, best-effort: warn when an on-site owner-republish restored the LISTING
  // but the backing block wasn't `suspended` (so it may not serve) — the same drift
  // observability the mod `relistListing` emits. Dynamic import keeps the logging graph
  // out of the tx path.
  if (onsiteBlockRestoreDrift) {
    void import('~/server/logging/client')
      .then(({ logToAxiom }) =>
        logToAxiom(
          {
            type: 'warning',
            name: 'app-listing-relist-block-drift',
            message:
              'onsite owner-republish: backing app_block was not suspended; the block may not serve',
            details: { appListingId: input.appListingId, appBlockId: onsiteBlockId },
          },
          'app-blocks'
        )
      )
      .catch(() => undefined);
  }

  // 🔴 The narrowing is on the LOCAL, not on a re-read: `reviewReason` is assigned inside
  // the transaction callback and TypeScript cannot see through the closure, so it is
  // widened back to the union here explicitly rather than trusted.
  const landedReviewReason: RepublishReviewReason | null = reviewReason;
  return landedReviewReason
    ? { appListingId: input.appListingId, status: 'pending', reviewReason: landedReviewReason }
    : { appListingId: input.appListingId, status: 'approved' };
}

/**
 * REVIEW ARM of {@link republishOwnListing}: instead of going live, put the listing into
 * `pending` and re-queue it on the surface that can actually SHOW the imagery under review.
 *
 * 🔴 BOTH KINDS RE-QUEUE ONTO `AppListingPublishRequest`. THE ON-SITE ARM USED TO CLONE THE
 * APPROVED `AppBlockPublishRequest` INSTEAD, AND THAT WAS THE BUG. What changed is the
 * listing's IMAGERY, and the block-request queue cannot express that: a clone carries the
 * same bundle key, the same sha256, the same manifest and the same version as the row the
 * moderator already approved, and the modal that renders it (`OnsiteReviewModal`) draws its
 * screenshots by re-extracting them from the bundle ZIP and never reads `AppListing.iconId`
 * / `coverId` / `AppListingScreenshot` at all. So the moderator was handed a byte-identical
 * re-submission of something they had already said yes to, with nothing on screen about the
 * pictures that caused the re-queue — a review that structurally could not review the thing
 * under review.
 *
 * The listing-request queue is where listing imagery is reviewed already: the mod modal
 * (`OffsiteReviewQueue`) keys `appListings.getAssets` and `getListingPreviewForReview` off
 * `request.appListingId`, so it renders this listing's real icon, cover and screenshots and
 * a store-layout preview. Both reads are kind-agnostic, and `listPendingOffsiteRequests`
 * already selects `kind: { in: ['onsite','offsite'] }` with no `revisionOfId` constraint.
 *
 * 🔴 THIS IS THE FIRST NON-SHADOW `kind: 'onsite'` LISTING REQUEST IN THE SYSTEM. Every
 * other onsite listing request is a media REVISION (`revisionOfId != null`) and returns
 * early from `approveExternalRequest` into `applyApprovedRevision`. A non-shadow one takes
 * the main approve path, which had no onsite behaviour because nothing could reach it —
 * see the two onsite branches added there (raise-only rating, and un-suspending the
 * backing block).
 *
 * WHAT EACH KIND GETS:
 *
 *   BOTH — flip `removed → pending` and mint a FRESH `pending` non-shadow
 *   `AppListingPublishRequest` owned by the listing owner. Off-site this is byte-identical
 *   to {@link resetListingToPending}'s writes.
 *
 *   ON-SITE additionally — the backing block is LEFT SUSPENDED (`unpublishOwnListing`
 *   suspended it and nothing here restores it): an app whose store card is awaiting review
 *   does not serve, which is the same posture {@link resetOnsiteListingToPending} takes.
 *   `approveExternalRequest` un-suspends it on approve. Withdraw/reject leave listing
 *   `removed` + block `suspended`, which is exactly the state the owner was in before they
 *   pressed Republish — the two halves never diverge.
 *
 * 🔴 THE ICON+COVER FLOOR IS PRE-CHECKED HERE, BEFORE ANYTHING IS WRITTEN, and it is not
 * decoration. `approveExternalRequest` asserts the floor and does NOT exempt on-site, while
 * the on-site FIRST-publish path (`approveRequest`) never asserts it — so an approved
 * on-site listing is genuinely allowed to have no icon or no cover. Routing such a listing
 * to review without this check strands it: it sits `pending`, its app is suspended, and the
 * moderator's approve fails on the floor every time, with no owner-reachable way out.
 * Failing HERE turns that into an ordinary, actionable "add an icon and a cover" error and
 * leaves the listing `removed` where the owner can still edit it.
 *
 * 🔴 `contentRating` IS WRITTEN ON THIS ARM TOO. It carries #4418's raise-only floor,
 * already derived by the caller; see the call site for why deferring it to the approve is
 * not equivalent.
 *
 * The audit event is an `owner-republish` whose `after.status` is `pending`, so the
 * history reads "the owner asked for this back, and it went to review" rather than
 * implying it went live. `detail` names WHY.
 *
 * A guarded 0-count on the flip throws, rolling back the whole tx — including the
 * re-queued request — so a raced listing can never leave a stray queue entry behind.
 */
async function routeRepublishToReviewInTx(
  tx: Prisma.TransactionClient,
  args: {
    appListingId: string;
    listing: {
      kind: string;
      slug: string;
      userId: number;
      iconId: number | null;
      coverId: number | null;
    };
    userId: number;
    reason: string | null;
    reviewReason: RepublishReviewReason;
    flooredRating: string | null;
  }
): Promise<void> {
  const { appListingId, listing, reviewReason, flooredRating } = args;

  // Publish-floor pre-check — see the 🔴 note above. `screenshotCount` is not part of the
  // floor (screenshots are optional), so a constant satisfies the parameter shape; the
  // floor reads only `iconId`/`coverId`.
  assertListingMeetsFloor({
    iconId: listing.iconId,
    coverId: listing.coverId,
    screenshotCount: 0,
  });

  // A pending listing request already pointing at THIS row would make the queue show two
  // reviews of one listing, and the approve path would supersede whichever it did not
  // action. Refuse with a friendly error rather than create the second one. (Scoped to
  // `appListingId`, NOT slug: a shadow revision denormalizes the parent slug but targets a
  // different row and is a legitimate concurrent review.)
  const openRequest = await tx.appListingPublishRequest.findFirst({
    where: { appListingId, status: 'pending' },
    select: { id: true },
  });
  if (openRequest) {
    throw new OffsiteModerationError(
      'NOT_TRANSITIONABLE',
      'A review is already pending for this listing.'
    );
  }

  const flipped = await tx.appListing.updateMany({
    where: { id: appListingId, kind: listing.kind, status: 'removed' },
    data: { status: 'pending', contentRating: flooredRating },
  });
  if (flipped.count === 0) {
    throw new OffsiteModerationError(
      'NOT_TRANSITIONABLE',
      'This listing can no longer be republished.'
    );
  }

  await tx.appListingPublishRequest.create({
    data: {
      id: newAppListingPublishRequestId(),
      appListingId,
      kind: listing.kind,
      slug: listing.slug,
      // The LISTING OWNER, so my-submissions and the mod queue attribute it to them.
      submittedByUserId: listing.userId,
      status: 'pending',
    },
  });

  await tx.appListingModerationEvent.create({
    data: {
      id: newAppListingModerationEventId(),
      appListingId,
      slug: listing.slug,
      action: 'owner-republish',
      actorUserId: args.userId,
      reason: args.reason,
      detail: REPUBLISH_REVIEW_DETAIL[reviewReason],
      before: { status: 'removed' },
      after: { status: 'pending' },
    },
  });
}

/**
 * OWNER per-listing moderation history (audit trail) for a listing the CALLER OWNS
 * — the owner's "why was this hidden / un-approved" view. Asserts ownership
 * (NOT_FOUND on a missing listing, NOT_OWNED → FORBIDDEN otherwise) then returns the
 * newest-first, keyset-paginated history through the OWNER-scoped
 * `ownerModerationEventSelect` — 🔴 which DROPS the acting-mod chip (`actor`),
 * `reportId`, `detail`, and `before`/`after` so a taken-down app's owner can't learn
 * which moderator acted (harassment vector) nor read internal report/detail fields.
 * The mod-facing `listModerationEvents` keeps the full projection. Offsite-only is
 * NOT enforced here (an owner can only pass their own listing id regardless of kind).
 */
export async function listMyListingModerationEvents(opts: {
  input: ListMyListingModerationEventsInput;
  userId: number;
}) {
  const { input, userId } = opts;
  const listing = await dbRead.appListing.findUnique({
    where: { id: input.appListingId },
    select: { userId: true },
  });
  if (!listing) {
    throw new OffsiteModerationError('NOT_FOUND', 'Listing not found.');
  }
  if (listing.userId !== userId) {
    throw new OffsiteModerationError('NOT_OWNED', 'You can only view your own listings.');
  }
  // 🔴 Owner read → the privacy-minimal projection (no acting-mod identity / reportId /
  // detail / before-after). The mod read (`listModerationEvents`) keeps the full one.
  return queryModerationEvents({ ...input, ownerScoped: true });
}
