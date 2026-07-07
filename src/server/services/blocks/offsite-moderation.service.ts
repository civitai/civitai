import { TRPCError } from '@trpc/server';

import { dbRead, dbWrite } from '~/server/db/client';
import {
  APP_LISTING_REPORT_REASONS,
  OFFSITE_MOD_REASON_MIN,
  type DelistListingInput,
  type DismissReportInput,
  type ListListingReportsInput,
  type ListModerationEventsInput,
  type PurgeListingInput,
  type RelistListingInput,
  type ReportListingInput,
  type ResolveReportInput,
} from '~/server/schema/blocks/offsite-moderation.schema';
import {
  newAppListingModerationEventId,
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
  // PR3 mod-action failure modes:
  //   NOT_TRANSITIONABLE — a status-guarded delist/relist matched 0 rows (the
  //     listing was already moved by a concurrent action) → BAD_REQUEST.
  //   REPORT_NOT_PENDING — resolve/dismiss on an already-closed report → BAD_REQUEST.
  // A kind mismatch (an on-site listing) reuses NOT_FOUND (generic — a mod caller
  // must not be able to probe a listing's kind through this surface).
  | 'NOT_TRANSITIONABLE'
  | 'REPORT_NOT_PENDING';

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
// PR3 — mod ACTIONS (delist / relist / purge / resolve / dismiss). Each writes
// EXACTLY ONE `AppListingModerationEvent` in the SAME transaction as its mutation
// (a crash can't split the mutation from its audit record). All mod-only at the
// router (`moderatorProcedure` + `isModerator` recheck). `claim` is PR4.
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

export type DelistListingResult = { appListingId: string; status: 'removed' };

/**
 * MOD delist an APPROVED off-site listing (approved → removed). The read path is
 * approved-only, so a `removed` listing drops out of `listAvailableListings` +
 * `getListingDetail` automatically (no read-path change). Status-guarded: the
 * mutate is `updateMany({ id, kind:'offsite', status:'approved' })`; a 0-count
 * means a concurrent action already moved the row → NOT_TRANSITIONABLE and the tx
 * rolls back BEFORE the audit event is written (so a guarded failure emits ZERO
 * events). Optionally resolves the triggering `reportId` in the same tx.
 */
export async function delistListing(opts: {
  input: DelistListingInput;
  reviewerUserId: number;
}): Promise<DelistListingResult> {
  const { input, reviewerUserId } = opts;
  const reason = requireModReason(input.reason);
  const listing = await classifyOffsiteListing(input.appListingId);

  await dbWrite.$transaction(async (tx) => {
    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: 'offsite', status: 'approved' },
      data: { status: 'removed' },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be delisted.'
      );
    }
    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
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

  return { appListingId: input.appListingId, status: 'removed' };
}

export type RelistListingResult = { appListingId: string; status: 'approved' };

/**
 * MOD relist a REMOVED off-site listing (removed → approved) — reversibility for a
 * mistaken/appealed takedown; restores store visibility instantly. Status-guarded
 * (`status:'removed'`) + one audit event, same TOCTOU discipline as delist.
 */
export async function relistListing(opts: {
  input: RelistListingInput;
  reviewerUserId: number;
}): Promise<RelistListingResult> {
  const { input, reviewerUserId } = opts;
  const reason = requireModReason(input.reason);
  const listing = await classifyOffsiteListing(input.appListingId);

  await dbWrite.$transaction(async (tx) => {
    const flipped = await tx.appListing.updateMany({
      where: { id: input.appListingId, kind: 'offsite', status: 'removed' },
      data: { status: 'approved' },
    });
    if (flipped.count === 0) {
      throw new OffsiteModerationError(
        'NOT_TRANSITIONABLE',
        'This listing can no longer be relisted.'
      );
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
export async function listModerationEvents(opts: ListModerationEventsInput) {
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
