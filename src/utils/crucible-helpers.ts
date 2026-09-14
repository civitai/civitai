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
export function getStatusDotColor(
  status: CrucibleStatus,
  endAt: Date | null,
  now?: Date
): string {
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
export function getStatusText(
  status: CrucibleStatus,
  endAt: Date | null,
  now?: Date
): string {
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
