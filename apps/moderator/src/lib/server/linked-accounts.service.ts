import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { accountStatus, usersByIds } from './users.service';
import { strikeCountsByUserIds } from './moderation-memory.service';
import { PUBLIC_IP_ONLY } from './clickhouse-filters';
import { clusterSql, ipCluster } from './ip-clusters';
import { USER_ACCOUNT_TYPES_SQL } from './buzz-accounts';
import { getSharedIpRows, getSharedSocialRows } from './user-signals.service';
import { linkConfig, type LinkConfig } from './linked-accounts-config';
import {
  LINK_SIGNALS,
  rankAccountLinks,
  type AccountLinkRow,
  type AccountLinks,
  type LinkSignal,
  type SignalStatus,
} from '$lib/linked-accounts';

// The ClickHouse helper does not escape: only controlled numbers and `ipCluster` keys go into a query.
// Times cross as unix seconds for that reason.

type Evidence = Pick<AccountLinkRow, 'userId' | 'regIp' | 'nearLogin' | 'buzz' | 'social'>;
type Found = { links: Evidence[]; truncated: boolean };

const NEARBY_ACCOUNTS = 100;
const BUZZ_COUNTERPARTIES = 50;

async function regIpLinks(userId: number): Promise<Found> {
  const { rows, truncated } = await getSharedIpRows(userId);
  const ips = new Map<number, Set<string>>();
  for (const r of rows) ips.set(r.userId, (ips.get(r.userId) ?? new Set()).add(r.ip));
  return {
    links: [...ips].map(([id, set]) => ({ userId: id, regIp: { ips: [...set] } })),
    truncated,
  };
}

async function nearLoginLinks(
  userId: number,
  { windowSeconds, loginSample }: NonNullable<LinkConfig['nearLogin']>
): Promise<Found> {
  const ch = getClickhouse();
  const mine = await ch.$query<{ ip: string; ts: number }>(`
    SELECT ip, toUnixTimestamp(time) AS ts
    FROM default.userActivities
    WHERE targetUserId = ${userId}
      AND type IN ('Login', 'Registration')
      AND ${PUBLIC_IP_ONLY}
    ORDER BY time DESC
    LIMIT ${loginSample}
  `);

  const byCluster = new Map<string, number[]>();
  for (const r of mine) {
    const key = ipCluster(r.ip);
    const ts = Number(r.ts);
    // `clusterSql` puts every mapped or unparseable IPv6 row in `::/64`; as a key it links to all of them.
    if (key && key !== '::/64' && Number.isInteger(ts))
      byCluster.set(key, [...(byCluster.get(key) ?? []), ts]);
  }
  if (!byCluster.size) return { links: [], truncated: false };

  const cluster = clusterSql('ip');
  // One time range per login keeps the read on the table's `time` sort key.
  const ranges = [...byCluster]
    .flatMap(([key, times]) =>
      times.map(
        (t) =>
          `(time BETWEEN toDateTime(${t - windowSeconds}) AND toDateTime(${
            t + windowSeconds
          }) AND ${cluster} = '${key}')`
      )
    )
    .join(' OR ');
  const ownTimes = `map(${[...byCluster]
    .map(([key, times]) => `'${key}', [${times.join(', ')}]`)
    .join(', ')})`;

  const rows = await ch.$query<{
    userId: number;
    ips: string[];
    addresses: number;
    closestSeconds: number;
    logins: number;
  }>(`
    SELECT targetUserId AS userId,
      groupUniqArray(10)(${cluster}) AS ips,
      uniqExact(${cluster}) AS addresses,
      min(arrayMin(arrayMap(x -> abs(x - toUnixTimestamp(time)), ${ownTimes}[${cluster}]))) AS closestSeconds,
      count() AS logins
    FROM default.userActivities
    WHERE (${ranges})
      AND type IN ('Login', 'Registration')
      AND targetUserId > 0
      AND targetUserId != ${userId}
    GROUP BY targetUserId
    ORDER BY closestSeconds, targetUserId
    LIMIT ${NEARBY_ACCOUNTS + 1}
  `);

  return {
    links: rows.slice(0, NEARBY_ACCOUNTS).map((r) => ({
      userId: Number(r.userId),
      nearLogin: {
        ips: r.ips,
        addresses: Number(r.addresses),
        closestSeconds: Number(r.closestSeconds),
        logins: Number(r.logins),
      },
    })),
    truncated: rows.length > NEARBY_ACCOUNTS,
  };
}

