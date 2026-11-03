export type HarvestConfig = {
  cursorName: string;
  batchSize: number;
  maxBatches: number;
  maxRulingAgeDays: number;
  hiddenCheckShare: number;
  freshMaxAgeDays: number;
  /** Hold harvested Trials items as `pending` until a moderator confirms the rating blind. */
  spotCheck: boolean;
};

export const HARVEST: HarvestConfig = {
  cursorName: 'trials',
  batchSize: 500,
  maxBatches: 10,
  maxRulingAgeDays: 14,
  hiddenCheckShare: 0.3,
  freshMaxAgeDays: 60,
  spotCheck: false,
};
