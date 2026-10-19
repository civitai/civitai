import { env } from '$env/dynamic/private';

// Detection settings live in the deployment's secrets only. There is deliberately no default: an
// unset or malformed value turns its signal off and the panel says so.

export type LinkConfig = {
  nearLogin: { windowSeconds: number; loginSample: number } | null;
  buzz: { lookbackDays: number } | null;
};

const MAX = {
  LINKED_ACCOUNTS_LOGIN_WINDOW_SECONDS: 86_400,
  LINKED_ACCOUNTS_LOGIN_SAMPLE: 1_000,
  LINKED_ACCOUNTS_BUZZ_LOOKBACK_DAYS: 3_650,
} as const;

type Key = keyof typeof MAX;

// The upper bounds are query-cost guards, not detection settings: every value lands in a ClickHouse
// query as a number, and an oversized one is a scan.
function positiveInt(raw: Record<string, string | undefined>, key: Key): number | null {
  const value = raw[key]?.trim();
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > MAX[key]) {
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
