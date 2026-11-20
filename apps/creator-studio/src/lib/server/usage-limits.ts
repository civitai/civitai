import type { UsageLimitRow } from '@civitai/shared/usage-limit-view';
import { callMainApp } from '$lib/server/main-app';

/** The signed-in creator's rows from the main app, or null when the read failed. */
export async function loadUsageLimits(cookie: string): Promise<UsageLimitRow[] | null> {
  const result = await callMainApp<{ limits: UsageLimitRow[] }>('/api/v1/me/limits', cookie, {
    timeoutMs: 3000,
  });
  return result.ok ? result.data.limits : null;
}
