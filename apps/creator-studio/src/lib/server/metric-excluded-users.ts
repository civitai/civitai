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
    // Postgres ids only: `Number(null)` is 0, and an id outside int4 would fail the `::int[]` cast in the query that
    // uses this list, outside this function's fail-open.
    return rows
      .map((r) => Number(r.userId))
      .filter((id) => Number.isInteger(id) && id > 0 && id <= INT4_MAX);
  },
});

const INT4_MAX = 2_147_483_647;
// The page this gates read only Postgres before; a stalled ClickHouse must not hold it for the client's own timeout.
const READ_TIMEOUT_MS = 2000;

let outageReported = false;

/** Fails open: [] when the set cannot be read, so callers list and count everyone, as before. */
export async function getMetricExcludedUserIds(): Promise<number[]> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = await Promise.race([
      excludedUsers.get({}),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('exclusion list read timed out')),
          READ_TIMEOUT_MS
        );
      }),
    ]).finally(() => clearTimeout(timer));
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
