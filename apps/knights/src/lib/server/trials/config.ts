export const TRIAL_MODULES: readonly string[] = ['knights.image.nsfwLevel'];

export const TRIALS = {
  runLength: 12,
  freshCount: 8,
  minFresh: 3,
  passMark: 0.75,
  cooldownHours: 24,
} as const;

export const HARVEST = {
  cursorName: 'trials',
  batchSize: 500,
  maxBatches: 10,
  maxRulingAgeDays: 14,
  hiddenCheckShare: 0.3,
  freshMaxAgeDays: 60,
} as const;
