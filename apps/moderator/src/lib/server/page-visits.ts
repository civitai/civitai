import { getClickhouse } from './clickhouse';
import { dbRead } from './db';

const TABLE = 'moderator_page_views';

export type PageVisit = {
  /** The visiting moderator's user id. */
  userId: number;
  /**
   * SvelteKit route id of the visited page, e.g. `/images` or `/challenges/[id]/edit` — the route
   * pattern, not the resolved pathname, so dynamic-segment pages roll up to one row in summaries.
   */
  location: string;
};

/**
 * Append a moderator page visit to ClickHouse. Call this ONLY once the auth guard has authorized a
 * moderator (see src/routes/+layout.server.ts) so unauthorized/redirected requests never record.
 *
 * Fire-and-forget: the underlying client uses async inserts (server-side batching), and any failure
 * is swallowed — visit logging must never break or delay a page render. `visitedAt` is filled by the
 * table's `DEFAULT now()`.
 */
export async function recordPageVisit({ userId, location }: PageVisit): Promise<void> {
  try {
    await getClickhouse().insert({
      table: TABLE,
      values: [{ userId, location }],
      format: 'JSONEachRow',
    });
  } catch (err) {
    console.error('[page-visits] failed to record visit', err);
  }
}

export type PageVisitSummaryRow = {
  location: string;
  visits: number;
  distinctMods: number;
  lastVisit: string;
};

/**
 * Visit counts per page over the last `days` days, ascending — the bottom of the list (and any known
 * moderator route absent from it entirely) are dead-page candidates.
 */
export async function getPageVisitSummary(days = 30): Promise<PageVisitSummaryRow[]> {
  return getClickhouse().$query<PageVisitSummaryRow>`
    SELECT location,
           count()                   AS visits,
           uniqExact(userId)         AS distinctMods,
           max(visitedAt)            AS lastVisit
    FROM ${TABLE}
    WHERE visitedAt >= now() - INTERVAL ${days} DAY
    GROUP BY location
    ORDER BY visits ASC
  `;
}

export type RouteUserBreakdownRow = {
  userId: number;
  username: string | null;
  visits: number;
  lastVisit: string;
};

/**
 * Per-user visit breakdown for a single route over the last `days` days, busiest first. `location` is
 * user-supplied (a query param), so it's passed as a bound ClickHouse parameter, not interpolated.
 * Usernames are resolved from Postgres since ClickHouse only stores the user id.
 */
export async function getRouteUserBreakdown(
  location: string,
  days = 30
): Promise<RouteUserBreakdownRow[]> {
  const resultSet = await getClickhouse().query({
    query: `
      SELECT userId, count() AS visits, max(visitedAt) AS lastVisit
      FROM ${TABLE}
      WHERE location = {location:String}
        AND visitedAt >= subtractDays(now(), {days:UInt32})
      GROUP BY userId
      ORDER BY visits DESC
    `,
    query_params: { location, days },
    format: 'JSONEachRow',
  });
  const rows = await resultSet.json<{ userId: number; visits: number; lastVisit: string }[]>();
  if (!rows.length) return [];

  const users = await dbRead
    .selectFrom('User')
    .select(['id', 'username'])
    .where(
      'id',
      'in',
      rows.map((r) => r.userId)
    )
    .execute();
  const nameById = new Map(users.map((u) => [u.id, u.username]));

  return rows.map((r) => ({
    userId: r.userId,
    username: nameById.get(r.userId) ?? null,
    visits: r.visits,
    lastVisit: r.lastVisit,
  }));
}
