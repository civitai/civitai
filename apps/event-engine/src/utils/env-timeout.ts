/** Node clamps a timer longer than this to 1 ms, which would make a "very long" timeout fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A timeout read from the env, with the off-switch convention of REDIS_SYS_READ_TIMEOUT_MS: unset or
 * unparseable uses `fallback`; zero or below turns the bound off (`undefined`); past Node's timer limit is
 * capped at the limit.
 */
export function envTimeoutMs(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed > 0 ? Math.min(parsed, MAX_TIMER_MS) : undefined;
}
