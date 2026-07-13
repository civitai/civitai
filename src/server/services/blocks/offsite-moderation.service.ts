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
import { notifyAppListingOwner } from '~/server/services/blocks/app-listing-notify';
import {
  newAppListingModerationEventId,
  newAppListingPublishRequestId,
  newAppListingReportId,
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
    throw new OffsiteModerationError('NOT_FOUND', 'Off-site listing not found.');
  }
  return { id: listing.id, status: listing.status, slug: listing.slug };
}

/**
 * Load + classify a listing for the DUAL-KIND delist/relist actions (which apply to
 * BOTH kinds, unlike claim/purge which stay offsite-only via `classifyOffsiteListing`).
 * Returns the fields those actions need: kind (to branch the on-site dual-table flip),
 * status/slug, the backing `appBlockId` (on-site: flip the block's status too), and
 * the owner `userId` (the off-site hide notification target). A missing listing →
 * generic NOT_FOUND (no kind guard here — both kinds are valid targets).
 */
async function classifyListingForAction(appListingId: string): Promise<{
  id: string;
  kind: string;
  status: string;
  slug: string;
  appBlockId: string | null;
  userId: number;
}> {
  const listing = await dbRead.appListing.findUnique({
    where: { id: appListingId },
    select: { id: true, kind: true, status: true, slug: true, appBlockId: true, userId: true },
  });
  if (!listing) {
    throw new OffsiteModerationError('NOT_FOUND', 'Listing not found.');
  }
  return {
    id: listing.id,
    kind: listing.kind,
    status: listing.status,
    slug: listing.slug,
    appBlockId: listing.appBlockId,
    userId: listing.userId,
  };
}

export type DelistListingResult = { appListingId: string; status: 'removed' };

