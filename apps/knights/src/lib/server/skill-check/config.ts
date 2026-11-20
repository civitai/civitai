import type { StoredSettings } from '../settings/stored';

export type SkillCheckSettings = {
  /** Active mod-confirmed checks kept; a new one past it retires the oldest. */
  poolCap: number;
  /** Whether a player may be served a mod-confirmed check on an image they already saw (judged in the queue, or answered as an Acolyte). */
  serveJudged: boolean;
};

/** Used when neither the moderator Config page nor the environment sets a value. */
export const DEFAULT_SKILL_CHECKS: SkillCheckSettings = { poolCap: 500, serveJudged: false };

const ON_VALUES = ['on', 'true', '1'];

/** A value saved on the moderator Config page wins (`stored`); without one, the environment (see `.env.example`), then the default. */
export function skillCheckSettings(
  env: Record<string, string | undefined>,
  stored: StoredSettings = {}
): SkillCheckSettings {
  const raw = env.KNIGHTS_SKILL_CHECK_POOL_CAP?.trim();
  const cap = raw ? Number(raw) : NaN;
  return {
    poolCap:
      stored.skillCheckPoolCap ??
      (Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_SKILL_CHECKS.poolCap),
    serveJudged:
      stored.skillCheckServeJudged ??
      ON_VALUES.includes(env.KNIGHTS_SKILL_CHECK_SERVE_JUDGED?.trim().toLowerCase() ?? ''),
  };
}
