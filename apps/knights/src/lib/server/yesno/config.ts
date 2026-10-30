export type YesNoSettings = {
  /** Chance that a feed slot is a yes/no question when one is available. Above one half, they come more often than ratings. */
  share: number;
  /** Questions of one axis in a row before the next axis starts. */
  stretch: number;
};

export const DEFAULT_YESNO: YesNoSettings = { share: 0.7, stretch: 8 };

const read = (raw: string | undefined, fallback: number, valid: (n: number) => boolean) => {
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && valid(value) ? value : fallback;
};

/** Operator-tuned values come from the environment (see `.env.example`), not from the source. `KNIGHTS_YESNO_SHARE=0` turns yes/no questions off. */
export function yesNoSettings(env: Record<string, string | undefined>): YesNoSettings {
  return {
    share: read(env.KNIGHTS_YESNO_SHARE, DEFAULT_YESNO.share, (n) => n >= 0 && n <= 1),
    stretch: read(
      env.KNIGHTS_YESNO_STRETCH,
      DEFAULT_YESNO.stretch,
      (n) => Number.isInteger(n) && n > 0
    ),
  };
}
