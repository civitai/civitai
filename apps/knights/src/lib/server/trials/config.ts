import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';

export const TRIAL_MODULES: readonly string[] = [KNIGHTS_NSFW_LEVEL_QUESTION];

export const TRIALS = {
  runLength: 12,
  freshCount: 8,
  minFresh: 3,
  passMark: 0.75,
  cooldownHours: 24,
} as const;

export type HarvestConfig = {
  cursorName: string;
  batchSize: number;
  maxBatches: number;
  maxRulingAgeDays: number;
  hiddenCheckShare: number;
  freshMaxAgeDays: number;
};

export const HARVEST: HarvestConfig = {
  cursorName: 'trials',
  batchSize: 500,
  maxBatches: 10,
  maxRulingAgeDays: 14,
  hiddenCheckShare: 0.3,
  freshMaxAgeDays: 60,
};