/**
 * MOD delist an APPROVED listing (approved → removed) — now DUAL-KIND (W13
 * post-approval mgmt). The store read path is approved-only, so a `removed` listing
 * drops out of `listAvailableListings` + `getListingDetail` automatically.
 *
 *   - OFF-SITE: flip only `app_listings.status` approved → removed, then notify the
 *     owner their app was hidden (post-commit, carrying the mod reason).
 *   - ON-SITE: flip BOTH `app_listings.status` (approved → removed) AND the backing
 *     `app_blocks.status` (approved → suspended) in the SAME tx — a hosted block's
 *     runtime serving gate reads `app_blocks.status`, so hiding it from the store
 *     WITHOUT suspending the block would leave `<slug>.civit.ai` still serving. No
 *     owner notification on the on-site path (out of Phase-1 scope). The listing
 *     flip is the authoritative guard; the block flip is status-guarded to avoid
 *     clobbering a drifted state but is non-fatal on a 0-count (the store status is
 *     the source of truth for visibility).
 *
 * Status-guarded: the listing mutate is `updateMany({ id, kind, status:'approved' })`;
 * a 0-count means a concurrent action already moved the row → NOT_TRANSITIONABLE and
 * the tx rolls back BEFORE the audit event is written (ZERO events on a guarded
 * failure). Optionally resolves the triggering `reportId` in the same tx.
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
    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: listing.kind, status: 'approved' },
      data: { status: 'removed' },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be delisted.'
      );
    }
    // ON-SITE: also suspend the backing AppBlock so the block runtime stops serving.
    // Guarded to `approved` (don't clobber a drifted state); non-fatal on 0-count.
    if (isOnsite && listing.appBlockId) {
      await tx.appBlock.updateMany({
        where: { id: listing.appBlockId, status: 'approved' },
        data: { status: 'suspended' },
      });
    }
    await tx.appListingModerationEvent.create({
      data: {
        id: eventId,
        appListingId: input.appListingId,
        slug: listing.slug,
        action: 'delist',
        actorUserId: reviewerUserId,
        reason,
        reportId: input.reportId ?? null,
        before: { status: 'approved' },
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

  // OFF-SITE only: post-commit, best-effort — notify the owner their app was hidden,
  // carrying the mod reason. (On-site owners aren't notified in Phase 1.)
  if (!isOnsite) {
    await notifyAppListingOwner({
      type: 'app-listing-hidden',
      userId: listing.userId,
      // Keyed by the audit event id so each distinct hide (delist→relist→delist)
      // notifies once, without a fresh nonce.
      key: `app-listing-hidden:${eventId}`,
      details: { slug: listing.slug, listingId: input.appListingId, reason },
    });
  }

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

  await dbWrite.$transaction(async (tx) => {
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
    if (isOnsite && listing.appBlockId) {
      await tx.appBlock.updateMany({
        where: { id: listing.appBlockId, status: 'suspended' },
        data: { status: 'approved' },
      });
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
  // Fail-fast + info-leak parity (replica): a missing OR on-site listing throws the
  // same generic NOT_FOUND before any tx is opened. The authoritative snapshot is
  // re-read on the primary inside the tx below.
  await classifyOffsiteListing(input.appListingId);

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
      throw new OffsiteModerationError('NOT_FOUND', 'Off-site listing not found.');
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
 * MOD hard-delete (purge) an off-site listing — the genuine final expunge that
 * also makes the delist round-trip self-cleaning.
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
  // Fail-fast + info-leak parity (replica): a missing OR on-site listing throws the
  // same generic NOT_FOUND before any tx is opened. The authoritative snapshot is
  // re-read on the primary inside the tx below.
  await classifyOffsiteListing(input.appListingId);

  await dbWrite.$transaction(async (tx) => {
    // Authoritative pre-delete snapshot from the PRIMARY (not the replica classify),
    // so `before.status` + `slug` reflect the true current row and the kind guard is
    // re-checked on the primary. A row that vanished (or turned non-offsite) between
    // classify and here → generic NOT_FOUND, tx rolls back with no event written.
    const current = await tx.appListing.findUnique({
      where: { id: input.appListingId },
      select: { status: true, slug: true, kind: true },
    });
    if (!current || current.kind !== 'offsite') {
      throw new OffsiteModerationError('NOT_FOUND', 'Off-site listing not found.');
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
    // screenshots + reports). The inline `kind: 'offsite'` guard mirrors delist/relist
    // for defense-in-depth on a DESTRUCTIVE op — a 0-count delete (raced, or a
    // non-offsite row slipping past classify) throws → the tx (incl. the event) rolls
    // back.
    const deleted = await tx.appListing.deleteMany({
      where: { id: input.appListingId, kind: 'offsite' },
    });
    if (deleted.count === 0) {
      // Raced (concurrently purged between the snapshot and here) → roll the event back.
      throw new OffsiteModerationError('NOT_FOUND', 'Off-site listing not found.');
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
 * chip ({id,username,image}) + the denormalized slug. No raw actorUserId FK.
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
 * MOD per-listing moderation history, NEWEST-first, keyset-paginated. The cursor is
 * the event id (`alme_<ULID>`, time-sortable so it tracks the `createdAt desc`
 * order); the `id` tie-break makes same-millisecond ordering deterministic.
 */
