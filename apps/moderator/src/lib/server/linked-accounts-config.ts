import { env } from '$env/dynamic/private';

// No defaults, by design: this repo is public and these values are detection settings. Unset or
// malformed turns the signal off.

export type LinkConfig = {
  nearLogin: { windowSeconds: number; loginSample: number } | null;
  buzz: { lookbackDays: number } | null;
};

const MAX = {
  LINKED_ACCOUNTS_LOGIN_WINDOW_SECONDS: 86_400,
  // Each sampled login adds ~265 bytes of SQL; ClickHouse refuses a query over 256 KiB.
  LINKED_ACCOUNTS_LOGIN_SAMPLE: 500,
  LINKED_ACCOUNTS_BUZZ_LOOKBACK_DAYS: 3_650,
} as const;

type Key = keyof typeof MAX;

// MAX bounds query cost, not detection: each value goes into ClickHouse as a number, and an oversized
// one is a scan.
function positiveInt(raw: Record<string, string | undefined>, key: Key): number | null {
  const value = raw[key]?.trim();
  if (!value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(n > 0 && n <= MAX[key])) {
    console.error(`[linked-accounts] ${key} is not a whole number in 1..${MAX[key]}; signal off`);
    return null;
  }
  return n;
}

export function parseLinkConfig(raw: Record<string, string | undefined>): LinkConfig {
  const windowSeconds = positiveInt(raw, 'LINKED_ACCOUNTS_LOGIN_WINDOW_SECONDS');
  const loginSample = positiveInt(raw, 'LINKED_ACCOUNTS_LOGIN_SAMPLE');
  const lookbackDays = positiveInt(raw, 'LINKED_ACCOUNTS_BUZZ_LOOKBACK_DAYS');
  return {
    nearLogin: windowSeconds && loginSample ? { windowSeconds, loginSample } : null,
    buzz: lookbackDays ? { lookbackDays } : null,
  };
}

export const linkConfig = () => parseLinkConfig(env);