async function buzzLinks(
  userId: number,
  { lookbackDays }: NonNullable<LinkConfig['buzz']>
): Promise<Found> {
  const user = await dbRead
    .selectFrom('User')
    .select('createdAt')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return { links: [], truncated: false };

  // `buzzTransactions` sorts by date first and has no index on either account, so the date bound is
  // the whole cost control.
  const since = Math.max(
    Math.floor(new Date(user.createdAt).getTime() / 1000),
    Math.floor(Date.now() / 1000) - lookbackDays * 86_400
  );
  // Ranked over every counterparty, filtered after: `rank` is a position among all of them.
  const rows = await getClickhouse().$query<{
    other: number;
    rank: number;
    outCount: number;
    inCount: number;
    outAmount: number;
    inAmount: number;
  }>(`
    SELECT other, rank, outCount, inCount, outAmount, inAmount
    FROM (
      SELECT *, row_number() OVER (ORDER BY outCount + inCount DESC, other) AS rank
      FROM (
        SELECT if(fromAccountId = ${userId}, toAccountId, fromAccountId) AS other,
          countIf(fromAccountId = ${userId}) AS outCount,
          countIf(toAccountId = ${userId}) AS inCount,
          sumIf(amount, fromAccountId = ${userId}) AS outAmount,
          sumIf(amount, toAccountId = ${userId}) AS inAmount
        FROM default.buzzTransactions
        WHERE date >= toDateTime(${since})
          AND (fromAccountId = ${userId} OR toAccountId = ${userId})
          AND fromAccountType IN (${USER_ACCOUNT_TYPES_SQL})
          AND toAccountType IN (${USER_ACCOUNT_TYPES_SQL})
          AND fromAccountId > 0
          AND toAccountId > 0
          AND fromAccountId != toAccountId
        GROUP BY other
      )
    )
    WHERE outCount > 0 AND inCount > 0
    ORDER BY rank
    LIMIT ${BUZZ_COUNTERPARTIES + 1}
  `);

  return {
    links: rows.slice(0, BUZZ_COUNTERPARTIES).map((r) => ({
      userId: Number(r.other),
      buzz: {
        rank: Number(r.rank),
        inCount: Number(r.inCount),
        outCount: Number(r.outCount),
        inAmount: Number(r.inAmount),
        outAmount: Number(r.outAmount),
      },
    })),
    truncated: rows.length > BUZZ_COUNTERPARTIES,
  };
}

async function socialLinks(userId: number): Promise<Found> {
  const { rows, truncated } = await getSharedSocialRows(userId);
  return { links: rows.map((r) => ({ userId: r.userId, social: { url: r.url } })), truncated };
}

type Outcome = { status: SignalStatus; found: Found };
const NONE: Found = { links: [], truncated: false };

async function attempt(signal: LinkSignal, run: (() => Promise<Found>) | null): Promise<Outcome> {
  if (!run) return { status: 'off', found: NONE };
  try {
    return { status: 'ok', found: await run() };
  } catch (e) {
    console.error(`[linked-accounts] ${signal} unavailable`, e);
    return { status: 'failed', found: NONE };
  }
}

export async function getAccountLinks(
  userId: number,
  config = linkConfig()
): Promise<AccountLinks> {
  const { nearLogin, buzz } = config;
  const outcomes = await Promise.all([
    attempt('regIp', () => regIpLinks(userId)),
    attempt('nearLogin', nearLogin && (() => nearLoginLinks(userId, nearLogin))),
    attempt('buzz', buzz && (() => buzzLinks(userId, buzz))),
    attempt('social', () => socialLinks(userId)),
  ]);
  const by = Object.fromEntries(LINK_SIGNALS.map((s, i) => [s, outcomes[i]])) as Record<
    LinkSignal,
    Outcome
  >;

  const merged = new Map<number, Evidence>();
  for (const { found } of outcomes)
    for (const link of found.links)
      merged.set(link.userId, { ...merged.get(link.userId), ...link });

  const ids = [...merged.keys()];
  // Strikes are in a second store; if it fails, blank the counts (null), never show 0.
  const [users, strikes] = await Promise.all([
    usersByIds(ids),
    strikeCountsByUserIds(ids).catch((e) => {
      console.error('[linked-accounts] strike counts unavailable', e);
      return null;
    }),
  ]);
  const accounts: AccountLinkRow[] = [...merged.values()].map((e) => {
    const u = users.get(e.userId);
    return {
      ...e,
      username: u?.username ?? null,
      status: accountStatus(u),
      muted: u?.muted ?? null,
      strikes: strikes ? strikes.get(e.userId) ?? 0 : null,
    };
  });

  return {
    accounts: rankAccountLinks(accounts),
    status: Object.fromEntries(LINK_SIGNALS.map((s) => [s, by[s].status])) as Record<
      LinkSignal,
      SignalStatus
    >,
    truncated: Object.fromEntries(LINK_SIGNALS.map((s) => [s, by[s].found.truncated])) as Record<
      LinkSignal,
      boolean
    >,
  };
}
