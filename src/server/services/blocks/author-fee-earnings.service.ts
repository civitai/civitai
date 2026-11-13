import type { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { STATUS_ACCRUED, STATUS_SETTLED } from './author-fee-accrual.service';

export type AuthorFeeBucket = {
  count: number;
  feeBuzz: number;
  /** Whole Buzz per buzz type; the author is paid in the type the viewer paid with. */
  byBuzzType: Record<string, number>;
};

export type AuthorFeeAppEarnings = {
  appBlockId: string;
  accrued: AuthorFeeBucket;
  settled: AuthorFeeBucket;
};

export type AuthorFeeRecentRow = {
  id: string;
  appBlockId: string;
  feeBuzz: number;
  buzzType: string;
  status: string;
  accruedAt: Date;
  settledAt: Date | null;
};

export type AuthorFeeEarnings = {
  /** Charged to viewers, not yet paid to the author. */
  accrued: AuthorFeeBucket;
  /** Paid to the author's Buzz account by the daily settlement. */
  settled: AuthorFeeBucket;
  /** Highest total first. */
  byApp: AuthorFeeAppEarnings[];
  /** Newest first. */
  recent: AuthorFeeRecentRow[];
  /**
   * Set when no range was asked for: `settled`, the per-app paid figures and `recent` then cover
   * only the last this-many days. `accrued` is never windowed. `null` for an explicit range.
   */
  paidWindowDays: number | null;
};

export const AUTHOR_FEE_RECENT_LIMIT = 20;

/**
 * The default window for paid fees when the caller gives no range, so a revenue load does not group
 * an owner's whole fee history. One constant for both entry points.
 */
export const AUTHOR_FEE_DEFAULT_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const emptyBucket = (): AuthorFeeBucket => ({ count: 0, feeBuzz: 0, byBuzzType: {} });

export function emptyAuthorFeeEarnings(): AuthorFeeEarnings {
  return {
    accrued: emptyBucket(),
    settled: emptyBucket(),
    byApp: [],
    recent: [],
    paidWindowDays: null,
  };
}

function addTo(bucket: AuthorFeeBucket, buzzType: string, count: number, feeBuzz: number) {
  bucket.count += count;
  bucket.feeBuzz += feeBuzz;
  bucket.byBuzzType[buzzType] = (bucket.byBuzzType[buzzType] ?? 0) + feeBuzz;
}

/**
 * The caller's author-fee earnings from `block_author_fee_accrual`.
 *
 * Scoped by the snapshotted `app_owner_user_id`, so an ex-owner still sees what they earned before a
 * transfer, and a caller naming an app they do not own gets zeros.
 *
 * With no `from`/`to`, settled fees and the recent list cover the last
 * {@link AUTHOR_FEE_DEFAULT_WINDOW_DAYS} days (an `accrued_at` range on
 * `block_author_fee_accrual_owner_idx`), but PENDING fees are read without a window. A fee normally
 * settles in the daily batch after its UTC day ends, yet `settleBlockAuthorFees` can leave rows
 * `accrued` indefinitely: while the author-fee flag is off, for a day skipped as oversized, or for
 * an owner whose mint the Buzz service keeps rejecting. A window on pending would hide money still
 * owed. The pending read filters `status = 'accrued'`, which `block_author_fee_accrual_settlement_idx`
 * leads with; that set is normally about a day of rows.
 */
export async function getAuthorFeeEarningsForOwner({
  ownerUserId,
  appBlockId,
  from,
  to,
  recentLimit = AUTHOR_FEE_RECENT_LIMIT,
  now = new Date(),
}: {
  ownerUserId: number;
  appBlockId?: string;
  from?: Date;
  to?: Date;
  recentLimit?: number;
  /** Injectable clock for the default window. */
  now?: Date;
}): Promise<AuthorFeeEarnings> {
  const scope = { appOwnerUserId: ownerUserId, ...(appBlockId ? { appBlockId } : {}) };
  const explicit = !!(from || to);
  const asked = explicit
    ? { accruedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
    : {};
  const windowed = explicit
    ? asked
    : { accruedAt: { gte: new Date(now.getTime() - AUTHOR_FEE_DEFAULT_WINDOW_DAYS * DAY_MS) } };
  const group = (where: Prisma.BlockAuthorFeeAccrualWhereInput) =>
    dbRead.blockAuthorFeeAccrual.groupBy({
      by: ['appBlockId', 'status', 'buzzType'],
      where,
      _sum: { feeBuzz: true },
      _count: true,
    });

  const [pendingGroups, settledGroups, recent] = await Promise.all([
    group({ ...scope, ...asked, status: STATUS_ACCRUED }),
    group({ ...scope, ...windowed, status: STATUS_SETTLED }),
    dbRead.blockAuthorFeeAccrual.findMany({
      where: { ...scope, ...windowed },
      orderBy: { accruedAt: 'desc' },
      take: recentLimit,
      select: {
        id: true,
        appBlockId: true,
        feeBuzz: true,
        buzzType: true,
        status: true,
        accruedAt: true,
        settledAt: true,
      },
    }),
  ]);

  const result = emptyAuthorFeeEarnings();
  const apps = new Map<string, AuthorFeeAppEarnings>();
  for (const row of [...pendingGroups, ...settledGroups]) {
    const bucketKey =
      row.status === STATUS_SETTLED ? 'settled' : row.status === STATUS_ACCRUED ? 'accrued' : null;
    // The status CHECK allows only these two; an unknown value is not money owed or paid.
    if (!bucketKey) continue;
    const feeBuzz = row._sum.feeBuzz ?? 0;
    let app = apps.get(row.appBlockId);
    if (!app) {
      app = { appBlockId: row.appBlockId, accrued: emptyBucket(), settled: emptyBucket() };
      apps.set(row.appBlockId, app);
    }
    addTo(result[bucketKey], row.buzzType, row._count, feeBuzz);
    addTo(app[bucketKey], row.buzzType, row._count, feeBuzz);
  }

  result.byApp = [...apps.values()].sort(
    (a, b) =>
      b.accrued.feeBuzz + b.settled.feeBuzz - (a.accrued.feeBuzz + a.settled.feeBuzz) ||
      a.appBlockId.localeCompare(b.appBlockId)
  );
  result.recent = recent;
  result.paidWindowDays = explicit ? null : AUTHOR_FEE_DEFAULT_WINDOW_DAYS;
  return result;
}

/**
 * One app's author-fee earnings, for the collaborator surface (`appCollaborators.getAppEarnings`).
 *
 * Scoped to the app AND to its CURRENT owner, never to the caller, so the owner and every accepted
 * editor see the same whole-app figure, and a transferred app shows only what accrued to the owner
 * now holding it (the previous owner keeps theirs on their own revenue page).
 */
export function getAuthorFeeEarningsForApp({
  appBlockId,
  currentOwnerUserId,
  from,
  to,
  now,
}: {
  appBlockId: string;
  currentOwnerUserId: number;
  from?: Date;
  to?: Date;
  now?: Date;
}): Promise<AuthorFeeEarnings> {
  return getAuthorFeeEarningsForOwner({
    ownerUserId: currentOwnerUserId,
    appBlockId,
    from,
    to,
    now,
  });
}
