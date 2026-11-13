/**
 * A timeout read from the env, with the off-switch convention of REDIS_SYS_READ_TIMEOUT_MS: unset or
 * unparseable uses `fallback`; zero or below turns the bound off (`undefined`).
 */
export function envTimeoutMs(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed > 0 ? parsed : undefined;
}
