import { getClickhouse } from './clickhouse';

// Today's prohibited (audit-blocked) generation requests, read from ClickHouse. Ported from the main app's
// user-restriction router; the spoke reads ClickHouse directly (no main-app call). The legacy page's
// "flag as suspicious" write is intentionally dropped, so this is read-only.

export type ProhibitedPrompt = {
  userId: number;
  prompt: string;
  negativePrompt: string;
  source: string;
  createdDate: string;
};

export type ProhibitedUserCount = { userId: number; count: number };

export async function getTodaysProhibitedPrompts(limit = 500): Promise<ProhibitedPrompt[]> {
  const resultSet = await getClickhouse().query({
    query: `
      SELECT userId, prompt, negativePrompt, source, createdDate
      FROM prohibitedRequests
      WHERE toDate(createdDate) = today()
      ORDER BY createdDate DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { limit },
    format: 'JSONEachRow',
  });
  return resultSet.json<ProhibitedPrompt[]>();
}

export async function getTodaysProhibitedUserCounts(): Promise<ProhibitedUserCount[]> {
  const resultSet = await getClickhouse().query({
    query: `
      SELECT userId, count() AS count
      FROM prohibitedRequests
      WHERE toDate(createdDate) = today()
      GROUP BY userId
      ORDER BY count DESC
    `,
    format: 'JSONEachRow',
  });
  const rows = await resultSet.json<{ userId: number; count: string }[]>();
  return rows.map((r) => ({ userId: r.userId, count: Number(r.count) }));
}
