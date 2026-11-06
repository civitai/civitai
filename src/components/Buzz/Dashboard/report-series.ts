import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { formatDate } from '~/utils/date-helpers';

type ReportRow = {
  date: Date | string;
  accounts: { accountType: string; gained?: number | null; spent?: number | null }[];
};

/**
 * Maps each bucket's chart label to the account's gained/spent for that bucket.
 * `onlyLabels` drops buckets the chart has no tick for, so they can't append stray ticks.
 */
export function getReportSeries(
  report: ReportRow[],
  accountType: BuzzSpendType,
  field: 'gained' | 'spent',
  labelFormat: string,
  onlyLabels?: string[]
): Record<string, number> {
  const series: Record<string, number> = {};
  for (const row of report) {
    const label = formatDate(row.date, labelFormat);
    if (onlyLabels && !onlyLabels.includes(label)) continue;
    series[label] = row.accounts.find((a) => a.accountType === accountType)?.[field] ?? 0;
  }
  return series;
}

/** Only Yellow and Green can be compared with each other. */
export function getStackPartner(accountType: BuzzSpendType): BuzzSpendType | undefined {
  if (accountType === 'yellow') return 'green';
  if (accountType === 'green') return 'yellow';
  return undefined;
}
