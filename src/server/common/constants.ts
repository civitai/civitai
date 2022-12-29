import { QuestionSort } from './enums';
import { MetricTimeframe } from '@prisma/client';
import { BountySort, ModelSort } from '~/server/common/enums';
import { DefaultMantineColor } from '@mantine/core';

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
  baseModels: ['SD 1.4', 'SD 1.5', 'SD 2.0', 'SD 2.1', 'SD 2.0 768', 'Other'],
  modelFileTypes: ['Model', 'Pruned Model', 'Negative', 'Training Data', 'VAE', 'Config'],
  bountyFilterDefaults: {
    sort: BountySort.HighestBounty,
    period: MetricTimeframe.AllTime,
    limit: 100,
  },
  mantineColors: [
    'blue',
    'cyan',
    'grape',
    'green',
    'indigo',
    'lime',
    'orange',
    'pink',
    'red',
    'teal',
    'violet',
    'yellow',
  ] as DefaultMantineColor[],
} as const;

export type BaseModel = typeof constants.baseModels[number];
export type ModelFileType = typeof constants.modelFileTypes[number];
