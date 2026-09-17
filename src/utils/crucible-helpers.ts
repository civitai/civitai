import { CrucibleStatus } from '~/shared/utils/prisma/enums';

/**
 * Check if a crucible is ending soon (within 3 days)
 * @param endAt - The crucible end date
 * @param now - Optional current date for testing/memoization (defaults to new Date())
 */
export function isEndingSoon(endAt: Date, now: Date = new Date()): boolean {
  const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  return new Date(endAt) <= threeDaysFromNow;
}

/**
 * Get the status dot color class based on crucible status
 * @param status - The crucible status
 * @param endAt - The crucible end date (optional)
 * @param now - Optional current date for testing/memoization (defaults to new Date())
 */
export function getStatusDotColor(status: CrucibleStatus, endAt: Date | null, now?: Date): string {
  if (status === CrucibleStatus.Active && endAt && isEndingSoon(endAt, now)) {
    return 'bg-yellow-5';
  }
  switch (status) {
    case CrucibleStatus.Active:
      return 'bg-green-5';
    case CrucibleStatus.Pending:
      return 'bg-blue-5';
    case CrucibleStatus.Completed:
      return 'bg-gray-5';
    case CrucibleStatus.Cancelled:
      return 'bg-red-5';
    default:
      return 'bg-gray-5';
  }
}

/**
 * Get status text for display
 * @param status - The crucible status
 * @param endAt - The crucible end date (optional)
 * @param now - Optional current date for testing/memoization (defaults to new Date())
 */
export function getStatusText(status: CrucibleStatus, endAt: Date | null, now?: Date): string {
  switch (status) {
    case CrucibleStatus.Active:
      if (endAt && isEndingSoon(endAt, now)) {
        return 'Ending Soon';
      }
      return 'Active - Accepting entries';
    case CrucibleStatus.Pending:
      return 'Upcoming';
    case CrucibleStatus.Completed:
      return 'Completed';
    case CrucibleStatus.Cancelled:
      return 'Cancelled';
    default:
      return '';
  }
}

/**
 * The single derivation of a crucible's prize pool: the creator's seed plus every entry fee
 * collected. Server and client both read it from here — `getFeaturedCrucible` restates it in raw
 * SQL because it sorts on the value, and that copy has to move with this one.
 *
 * Every field is required so a select that forgets `seededPrizePool` fails typecheck instead of
 * quietly under-reporting the pool.
 */
export function getCrucibleTotalPrizePool({
  entryFee,
  entryCount,
  seededPrizePool,
}: {
  entryFee: number;
  entryCount: number;
  seededPrizePool: number;
}): number {
  return seededPrizePool + entryFee * entryCount;
}

export type PrizePosition = {
  position: number;
  percentage: number;
};

/**
 * `createCrucible` stores the `z.record(position, percentage)` its schema validates, so the value
 * is an object (`{"1": 50, "2": 30}`), not an array — an array-only read returns `[]` for every
 * crucible, which zeroes payouts and hides the prize split. Both shapes are accepted because
 * nothing type-checks across the JSON boundary.
 */
export function parsePrizePositions(prizePositionsJson: unknown): PrizePosition[] {
  if (!prizePositionsJson || typeof prizePositionsJson !== 'object') return [];

  if (Array.isArray(prizePositionsJson)) {
    return prizePositionsJson
      .filter(
        (item): item is PrizePosition =>
          typeof item === 'object' &&
          item !== null &&
          typeof item.position === 'number' &&
          typeof item.percentage === 'number'
      )
      .map(({ position, percentage }) => ({ position, percentage }))
      .filter(isUsablePrizePosition);
  }

  return Object.entries(prizePositionsJson)
    .map(([position, percentage]) => ({
      position: Number(position),
      percentage: Number(percentage),
    }))
    .filter(isUsablePrizePosition);
}

function isUsablePrizePosition({ position, percentage }: PrizePosition): boolean {
  return Number.isInteger(position) && position > 0 && Number.isFinite(percentage) && percentage > 0;
}
