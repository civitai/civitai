import { safeError } from '@civitai/axiom';
import { createCache } from '$lib/server/cache';
import { getClickhouse } from '$lib/server/clickhouse';
import { getLogger } from '$lib/server/logger';

// The users that reaction totals leave out, read from the same ClickHouse source and with the same freshness as the
// main app's `getMetricExcludedUserIds` (src/server/services/metric-excluded-users.service.ts).
const excludedUsers = createCache({
  name: 'metric-excluded-users',
  ttlSeconds: 180,
  fetch: async () => {
    const rows = await getClickhouse().$query<{ userId: number | string }>(
      `SELECT userId FROM metricExcludedUsers FINAL WHERE active = 1`
    );
    // `Number(null)` is 0, which would otherwise enter the list as a user id.
    return rows.map((r) => Number(r.userId)).filter((id) => Number.isFinite(id) && id > 0);
  },
});

let outageReported = false;

/** Fails open: [] when the set cannot be read, so callers list and count everyone, as before. */
export async function getMetricExcludedUserIds(): Promise<number[]> {
  try {
    const ids = await excludedUsers.get({});
    if (!Array.isArray(ids)) throw new Error('cached exclusion list was not an array');
    outageReported = false;
    return ids;
  } catch (error) {
    // Once per outage: this runs on every "Who reacted" page load.
    if (!outageReported) {
      outageReported = true;
      getLogger()
        .logToAxiom({ name: 'metric-excluded-users-unavailable', error: safeError(error) })
        .catch(() => undefined);
    }
    return [];
  }
}
