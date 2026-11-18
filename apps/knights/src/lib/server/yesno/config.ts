import { readKnightsSourcesConfig } from '@civitai/shared/new-order';
import { REDIS_TIMEOUT_MS, within } from '../redis-timeout';

export type YesNoSettings = {
  /** 0 switches yes/no questions off. Any other value leaves them on; how often they come is the burst cadence (`cadence.ts`). */
  share: number;
  /** Questions of one axis in a row before the next axis starts. */
  stretch: number;
  /** An answered question nobody has answered for this many days is closed with no outcome. */
  maxAgeDays: number;
};

export const DEFAULT_YESNO: YesNoSettings = { share: 0.7, stretch: 8, maxAgeDays: 14 };

const read = (raw: string | undefined, fallback: number, valid: (n: number) => boolean) => {
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && valid(value) ? value : fallback;
};

/**
 * Operator-tuned values come from the environment (see `.env.example`), not from the source. `KNIGHTS_YESNO_SHARE=0` turns yes/no
 * questions off; a share saved in the moderator app's sources config overrides it (`withStoredShare`).
 */
export function yesNoSettings(env: Record<string, string | undefined>): YesNoSettings {
  return {
    share: read(env.KNIGHTS_YESNO_SHARE, DEFAULT_YESNO.share, (n) => n >= 0 && n <= 1),
    stretch: read(
      env.KNIGHTS_YESNO_STRETCH,
      DEFAULT_YESNO.stretch,
      (n) => Number.isInteger(n) && n > 0
    ),
    maxAgeDays: read(env.KNIGHTS_YESNO_MAX_AGE_DAYS, DEFAULT_YESNO.maxAgeDays, (n) => n > 0),
  };
}

/** The share moderators saved on the sources config wins; without one the environment's share stands. */
export const withStoredShare = (
  settings: YesNoSettings,
  storedShare: number | undefined
): YesNoSettings => (storedShare === undefined ? settings : { ...settings, share: storedShare });

export type StoredShareSourceOptions = {
  /** The raw `system:knights-v2-sources` value. */
  read: () => Promise<string | Buffer | null>;
  ttlMs?: number;
  now?: () => number;
  timeoutMs?: number;
};

/**
 * The yes/no share saved in the moderator app, read at most once per `ttlMs` so serving an item never waits on it. A read
 * that fails keeps what was known (nothing before the first good read, so the environment share applies).
 */
export function createStoredShareSource({
  read,
  ttlMs = 30_000,
  now = Date.now,
  timeoutMs = REDIS_TIMEOUT_MS,
}: StoredShareSourceOptions) {
  let held: number | undefined;
  let readAt = -Infinity;
  let loading: Promise<number | undefined> | null = null;

  async function refresh(): Promise<number | undefined> {
    try {
      held = readKnightsSourcesConfig(await within(read(), timeoutMs)).config.yesNoShare;
    } catch (error) {
      console.error('knights: could not read the saved yes/no share', { error });
    }
    readAt = now();
    return held;
  }

  return {
    async load(): Promise<number | undefined> {
      if (now() - readAt < ttlMs) return held;
      loading ??= refresh().finally(() => (loading = null));
      return loading;
    },
  };
}
