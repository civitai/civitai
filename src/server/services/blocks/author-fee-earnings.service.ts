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
};

export const AUTHOR_FEE_RECENT_LIMIT = 20;

const emptyBucket = (): AuthorFeeBucket => ({ count: 0, feeBuzz: 0, byBuzzType: {} });

export function emptyAuthorFeeEarnings(): AuthorFeeEarnings {
  return { accrued: emptyBucket(), settled: emptyBucket(), byApp: [], recent: [] };
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
 * transfer, and a caller naming an app they do not own gets zeros. Both reads lead with the owner
 * column of `block_author_fee_accrual_owner_idx`.
 */
export async function getAuthorFeeEarningsForOwner({
  ownerUserId,
  appBlockId,
  from,
  to,
  recentLimit = AUTHOR_FEE_RECENT_LIMIT,
}: {
  ownerUserId: number;
  appBlockId?: string;
  from?: Date;
  to?: Date;
  recentLimit?: number;
}): Promise<AuthorFeeEarnings> {
  const where = {
    appOwnerUserId: ownerUserId,
    ...(appBlockId ? { appBlockId } : {}),
    ...(from || to
      ? { accruedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };

  const [groups, recent] = await Promise.all([
    dbRead.blockAuthorFeeAccrual.groupBy({
      by: ['appBlockId', 'status', 'buzzType'],
      where,
      _sum: { feeBuzz: true },
      _count: true,
    }),
    dbRead.blockAuthorFeeAccrual.findMany({
      where,
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
  for (const group of groups) {
    const bucketKey =
      group.status === STATUS_SETTLED
        ? 'settled'
        : group.status === STATUS_ACCRUED
        ? 'accrued'
        : null;
    // The status CHECK allows only these two; an unknown value is not money owed or paid.
    if (!bucketKey) continue;
    const feeBuzz = group._sum.feeBuzz ?? 0;
    let app = apps.get(group.appBlockId);
    if (!app) {
      app = { appBlockId: group.appBlockId, accrued: emptyBucket(), settled: emptyBucket() };
      apps.set(group.appBlockId, app);
    }
    addTo(result[bucketKey], group.buzzType, group._count, feeBuzz);
    addTo(app[bucketKey], group.buzzType, group._count, feeBuzz);
  }

  result.byApp = [...apps.values()].sort(
    (a, b) =>
      b.accrued.feeBuzz + b.settled.feeBuzz - (a.accrued.feeBuzz + a.settled.feeBuzz) ||
      a.appBlockId.localeCompare(b.appBlockId)
  );
  result.recent = recent;
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
}: {
  appBlockId: string;
  currentOwnerUserId: number;
  from?: Date;
  to?: Date;
}): Promise<AuthorFeeEarnings> {
  return getAuthorFeeEarningsForOwner({ ownerUserId: currentOwnerUserId, appBlockId, from, to });
}
