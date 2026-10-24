import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';

export function legendStatusLabel(
  status: {
    founding: boolean;
    since: Date | null;
    oneOf?: number | null;
  },
  tierName = 'Legend'
) {
  const label =
    status.founding || !status.since
      ? `Founding ${tierName}`
      : // UTC, so a crossing just after midnight UTC on the 1st is not shown as the previous month.
        `${tierName} since ${formatDate(status.since, 'MMMM YYYY', true)}`;
  return status.oneOf ? `${label} · one of ${numberWithCommas(status.oneOf)}` : label;
}

/** The showcase lists the UTC month's Supernovas, so the heading names the UTC month too. */
export function showcaseMonthLabel(now: Date) {
  return formatDate(now, 'MMMM', true);
}
