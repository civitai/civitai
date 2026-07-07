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
  constructor(code: OffsiteModerationErrorCode, message: string) {
    super(message);
    this.name = 'OffsiteModerationError';
    this.code = code;
  }
}

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
 * missing listing → NOT_FOUND; a draft / pending / rejected / removed listing →
 * NOT_REPORTABLE (a non-approved listing is not in the store — nothing to report).
 * `reason` is re-validated against the shared tuple (defense-in-depth: this fn is
 * exported + unit-tested directly, not only reached through the zod schema).
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
  const listing = await dbRead.appListing.findUnique({
    where: { id: input.appListingId },
    select: { id: true, status: true },
  });
  if (!listing) {
    throw new OffsiteModerationError('NOT_FOUND', `listing ${input.appListingId} not found`);
  }
  if (listing.status !== 'approved') {
    throw new OffsiteModerationError(
      'NOT_REPORTABLE',
      `only an approved listing can be reported (status ${listing.status})`
    );
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
    orderBy: { createdAt: 'asc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: reportQueueSelect,
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasNext ? items[items.length - 1].id : null };
}
