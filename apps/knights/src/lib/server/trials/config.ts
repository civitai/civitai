export type HarvestConfig = {
  cursorName: string;
  batchSize: number;
  maxBatches: number;
  maxRulingAgeDays: number;
  hiddenCheckShare: number;
  freshMaxAgeDays: number;
  /** Hold harvested apprenticeship items as `pending` until a moderator confirms the rating blind. */
  spotCheck: boolean;
};

export const HARVEST: HarvestConfig = {
  cursorName: 'trials',
  batchSize: 500,
  maxBatches: 10,
  maxRulingAgeDays: 14,
  /** A single ruling is not enough to grade Knights against, so harvested rulings go to trials unless an operator opts in. */
  hiddenCheckShare: 0,
  freshMaxAgeDays: 60,
  spotCheck: false,
};

export type HarvestSettings = {
  paused: boolean;
  hiddenCheckShare: number;
};

/**
 * Operator switches from the environment (see `.env.example`): `KNIGHTS_HARVEST` runs the harvest only when unset or
 * `on` (any other value, `off` included, pauses it), and
 * `KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE` (0 to 1) sends that share of new rulings to hidden checks.
 */
export function harvestSettings(env: Record<string, string | undefined>): HarvestSettings {
  const share = Number(env.KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE?.trim() || NaN);
  return {
    paused: !['', 'on'].includes(env.KNIGHTS_HARVEST?.trim().toLowerCase() ?? ''),
    hiddenCheckShare: share >= 0 && share <= 1 ? share : HARVEST.hiddenCheckShare,
  };
}
