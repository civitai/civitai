import type { StoredSettings } from '../settings/stored';

export type YesNoSettings = {
  /** 0 switches yes/no questions off. Any other value leaves them on; how often they come is the burst cadence (`cadence.ts`). */
  share: number;
  /** Questions of one axis in a row before the next axis starts. */
  stretch: number;
  /** An answered question nobody has answered for this many days is closed with no outcome. */
  maxAgeDays: number;
  /** The moderator tag review source: created, served and written back only when the Config page switched it on. */
  tagReview: boolean;
  /** Whether a player who never set the questions switch in Knights settings is served yes/no questions. */
  playerDefault: boolean;
  /** Distinct players who must report a question before it stops being served to anyone (`report.ts`). */
  reportThreshold: number;
};

export const DEFAULT_YESNO: YesNoSettings = {
  share: 0.7,
  stretch: 8,
  maxAgeDays: 14,
  tagReview: false,
  playerDefault: false,
  reportThreshold: 5,
};

const read = (raw: string | undefined, fallback: number, valid: (n: number) => boolean) => {
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && valid(value) ? value : fallback;
};

/**
 * A value saved on the moderator Config page wins (`stored`); without one, the environment (see `.env.example`), then the
 * default. `share: 0` turns yes/no questions off.
 */
export function yesNoSettings(
  env: Record<string, string | undefined>,
  stored: StoredSettings = {}
): YesNoSettings {
  return {
    share:
      stored.yesNoShare ??
      read(env.KNIGHTS_YESNO_SHARE, DEFAULT_YESNO.share, (n) => n >= 0 && n <= 1),
    stretch:
      stored.yesNoStretch ??
      read(env.KNIGHTS_YESNO_STRETCH, DEFAULT_YESNO.stretch, (n) => Number.isInteger(n) && n > 0),
    maxAgeDays:
      stored.yesNoMaxAgeDays ??
      read(env.KNIGHTS_YESNO_MAX_AGE_DAYS, DEFAULT_YESNO.maxAgeDays, (n) => n > 0),
    // No environment fallback: turning it on is the moderators' call, made and audited on the Config page.
    tagReview: stored.modTagReview === true,
    playerDefault:
      stored.yesNoPlayerDefault ?? env.KNIGHTS_YESNO_PLAYER_DEFAULT?.trim().toLowerCase() === 'on',
    reportThreshold:
      stored.yesNoReportThreshold ??
      read(
        env.KNIGHTS_YESNO_REPORT_THRESHOLD,
        DEFAULT_YESNO.reportThreshold,
        (n) => Number.isInteger(n) && n > 0
      ),
  };
}
