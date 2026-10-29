export type HiddenCheckSettings = {
  rate: number;
  failureWindowHours: number;
  severeDistance: number;
};

/** Used when the environment does not set a value. */
export const DEFAULT_HIDDEN_CHECKS: HiddenCheckSettings = {
  rate: 0.05,
  failureWindowHours: 24,
  severeDistance: 2,
};

const read = (raw: string | undefined, fallback: number, valid: (n: number) => boolean) => {
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && valid(value) ? value : fallback;
};

/** Operator-tuned values come from the environment (see `.env.example`), not from the source. */
export function hiddenCheckSettings(env: Record<string, string | undefined>): HiddenCheckSettings {
  return {
    rate: read(env.KNIGHTS_HIDDEN_CHECK_RATE, DEFAULT_HIDDEN_CHECKS.rate, (n) => n >= 0 && n <= 1),
    failureWindowHours: read(
      env.KNIGHTS_HIDDEN_CHECK_FAILURE_WINDOW_HOURS,
      DEFAULT_HIDDEN_CHECKS.failureWindowHours,
      (n) => n > 0
    ),
    severeDistance: read(
      env.KNIGHTS_HIDDEN_CHECK_SEVERE_DISTANCE,
      DEFAULT_HIDDEN_CHECKS.severeDistance,
      (n) => Number.isInteger(n) && n > 0
    ),
  };
}
