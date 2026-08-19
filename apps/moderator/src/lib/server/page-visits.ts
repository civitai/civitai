import { getClickhouse } from './clickhouse';
import { usersByIds } from './users.service';

const TABLE = 'moderator_page_views';

export type PageVisit = {
  userId: number;
  /** Route id (the pattern, not the resolved pathname) so dynamic pages roll up to one row. */
  location: string;
};

// Call ONLY after the auth guard has authorized the moderator, or unauthorized requests get recorded.
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

// `location` is user-supplied — pass it as a bound ClickHouse parameter, never interpolated.
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

  const nameById = await usersByIds(rows.map((r) => r.userId));

  return rows.map((r) => ({
    userId: r.userId,
    username: nameById.get(r.userId)?.username ?? null,
    visits: r.visits,
    lastVisit: r.lastVisit,
  }));
}