async function queryModerationEvents(opts: {
  appListingId: string;
  cursor?: string;
  limit?: number;
}) {
  const limit = Math.min(opts.limit ?? 25, 50);
  const rows = await dbRead.appListingModerationEvent.findMany({
    where: { appListingId: opts.appListingId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: moderationEventSelect,
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
      throw new OffsiteModerationError('NOT_FOUND', 'Off-site listing not found.');
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

/**
 * Load an OFF-SITE listing the caller OWNS for an owner action, on the PRIMARY
 * inside a tx. A missing OR on-site listing → generic NOT_FOUND (offsite-only owner
 * self-service, parity with claim/purge); a listing owned by someone else →
 * NOT_OWNED (router → FORBIDDEN).
 */
async function loadOwnedOffsiteInTx(
  tx: Prisma.TransactionClient,
  appListingId: string,
  callerUserId: number
): Promise<{ userId: number; status: string; slug: string; name: string | null }> {
  const listing = await tx.appListing.findUnique({
    where: { id: appListingId },
    select: { userId: true, status: true, kind: true, slug: true, name: true },
  });
  if (!listing || listing.kind !== 'offsite') {
    throw new OffsiteModerationError('NOT_FOUND', 'Off-site listing not found.');
  }
  if (listing.userId !== callerUserId) {
    throw new OffsiteModerationError('NOT_OWNED', 'You can only manage your own listings.');
  }
  return { userId: listing.userId, status: listing.status, slug: listing.slug, name: listing.name };
}

export type UnpublishOwnListingResult = { appListingId: string; status: 'removed' };

/**
 * OWNER self-hide their OWN approved off-site listing (approved → removed). A pure
 * visibility toggle — NO content-rating re-derive, NO asset change, NO publish
 * request. In ONE tx (primary): owner-load + guard offsite/owner/status, guard-flip
 * approved → removed (0-count → NOT_TRANSITIONABLE), write an `owner-unpublish`
 * event. No notification (the owner performed the action). `reason` optional.
 */
export async function unpublishOwnListing(opts: {
  input: UnpublishOwnListingInput;
  userId: number;
}): Promise<UnpublishOwnListingResult> {
  const { input, userId } = opts;
  const reason = input.reason?.trim() ? input.reason.trim() : null;

  await dbWrite.$transaction(async (tx) => {
    const listing = await loadOwnedOffsiteInTx(tx, input.appListingId, userId);
    if (listing.status !== 'approved') {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'Only an approved listing can be unpublished.'
      );
    }
    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: 'offsite', status: 'approved' },
      data: { status: 'removed' },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be unpublished.'
      );
    }
    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: input.appListingId,
        slug: listing.slug,
        action: 'owner-unpublish',
        actorUserId: userId,
        reason,
        before: { status: 'approved' },
        after: { status: 'removed' },
      },
    });
  });

  return { appListingId: input.appListingId, status: 'removed' };
}

export type RepublishOwnListingResult = { appListingId: string; status: 'approved' };

/**
 * OWNER restore their OWN owner-unpublished off-site listing (removed → approved).
 *
 * 🔴 SAFETY GUARD (load-bearing): republish is allowed ONLY when the MOST-RECENT
 * `AppListingModerationEvent` for the listing is an `owner-unpublish`. If the last
 * event is a moderator `delist`/`purge` (a takedown-for-cause), republish is
 * FORBIDDEN — an owner must NOT be able to self-restore a listing a moderator
 * removed. No events at all → also FORBIDDEN (can't prove owner-initiated removal).
 * The latest-event read + the flip are in ONE tx on the PRIMARY so a concurrent mod
 * takedown can't slip between the check and the restore. Pure visibility toggle — no
 * re-derive, no publish request. `reason` optional.
 */
export async function republishOwnListing(opts: {
  input: RepublishOwnListingInput;
  userId: number;
}): Promise<RepublishOwnListingResult> {
  const { input, userId } = opts;
  const reason = input.reason?.trim() ? input.reason.trim() : null;

  await dbWrite.$transaction(async (tx) => {
    const listing = await loadOwnedOffsiteInTx(tx, input.appListingId, userId);
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
    const lastEvent = await tx.appListingModerationEvent.findFirst({
      where: { appListingId: input.appListingId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true },
    });
    if (!lastEvent || lastEvent.action !== 'owner-unpublish') {
      throw new OffsiteModerationError(
        'FORBIDDEN',
        'This listing was removed by a moderator and cannot be restored by its owner.'
      );
    }
    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: 'offsite', status: 'removed' },
      data: { status: 'approved' },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be republished.'
      );
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

  return { appListingId: input.appListingId, status: 'approved' };
}

/**
 * OWNER per-listing moderation history (audit trail) for a listing the CALLER OWNS
 * — the owner's "why was this hidden / un-approved" view. Asserts ownership
 * (NOT_FOUND on a missing listing, NOT_OWNED → FORBIDDEN otherwise) then returns the
 * SAME newest-first, keyset-paginated, PII-safe projection as the mod
 * `listModerationEvents`. Offsite-only is NOT enforced here (an owner can only pass
 * their own listing id regardless of kind; the projection is already PII-safe).
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
  return queryModerationEvents(input);
}
