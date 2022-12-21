import { MetricTimeframe } from '@prisma/client';
import { ModelSort } from '~/server/common/enums';

export const constants = {
  modelFilterDefaults: {
    sort: ModelSort.MostDownloaded,
    period: MetricTimeframe.Day,
  },
  baseModels: ['SD 1.4', 'SD 1.5', 'SD 2.0', 'SD 2.1', 'SD 2.0 768', 'Other'],
} as const;
