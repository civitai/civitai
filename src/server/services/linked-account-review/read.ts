import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { clickhouseDateTime } from '~/server/services/creator-program-bankable';
import type { LinkedAccountReviewConfig } from './config';
import type { FlowEdge, FlowInput, SignIn } from './groups';

export type Standing = { userId: number; leaderboardId: string; position: number };

export type LinkedAccountReader = {
  flows: (config: LinkedAccountReviewConfig, since: Date) => Promise<FlowInput>;
  signIns: (userIds: number[], since: Date) => Promise<SignIn[]>;
  standings: (userIds: number[]) => Promise<Standing[]>;
  excluded: (userIds: number[]) => Promise<number[]>;
};

export type ClickhousePort = { $query: <T extends object>(sql: string) => Promise<T[]> };

const SIGN_IN_TYPES = `'Login', 'Registration', 'Subscribe'`;
const ID_CHUNK = 4_000;

const ints = (ids: number[]) => ids.map((id) => Math.trunc(id)).join(',');

function chunks<T>(items: T[], size = ID_CHUNK) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function stickerEdges(since: Date, pairMin: number): Promise<FlowEdge[]> {
  const rows = await dbRead.$queryRaw<
    { from: number; to: number; amount: number; senderTotal: number }[]
  >`
    WITH p AS (
      SELECT "placerId" AS a, "ownerId" AS b, count(*)::int AS n
      FROM "Placement"
      WHERE surface = 'sticker' AND "createdAt" > ${since} AND "placerId" <> "ownerId"
      GROUP BY 1, 2
    ),
    t AS (SELECT a, sum(n)::int AS tn FROM p GROUP BY 1)
    SELECT p.a AS "from", p.b AS "to", p.n AS amount, t.tn AS "senderTotal"
    FROM p JOIN t USING (a)
    WHERE p.n >= ${pairMin}
  `;
  return rows;
}

export async function buzzEdges(
  ch: ClickhousePort,
  since: Date,
  config: LinkedAccountReviewConfig
): Promise<FlowEdge[]> {
  const types = config.buzzAccountTypes.map((t) => `'${t}'`).join(',');
  const rows = await ch.$query<{
    sender: string;
    payee: string;
    amount: string;
    senderTotal: string;
  }>(`
    WITH e AS (
      SELECT fromAccountId AS a, toAccountId AS b, sum(amount) AS amt
      FROM buzzTransactions
      WHERE date >= ${clickhouseDateTime(since)} AND type IN ('tip', 'donation')
        AND fromAccountType = toAccountType AND fromAccountType IN (${types})
        AND fromAccountId != toAccountId AND fromAccountId > 0 AND toAccountId > 0
      GROUP BY a, b
    ),
    t AS (SELECT a, sum(amt) AS tamt FROM e GROUP BY a)
    SELECT e.a AS sender, e.b AS payee, e.amt AS amount, t.tamt AS senderTotal
    FROM e INNER JOIN t ON e.a = t.a
    WHERE t.tamt >= ${Number(config.buzzSenderMin)}
      AND e.amt >= ${Number(config.buzzEdgeShare)} * t.tamt
  `);
  return rows.map((r) => ({
    from: Number(r.sender),
    to: Number(r.payee),
    amount: Number(r.amount),
    senderTotal: Number(r.senderTotal),
  }));
}

export async function signIns(
  ch: ClickhousePort,
  userIds: number[],
  since: Date
): Promise<SignIn[]> {
  const out: SignIn[] = [];
  const window = `time >= ${clickhouseDateTime(since)} AND type IN (${SIGN_IN_TYPES})`;
  for (const ids of chunks(userIds)) {
    const rows = await ch.$query<{ userId: string; ip: string; ipAccounts: string }>(`
      WITH l AS (
        SELECT DISTINCT userId, ip FROM userActivities
        WHERE ${window} AND userId IN (${ints(ids)}) AND ip != ''
      ),
      c AS (
        SELECT ip, uniqExact(userId) AS accounts FROM userActivities
        WHERE ${window} AND ip IN (SELECT ip FROM l)
        GROUP BY ip
      )
      SELECT l.userId AS userId, l.ip AS ip, c.accounts AS ipAccounts
      FROM l INNER JOIN c ON c.ip = l.ip
    `);
    for (const r of rows)
      out.push({ userId: Number(r.userId), ip: r.ip, ipAccounts: Number(r.ipAccounts) });
  }
  return out;
}

async function standings(userIds: number[]): Promise<Standing[]> {
  if (userIds.length === 0) return [];
  return dbRead.$queryRaw<Standing[]>`
    WITH latest AS (
      SELECT "leaderboardId", max(date) AS d FROM "LeaderboardResult"
      WHERE date > now() - interval '3 days'
      GROUP BY 1
    )
    SELECT r."userId", r."leaderboardId", r.position
    FROM "LeaderboardResult" r
    JOIN latest ON latest."leaderboardId" = r."leaderboardId" AND latest.d = r.date
    WHERE r."userId" = ANY(${userIds}::int[])
  `;
}

async function excluded(userIds: number[]): Promise<number[]> {
  if (userIds.length === 0) return [];
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id FROM "User" WHERE "excludeFromLeaderboards" AND id = ANY(${userIds}::int[])
  `;
  return rows.map((r) => r.id);
}

/** Null when ClickHouse is not configured: the run cannot see either half it needs from there. */
export function createLinkedAccountReader(): LinkedAccountReader | null {
  const ch = clickhouse;
  if (!ch) return null;
  return {
    flows: async (config, since) => {
      const [stickers, buzz] = await Promise.all([
        stickerEdges(since, config.stickerPairMin),
        buzzEdges(ch, since, config),
      ]);
      return { stickers, buzz };
    },
    signIns: (userIds, since) => signIns(ch, userIds, since),
    standings,
    excluded,
  };
}
