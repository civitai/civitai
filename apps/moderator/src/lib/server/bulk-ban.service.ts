import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';

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

export type IpAccount = { userId: number; registeredAt: string | null };

/**
 * Retool's `UsersByIp` — the step that grows a list from one account to a ring. Capped: an IP behind a
 * carrier NAT can carry thousands of unrelated registrations, and a moderator must not be handed that
 * as a ban list.
 */
export async function getAccountsOnIps(ips: string[], limit = 500): Promise<IpAccount[]> {
  if (!ips.length) return [];
  const escaped = ips.map((ip) => `'${ip.replace(/'/g, "''")}'`).join(',');
  const rows = await getClickhouse().$query<{ targetUserId: string; time: string }>(`
    SELECT targetUserId, min(time) AS time
    FROM default.userActivities
    WHERE ip IN (${escaped})
      AND type = 'Registration'
    GROUP BY targetUserId
    ORDER BY targetUserId
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    userId: Number(r.targetUserId),
    registeredAt: r.time ? clickhouseDate(r.time) : null,
  }));
}
