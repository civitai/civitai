import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { usersByIds } from './users.service';

// Retool's Bulk Ban. Two halves: a preflight + ban loop, and the ban-evasion queries that build the
// list in the first place (registration IPs, email-domain clustering, accounts sharing an IP).
//
// Retool's investigation queries carried hardcoded account ids, one email domain and four IPs — a saved
// scratchpad from a past case. Ported as shapes with inputs; re-running someone else's investigation by
// default would be worse than not having them.

export type BanCandidate = {
  id: number;
  username: string | null;
  email: string | null;
  bannedAt: Date | null;
  deletedAt: Date | null;
};

/**
 * Retool's `ListUsers` + `getEmails` + `query16` as one preflight. `bannedAt`/`deletedAt` come back
 * rather than being filtered out: "3 of these 40 are already banned" is what the moderator needs to
 * see BEFORE pressing the button, and Retool's version silently dropped them.
 */
export async function getBanCandidates(ids: number[]): Promise<BanCandidate[]> {
  if (!ids.length) return [];
  return dbRead
    .selectFrom('User')
    .select(['id', 'username', 'email', 'bannedAt', 'deletedAt'])
    .where('id', 'in', ids)
    .orderBy('id')
    .execute() as Promise<BanCandidate[]>;
}

/** Retool's `query12`: the same list keyed by username, which is the other way a list arrives. */
export async function resolveUsernamesToIds(usernames: string[]): Promise<number[]> {
  if (!usernames.length) return [];
  const rows = await dbRead
    .selectFrom('User')
    .select('id')
    .where('username', 'in', usernames)
    .execute();
  return rows.map((r) => r.id);
}

export type IpCluster = { ip: string; registrations: number };

/**
 * Retool's `GetIP`. Registration events only: a shared *login* IP is weak evidence (mobile carriers,
 * offices), while a shared *registration* IP across many accounts is the ban-evasion signal.
 */
export async function getRegistrationIps(userIds: number[]): Promise<IpCluster[]> {
  if (!userIds.length) return [];
  const rows = await getClickhouse().$query<{ ip: string; registrations: string }>(`
    SELECT ip, COUNT(*) AS registrations
    FROM default.userActivities
    WHERE targetUserId IN (${userIds.join(',')})
      AND type = 'Registration'
    GROUP BY ip
    ORDER BY registrations DESC
    LIMIT 100
  `);
  return rows.map((r) => ({ ip: r.ip, registrations: Number(r.registrations) }));
}

export type DomainCluster = { domain: string; accounts: number };

/** Retool's `GetEmail`: a disposable-domain ring shows up as one domain with a high count. */
export async function getEmailDomains(userIds: number[]): Promise<DomainCluster[]> {
  if (!userIds.length) return [];
  const rows = await dbRead
    .selectFrom('User')
    .select([
      sql<string>`substring(email from '@(.+)$')`.as('domain'),
      sql<string>`count(*)`.as('accounts'),
    ])
    .where('id', 'in', userIds)
    .groupBy(sql`substring(email from '@(.+)$')`)
    .orderBy(sql`count(*) desc`)
    .execute();
  return rows
    .filter((r) => r.domain)
    .map((r) => ({ domain: r.domain, accounts: Number(r.accounts) }));
}

export type DomainAccount = { id: number; username: string | null; email: string | null };

/** As on `IpAccounts`: the count the panel shows must be the domains' own, not the page size. */
export type DomainAccounts = { accounts: DomainAccount[]; total: number };

/**
 * Retool's `query15` — the domain twin of `getAccountsOnIps`, and the reason `getEmailDomains` is not
 * enough on its own: that one is scoped to the ids already pasted, so it can only ever COUNT a ring,
 * never grow one. This takes a domain and returns accounts not yet on the list.
 *
 * Already-banned accounts are excluded, matching Retool — the output is a candidate list, not a census.
 * That is the deliberate difference from `getAccountsOnIps`, which marks them instead: this one grows a
 * list to act on, that one is also read to see whether a ring has been actioned before.
 *
 * The domain expression and both null checks are matched character-for-character by
 * `User_email_domain_idx`; reword any of the three and this seq-scans `User` again.
 */
