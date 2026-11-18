import type { StoredSettings } from '../settings/stored';

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

/** `KNIGHTS_HARVEST` values that run or pause the harvest; any other value pauses it too, and is reported. */
const RUN_VALUES = ['', 'on', 'true', '1'];
const PAUSE_VALUES = ['off', 'false', '0'];

export type HarvestSettings = {
  paused: boolean;
  hiddenCheckShare: number;
  /** A `KNIGHTS_HARVEST` value that is neither a run nor a pause value (the harvest is then paused). */
  unrecognized?: string;
};

/**
 * A value saved on the moderator Config page wins (`stored`); without one, the environment (see `.env.example`):
 * `KNIGHTS_HARVEST` runs the harvest when unset or one of `RUN_VALUES`, and pauses it on `PAUSE_VALUES` or anything
 * else, and
 * `KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE` (0 to 1) sends that share of new rulings to hidden checks.
 */
export function harvestSettings(
  env: Record<string, string | undefined>,
  stored: StoredSettings = {}
): HarvestSettings {
  const share = Number(env.KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE?.trim() || NaN);
  const hiddenCheckShare =
    stored.harvestHiddenCheckShare ?? (share >= 0 && share <= 1 ? share : HARVEST.hiddenCheckShare);
  if (stored.harvest !== undefined) return { paused: !stored.harvest, hiddenCheckShare };
  const value = env.KNIGHTS_HARVEST?.trim().toLowerCase() ?? '';
  if (RUN_VALUES.includes(value)) return { paused: false, hiddenCheckShare };
  if (PAUSE_VALUES.includes(value)) return { paused: true, hiddenCheckShare };
  return { paused: true, hiddenCheckShare, unrecognized: value };
}
