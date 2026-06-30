import { env } from '$env/dynamic/private';

// The hub emits its own login-funnel analytics straight to the shared ClickHouse tracker service (the same
// ingestion the main app POSTs to), so auth stays decoupled — removing the in-page login UI doesn't drop login
// events.

type Actor = { userId?: number | null; ip?: string | null; userAgent?: string | null };

/**
 * Emit a `LoginRedirect` action event matching the main app's Tracker — `{ userId, ip, userAgent, type, reason,
 * details }` POSTed to the tracker's `actions` table. Any reason (no allowlist). No-op when
 * `CLICKHOUSE_TRACKER_URL` is unset (e.g. local dev); never throws. Caller must NOT await (fire-and-forget).
 */
export async function trackLoginRedirect(reason: string, actor: Actor): Promise<void> {
  const base = env.CLICKHOUSE_TRACKER_URL;
  if (!base || !reason) return;

  const body = {
    userId: actor.userId ?? 0,
    ip: actor.ip ?? '',
    userAgent: actor.userAgent ?? '',
    type: 'LoginRedirect',
    reason,
    details: '',
  };

  try {
    const res = await fetch(`${base}/track/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[auth] tracker returned ${res.status} for LoginRedirect`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[auth] failed to track LoginRedirect', e);
  }
}
