import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { usersByIds } from './users.service';
import { strikeCountsByUserIds } from './moderation-memory.service';
import { INTERNAL_IP_RANGE, IP_PATTERN } from './clickhouse-filters';
import { getSharedIpRows, getSharedSocialAccounts } from './user-signals.service';
import { linkConfig, type LinkConfig } from './linked-accounts-config';
import {
  LINK_SIGNALS,
  nearestGapSeconds,
  rankLinkedAccounts,
  type LinkSignal,
  type LinkedAccountRow,
  type SignalStatus,
} from '$lib/linked-accounts';

// Everything behind `/api/linked-accounts`: other accounts tied to this one, one row per account with
// each kind of evidence beside it.
//
// The ClickHouse helper interpolates values with NO escaping, so only numbers we control and IPs
// matched against IP_PATTERN are ever put into a query. Times cross as unix seconds for that reason.

type Evidence = Omit<LinkedAccountRow<Date>, 'username' | 'bannedAt' | 'muted' | 'strikes'>;
type Found = { links: Evidence[]; truncated: boolean };

const NEIGHBOUR_ROWS = 500;
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
  const mine = (
    await ch.$query<{ ip: string; ts: string }>(`
      SELECT ip, toUnixTimestamp(time) AS ts
      FROM default.userActivities
      WHERE targetUserId = ${userId}
        AND type IN ('Login', 'Registration')
        AND NOT isIPAddressInRange(ip, '${INTERNAL_IP_RANGE}')
      ORDER BY time DESC
      LIMIT ${loginSample}
    `)
  )
    .filter((r) => IP_PATTERN.test(r.ip))
    .map((r) => ({ ip: r.ip, ts: Number(r.ts) }));
  if (!mine.length) return { links: [], truncated: false };

  const byIp = new Map<string, number[]>();
  for (const r of mine) byIp.set(r.ip, [...(byIp.get(r.ip) ?? []), r.ts]);

  // One time range per login keeps this on the table's `time` sort key; matching on IP alone reads
  // every row a shared carrier address ever produced.
  const ranges = mine
    .map(
      (r) =>
        `(ip = '${r.ip}' AND time BETWEEN toDateTime(${r.ts - windowSeconds}) AND toDateTime(${
          r.ts + windowSeconds
        }))`
    )
    .join(' OR ');
  const rows = await ch.$query<{ userId: string; ip: string; ts: string }>(`
    SELECT targetUserId AS userId, ip, toUnixTimestamp(time) AS ts
    FROM default.userActivities
    WHERE ip IN (${[...byIp.keys()].map((ip) => `'${ip}'`).join(', ')})
      AND (${ranges})
      AND type IN ('Login', 'Registration')
      AND targetUserId > 0
      AND targetUserId != ${userId}
    LIMIT ${NEIGHBOUR_ROWS + 1}
  `);

  const links = new Map<number, { ips: Set<string>; closestSeconds: number; logins: number }>();
  for (const r of rows.slice(0, NEIGHBOUR_ROWS)) {
    const id = Number(r.userId);
    const gap = nearestGapSeconds(byIp.get(r.ip) ?? [], Number(r.ts));
    const link = links.get(id) ?? { ips: new Set(), closestSeconds: Infinity, logins: 0 };
    link.ips.add(r.ip);
    link.closestSeconds = Math.min(link.closestSeconds, gap);
    link.logins += 1;
    links.set(id, link);
  }
  return {
    links: [...links].map(([id, l]) => ({
      userId: id,
      nearLogin: { ips: [...l.ips], closestSeconds: l.closestSeconds, logins: l.logins },
    })),
    truncated: rows.length > NEIGHBOUR_ROWS,
  };
}

// Only counterparties Buzz moved to AND from count as a link: one-way tipping is what fans do.
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
  // the whole cost control. An account cannot have moved Buzz before it existed.
  const since = Math.max(
    Math.floor(new Date(user.createdAt).getTime() / 1000),
    Math.floor(Date.now() / 1000) - lookbackDays * 86_400
  );
  const rows = await getClickhouse().$query<{
    other: string;
    outCount: string;
    inCount: string;
    outAmount: string;
    inAmount: string;
  }>(`
    SELECT if(fromAccountId = ${userId}, toAccountId, fromAccountId) AS other,
      countIf(fromAccountId = ${userId}) AS outCount,
      countIf(toAccountId = ${userId}) AS inCount,
      sumIf(amount, fromAccountId = ${userId}) AS outAmount,
      sumIf(amount, toAccountId = ${userId}) AS inAmount
    FROM default.buzzTransactions
    WHERE date >= toDateTime(${since})
      AND (fromAccountId = ${userId} OR toAccountId = ${userId})
      AND fromAccountId > 0
      AND toAccountId > 0
      AND fromAccountId != toAccountId
    GROUP BY other
    ORDER BY outCount + inCount DESC, other
    LIMIT ${BUZZ_COUNTERPARTIES}
  `);

  return {
    links: rows.flatMap((r, i) => {
      const buzz = {
        rank: i + 1,
        inCount: Number(r.inCount),
        outCount: Number(r.outCount),
        inAmount: Number(r.inAmount),
        outAmount: Number(r.outAmount),
      };
      return buzz.inCount && buzz.outCount ? [{ userId: Number(r.other), buzz }] : [];
    }),
    truncated: rows.length === BUZZ_COUNTERPARTIES,
  };
}

async function socialLinks(userId: number): Promise<Found> {
  const { accounts, truncated } = await getSharedSocialAccounts(userId);
  return { links: accounts.map((a) => ({ userId: a.userId, social: { url: a.url } })), truncated };
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

export async function getLinkedAccounts(userId: number, config = linkConfig()) {
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
  // Strikes live in a second database. Losing it must blank the counts, not the whole list, and must
  // not read as zero.
  const [users, strikes] = await Promise.all([
    usersByIds(ids),
    strikeCountsByUserIds(ids).catch((e) => {
      console.error('[linked-accounts] strike counts unavailable', e);
      return null;
    }),
  ]);
  const accounts: LinkedAccountRow<Date>[] = [...merged.values()].map((e) => {
    const u = users.get(e.userId);
    return {
      ...e,
      username: u?.username ?? null,
      bannedAt: u?.bannedAt ?? null,
      muted: u?.muted ?? null,
      strikes: strikes ? strikes.get(e.userId) ?? 0 : null,
    };
  });

  return {
    accounts: rankLinkedAccounts(accounts),
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
