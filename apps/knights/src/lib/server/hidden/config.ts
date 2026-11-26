import type { StoredSettings } from '../settings/stored';

export type HiddenCheckSettings = {
  rate: number;
  failureWindowHours: number;
  severeDistance: number;
  /** Minutes before the tick's sweep grades a check still pending (a check answered on /play is graded at once). */
  settleDelayMinutes: number;
  /** Answers a check needs before its failure rate can retire it. */
  retireMinAnswers: number;
  /** A check failed by more than this share of its answers is retired: its known answer is likely wrong or unclear. */
  retireFailureRate: number;
  /** Share (0 to 1) of served checks drawn from the probation pool; 0 serves none. */
  probationShare: number;
};

/** Used when neither the moderator Config page nor the environment sets a value. */
export const DEFAULT_HIDDEN_CHECKS: HiddenCheckSettings = {
  rate: 0.05,
  failureWindowHours: 24,
  severeDistance: 2,
  settleDelayMinutes: 30,
  retireMinAnswers: 20,
  retireFailureRate: 0.5,
  probationShare: 0,
};

const read = (raw: string | undefined, fallback: number, valid: (n: number) => boolean) => {
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && valid(value) ? value : fallback;
};

/** A value saved on the moderator Config page wins (`stored`); without one, the environment (see `.env.example`), then the default. */
export function hiddenCheckSettings(
  env: Record<string, string | undefined>,
  stored: StoredSettings = {}
): HiddenCheckSettings {
  return {
    rate:
      stored.hiddenCheckRate ??
      read(env.KNIGHTS_HIDDEN_CHECK_RATE, DEFAULT_HIDDEN_CHECKS.rate, (n) => n >= 0 && n <= 1),
    failureWindowHours:
      stored.hiddenCheckFailureWindowHours ??
      read(
        env.KNIGHTS_HIDDEN_CHECK_FAILURE_WINDOW_HOURS,
        DEFAULT_HIDDEN_CHECKS.failureWindowHours,
        (n) => n > 0
      ),
    severeDistance:
      stored.hiddenCheckSevereDistance ??
      read(
        env.KNIGHTS_HIDDEN_CHECK_SEVERE_DISTANCE,
        DEFAULT_HIDDEN_CHECKS.severeDistance,
        (n) => Number.isInteger(n) && n > 0
      ),
    settleDelayMinutes:
      stored.hiddenCheckSettleDelayMinutes ??
      read(
        env.KNIGHTS_HIDDEN_CHECK_SETTLE_DELAY_MINUTES,
        DEFAULT_HIDDEN_CHECKS.settleDelayMinutes,
        (n) => n >= 0
      ),
    retireMinAnswers:
      stored.hiddenCheckRetireMinAnswers ??
      read(
        env.KNIGHTS_HIDDEN_CHECK_RETIRE_MIN_ANSWERS,
        DEFAULT_HIDDEN_CHECKS.retireMinAnswers,
        (n) => Number.isInteger(n) && n > 0
      ),
    retireFailureRate:
      stored.hiddenCheckRetireFailureRate ??
      read(
        env.KNIGHTS_HIDDEN_CHECK_RETIRE_FAILURE_RATE,
        DEFAULT_HIDDEN_CHECKS.retireFailureRate,
        (n) => n > 0 && n <= 1
      ),
    probationShare: read(
      env.KNIGHTS_HIDDEN_CHECK_PROBATION_SHARE,
      DEFAULT_HIDDEN_CHECKS.probationShare,
      (n) => n >= 0 && n <= 1
    ),
  };
}
