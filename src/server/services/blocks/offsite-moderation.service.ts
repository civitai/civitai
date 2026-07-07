import { dbRead, dbWrite } from '~/server/db/client';
import {
  APP_LISTING_REPORT_REASONS,
  type ListListingReportsInput,
  type ReportListingInput,
} from '~/server/schema/blocks/offsite-moderation.schema';
import { newAppListingReportId } from '~/server/utils/app-block-ids';

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
  | 'ALREADY_REPORTED';

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
  appListing: { select: { slug: true, name: true, kind: true } },
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
