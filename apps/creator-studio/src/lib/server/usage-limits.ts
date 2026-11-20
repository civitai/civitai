import type { UsageLimitRow } from '@civitai/shared/usage-limit-view';
import { callMainApp, MAIN_APP_URL } from '$lib/server/main-app';

/** The main app's page with every limit, linked from each place that shows some of them. */
export const USAGE_LIMITS_URL = `${MAIN_APP_URL}/user/account/usage`;

/** The signed-in creator's rows from the main app, or null when the read failed or threw. */
export async function loadUsageLimits(cookie: string): Promise<UsageLimitRow[] | null> {
  const result = await callMainApp<{ limits: UsageLimitRow[] }>('/api/v1/me/limits', cookie, {
    timeoutMs: 3000,
  }).catch(() => null);
  return result?.ok ? result.data.limits : null;
}
