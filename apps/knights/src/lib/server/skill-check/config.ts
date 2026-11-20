import type { StoredSettings } from '../settings/stored';

export type SkillCheckSettings = {
  /**
   * The whole feature: reviews opening, moderators getting the queue on /play, and the pool being served. Off, nothing of
   * it runs (default).
   */
  enabled: boolean;
  /** Active mod-confirmed checks kept; a new one past it retires the oldest. */
  poolCap: number;
  /** Whether a player may be served a mod-confirmed check on an image they already saw (judged in the queue, or answered as an Acolyte). */
  serveJudged: boolean;
};

/** Used when neither the moderator Config page nor the environment sets a value. */
export const DEFAULT_SKILL_CHECKS: SkillCheckSettings = {
  enabled: false,
  poolCap: 500,
  serveJudged: false,
};

const ON_VALUES = ['on', 'true', '1'];

/** A value saved on the moderator Config page wins (`stored`); without one, the environment (see `.env.example`), then the default. */
export function skillCheckSettings(
  env: Record<string, string | undefined>,
  stored: StoredSettings = {}
): SkillCheckSettings {
  const raw = env.KNIGHTS_SKILL_CHECK_POOL_CAP?.trim();
  const cap = raw ? Number(raw) : NaN;
  const on = (raw: string | undefined) => ON_VALUES.includes(raw?.trim().toLowerCase() ?? '');
  return {
    enabled: stored.inquisitorQueue ?? on(env.KNIGHTS_INQUISITOR_QUEUE),
    poolCap:
      stored.skillCheckPoolCap ??
      (Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_SKILL_CHECKS.poolCap),
    serveJudged: stored.skillCheckServeJudged ?? on(env.KNIGHTS_SKILL_CHECK_SERVE_JUDGED),
  };
}