export async function getAccountsOnDomains(
  domains: string[],
  limit = 500
): Promise<DomainAccounts> {
  const cleaned = domains.map((d) => d.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  if (!cleaned.length) return { accounts: [], total: 0 };

  // Both queries must carry the same three predicates verbatim, or the count describes a different
  // set from the list — and the index stops covering whichever one drifted.
  const scoped = dbRead
    .selectFrom('User')
    .where(sql<string>`lower(substring(email from '@(.+)$'))`, 'in', cleaned)
    .where('bannedAt', 'is', null)
    .where('deletedAt', 'is', null);

  const [accounts, totals] = await Promise.all([
    scoped
      .select(['id', 'username', 'email'])
      // Newest first, for the reason spelled out on `getAccountsOnIps`: ids ascend with age, so
      // `orderBy('id')` spent the cap on the oldest accounts a disposable domain ever registered.
      .orderBy('id', 'desc')
      .limit(limit)
      .execute(),
    scoped.select(({ fn }) => fn.countAll<string>().as('total')).executeTakeFirst(),
  ]);

  return { accounts, total: Number(totals?.total ?? 0) };
}

export type Tipper = { userId: number; tips: number; total: number };

/**
 * Retool's `GetUsers`, and the only query in that export that ORIGINATES a ban list rather than
 * annotating one: given accounts that received suspicious tips, who paid them. A farm shows up as a
 * wall of young accounts each tipping the same handful of recipients.
 *
 * Retool hardcoded its five recipients, a 50 floor and `fromAccountId > 5400000` — that last one is a
 * "recently created" proxy, since account ids ascend. All three are inputs here; the id floor is what
 * separates a farm from a popular creator's genuine supporters.
 *
 * `buzzTransactions` is 1.5B rows sorted by date, so a recipient filter alone scans it. Retool accepted
 * that and ran unbounded; `days = 0` keeps that default rather than silently narrowing what a moderator
 * sees, and the caller can bound it to prune partitions when the window is known.
 */
export async function getTippersTo(
  recipientIds: number[],
  { minAmount = 50, minAccountId = 0, days = 0, limit = 500 } = {}
): Promise<Tipper[]> {
  const ids = recipientIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];

  const bound =
    Number.isInteger(days) && days > 0 ? `AND date >= now() - INTERVAL ${days} DAY` : '';
  const rows = await getClickhouse().$query<{
    fromAccountId: string;
    tips: string;
    total: string;
  }>(`
    SELECT fromAccountId, count() AS tips, sum(amount) AS total
    FROM default.buzzTransactions
    WHERE toAccountId IN (${ids.join(',')})
      AND type = 'tip'
      AND amount >= ${Number(minAmount) || 0}
      AND fromAccountId > ${Number(minAccountId) || 0}
      ${bound}
    GROUP BY fromAccountId
    ORDER BY total DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    userId: Number(r.fromAccountId),
    tips: Number(r.tips),
    total: Number(r.total),
  }));
}

export type IpAccount = {
  userId: number;
  registeredAt: string | null;
  username: string | null;
  /** `gone` is an id ClickHouse still holds a registration for and Postgres has no account for.
   *  Only `active` can be banned, and the panel adds only those to the list. */
  status: 'active' | 'banned' | 'deleted' | 'gone';
};

/** `total` is what the IPs actually carry, which `accounts.length` cannot say once the cap bites;
 *  `offset` is where this page starts, so the panel can walk past it. */
export type IpAccounts = { accounts: IpAccount[]; total: number; offset: number; limit: number };

/**
 * Retool's `UsersByIp` — the step that grows a list from one account to a ring. Capped: an IP behind a
 * carrier NAT can carry thousands of unrelated registrations, and a moderator must not be handed that
 * as a ban list.
 *
 * 🔴 **Newest first, and the cap is reported rather than hidden.** This ordered by `targetUserId`,
 * which ascends with age — so the cap kept the OLDEST registrations and dropped everything newer, on
 * a list whose entire purpose is a ring that is still registering accounts. On one reported IP that
 * meant 500 of 908 shown, the visible half ending sixteen months before the newest registration.
 * `total` exists so the panel can say "500 of 908" instead of deriving a count from `.length` and
 * stating the cap as the answer.
 *
 * Already-banned accounts are MARKED, not filtered. Filtering would make the list drain as it is
 * worked — but it would also hide that a ring has been actioned before, which is what a moderator
 * reads it for.
 *
 * 🔴 **Marking is why this PAGES.** Filtering is what would otherwise make the cap survivable: ban
 * the visible rows, re-run, get the next ones. Marking removes that, so without an offset the same
 * 500 rows come back forever and the rest of the ring is unreachable by any sequence of actions —
 * the reported bug, merely relocated. The two decisions are a pair; do not keep the marking and
 * drop the paging.
 *
 * `targetUserId` is the ORDER's tiebreaker, not decoration: bot registrations share a timestamp to
 * the second, and an unstable sort silently repeats and skips rows across pages.
 */
export async function getAccountsOnIps(
  ips: string[],
  { limit = 500, offset = 0 }: { limit?: number; offset?: number } = {}
): Promise<IpAccounts> {
  if (!ips.length) return { accounts: [], total: 0, offset: 0, limit };
  const escaped = ips.map((ip) => `'${ip.replace(/'/g, "''")}'`).join(',');
  const where = `WHERE ip IN (${escaped}) AND type = 'Registration'`;

  const [rows, totals] = await Promise.all([
    getClickhouse().$query<{ targetUserId: string; time: string }>(`
      SELECT targetUserId, min(time) AS time
      FROM default.userActivities
      ${where}
      GROUP BY targetUserId
      ORDER BY time DESC, targetUserId DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
    getClickhouse().$query<{ total: string }>(`
      SELECT uniqExact(targetUserId) AS total FROM default.userActivities ${where}
    `),
  ]);

  const byId = await usersByIds(rows.map((r) => Number(r.targetUserId)));
  return {
    accounts: rows.map((r) => {
      const userId = Number(r.targetUserId);
      const user = byId.get(userId);
      return {
        userId,
        registeredAt: r.time ? clickhouseDate(r.time) : null,
        username: user?.username ?? null,
        status: !user
          ? ('gone' as const)
          : user.bannedAt
          ? ('banned' as const)
          : user.deletedAt
          ? ('deleted' as const)
          : ('active' as const),
      };
    }),
    total: Number(totals[0]?.total ?? 0),
    offset,
    limit,
  };
}
