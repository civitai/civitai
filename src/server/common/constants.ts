import { QuestionSort } from './enums';
import { MetricTimeframe } from '@prisma/client';
import { ModelSort } from '~/server/common/enums';

export const constants = {
  modelFilterDefaults: {
    sort: ModelSort.HighestRated,
    period: MetricTimeframe.AllTime,
  },
  questionFilterDefaults: {
    sort: QuestionSort.MostLiked,
    period: MetricTimeframe.AllTime,
    limit: 50,
  },
  baseModels: ['SD 1.4', 'SD 1.5', 'SD 2.0', 'SD 2.0 768', 'SD 2.1', 'SD 2.1 768', 'Other'],
  modelFileTypes: [
    'Model',
    'Text Encoder',
    'Pruned Model',
    'Negative',
    'Training Data',
    'VAE',
    'Config',
  ],
  tagFilterDefaults: {
    trendingTagsLimit: 20,
  },
} as const;

export type BaseModel = typeof constants.baseModels[number];
export type ModelFileType = typeof constants.modelFileTypes[number];
