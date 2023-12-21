import { MetricTimeframe } from '@prisma/client';

const timeframeOrder: MetricTimeframe[] = ['Day', 'Week', 'Month', 'Year', 'AllTime'];
export function getPeriods(period: MetricTimeframe) {
  const periodIndex = timeframeOrder.indexOf(period);
  if (periodIndex === -1) throw new Error('Invalid period specified');

  return timeframeOrder.slice(0, periodIndex + 1);
}
