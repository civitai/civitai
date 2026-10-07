import { formatDate } from '~/utils/date-helpers';

export function legendStatusLabel(status: { founding: boolean; since: Date | null }) {
  if (status.founding || !status.since) return 'Founding Legend';
  // UTC, so a crossing just after midnight UTC on the 1st is not shown as the previous month.
  return `Legend since ${formatDate(status.since, 'MMMM YYYY', true)}`;
}
