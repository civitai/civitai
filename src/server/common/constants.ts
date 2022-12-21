import { MetricTimeframe } from '@prisma/client';
import { ModelSort } from '~/server/common/enums';

export const constants = {
  modelFilterDefaults: {
    sort: ModelSort.MostDownloaded,
    period: MetricTimeframe.Day,
  },
} as const;
