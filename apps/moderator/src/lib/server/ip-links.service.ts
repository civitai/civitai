import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { CREATES_ONLY, daysWindow, OWN_ACTIVITY_ONLY, PUBLIC_IP_ONLY } from './clickhouse-filters';
import { clusterList, clusterMatchSql, clusterSql, ipCluster, isClusterKey } from './ip-clusters';
import { accountStatus, isInt4Id, usersByIds, type AccountStatus } from './users.service';
import { strikeCountsByUserIds } from './moderation-memory.service';

// Accounts tied together by the addresses they log in AND react from.
//
// `/api/shared-ip-accounts` and Reactor Lookup read `userActivities` only (logins, registrations,
// subscriptions). This file adds `reactions.ip` beside it.
//
// Totals are exact; the list pages over at most `PEER_SCAN` accounts per source (see `truncated`).

export type LinkSource = 'login' | 'reaction';

/** Reactions older than this are not searched; the login read has no window. */
export const MAX_REACTION_DAYS = 365;
export const DEFAULT_REACTION_DAYS = 180;

// 🔴 Every `reactions` read names its selective column in PREWHERE. Left to WHERE, ClickHouse reads
// `userId` and `time` for the whole window before applying the address match.

/** Raw peer rows read per source before the merge. Far above any page so ordering decides the page. */
const PEER_SCAN = 5_000;
/** Own addresses read per source, newest first. */
const OWN_ADDRESSES = 300;

const reactionWindow = (days: number) => daysWindow(days, { max: MAX_REACTION_DAYS });

export type OwnAddress = { cluster: string; ips: string[]; last: string; source: LinkSource };

/** The addresses an account logged in or reacted from, grouped into clusters. */
export async function getOwnAddresses(userId: number, days: number): Promise<OwnAddress[]> {
  if (!isInt4Id(userId)) return [];
  const ch = getClickhouse();
  const [logins, reactions] = await Promise.all([
    ch.$query<{ ip: string; last: string }>(`
      SELECT ip, max(time) AS last
      FROM default.userActivities
      WHERE targetUserId = ${userId} AND ${PUBLIC_IP_ONLY} AND ${OWN_ACTIVITY_ONLY}
      GROUP BY ip ORDER BY last DESC LIMIT ${OWN_ADDRESSES}
    `),
    ch.$query<{ ip: string; last: string }>(`
      SELECT ip, max(time) AS last
      FROM default.reactions
      PREWHERE userId = ${userId}
      WHERE ${reactionWindow(days)} AND ${PUBLIC_IP_ONLY}
      GROUP BY ip ORDER BY last DESC LIMIT ${OWN_ADDRESSES}
    `),
  ]);
  return [...groupByCluster(logins, 'login'), ...groupByCluster(reactions, 'reaction')];
}

function groupByCluster(rows: { ip: string; last: string }[], source: LinkSource): OwnAddress[] {
  const out = new Map<string, OwnAddress>();
  for (const row of rows) {
    const cluster = ipCluster(row.ip);
    if (!cluster) continue;
    const entry = out.get(cluster) ?? { cluster, ips: [], last: clickhouseDate(row.last), source };
    entry.ips.push(row.ip);
    out.set(cluster, entry);
  }
  return [...out.values()];
}

type PeerRow = { userId: number; clusters: string[]; last: string };

/** Everyone seen on `clusters` in one source, with how many accounts each cluster carries. */
async function peersOn(
  source: LinkSource,
  clusters: string[],
  { days, exclude }: { days: number; exclude: number[] }
): Promise<{ rows: PeerRow[]; total: number; breadth: Map<string, number> }> {
  const match = clusterMatchSql(clusters);
  const list = clusterList(clusters);
  if (!match || !list) return { rows: [], total: 0, breadth: new Map() };

  const excluded = exclude.filter(isInt4Id);
  const inner =
    source === 'login'
      ? `SELECT targetUserId AS uid, ${clusterSql()} AS cluster, max(time) AS last
         FROM default.userActivities
         WHERE ${match} AND targetUserId > 0 AND ${OWN_ACTIVITY_ONLY}
         GROUP BY uid, cluster`
      : `SELECT userId AS uid, ${clusterSql()} AS cluster, max(time) AS last
         FROM default.reactions
         PREWHERE ${match}
         WHERE ${reactionWindow(days)} AND userId > 0 AND ${CREATES_ONLY}
         GROUP BY uid, cluster`;

  const ch = getClickhouse();
  const [peers, breadth] = await Promise.all([
    ch.$query<{ uid: string; clusters: string[]; last: string; total: string }>(`
      SELECT uid, clusters, shared, last, count() OVER () AS total
      FROM (
        SELECT uid, groupUniqArray(50)(cluster) AS clusters, uniq(cluster) AS shared, max(last) AS last
        FROM (${inner})
        WHERE cluster IN (${list})
          ${excluded.length ? `AND uid NOT IN (${excluded.join(',')})` : ''}
        GROUP BY uid
      )
      ORDER BY shared DESC, last DESC
      LIMIT ${PEER_SCAN}
    `),
    // Breadth counts EVERY account on the cluster, the subject included: "2 accounts" must mean the
    // subject and one other, not the other alone.
    ch.$query<{ cluster: string; accounts: string }>(`
      SELECT cluster, uniqExact(uid) AS accounts
      FROM (${inner})
      WHERE cluster IN (${list})
      GROUP BY cluster
    `),
  ]);

  return {
    rows: peers.map((p) => ({
      userId: Number(p.uid),
      clusters: p.clusters,
      last: clickhouseDate(p.last),
    })),
    total: Number(peers[0]?.total ?? 0),
    breadth: new Map(breadth.map((b) => [b.cluster, Number(b.accounts)])),
  };
}

export type LinkedAccountRow = {
  userId: number;
  username: string | null;
  status: AccountStatus;
  muted: boolean;
  strikes: number;
  login: string[];
  reaction: string[];
  /** Accounts on the narrowest shared cluster, the subject included. Rows sort narrowest first. */
  narrowest: number;
  last: string;
};

export type ClusterBreadth = { cluster: string; source: LinkSource; accounts: number };

export type LinkedAccounts = {
  days: number;
  addresses: ClusterBreadth[];
  /** Exact distinct accounts per source, before paging. */
  totals: { login: number; reaction: number };
  /** Rows in this page, after `offset`. */
  accounts: LinkedAccountRow[];
  /** Distinct accounts the merged list holds; a lower bound when `truncated`. */
  matched: number;
  /** A source returned more accounts than `PEER_SCAN`: the list is the best-linked slice of them. */
  truncated: boolean;
};

export async function getLinkedAccounts(
  userId: number,
  { days = DEFAULT_REACTION_DAYS, limit = 50, offset = 0 } = {}
): Promise<LinkedAccounts> {
  const own = await getOwnAddresses(userId, days);
  return linkAccounts(own, { days, limit, offset, exclude: [userId] });
}

/** Everyone on one address, for "who else is on this IP". */
export async function getAccountsOnAddress(
  address: string,
  options: { days?: number; limit?: number; offset?: number } = {}
): Promise<LinkedAccounts | null> {
  const { linked } = await getAccountsOnAddresses([address], options);
  return linked;
}

/**
 * Every account seen on any of these addresses, in one list: an account on several of them appears
 * once, with each address it was seen on. `invalid` names what was not an IP address; `linked` is null
 * when nothing was.
 */
export async function getAccountsOnAddresses(
  addresses: string[],
  { days = DEFAULT_REACTION_DAYS, limit = 100, offset = 0 } = {}
): Promise<{ linked: LinkedAccounts | null; invalid: string[] }> {
  const own: OwnAddress[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const cluster = isClusterKey(address) ? address : ipCluster(address);
    if (!cluster) {
      invalid.push(address);
      continue;
    }
    if (seen.has(`${cluster} ${address}`)) continue;
    seen.add(`${cluster} ${address}`);
    for (const source of ['login', 'reaction'] as const)
      own.push({ cluster, ips: cluster === address ? [] : [address], last: '', source });
  }
  if (!own.length) return { linked: null, invalid };
  return { linked: await linkAccounts(own, { days, limit, offset, exclude: [] }), invalid };
}

async function linkAccounts(
  own: OwnAddress[],
  {
    days,
    limit,
    offset,
    exclude,
  }: { days: number; limit: number; offset: number; exclude: number[] }
): Promise<LinkedAccounts> {
  // Both tables are searched for the UNION of both address sets: an alt can log in from the address
  // the subject only ever reacted from, and that crossing is what neither list alone can show.
  const clusters = [...new Set(own.map((a) => a.cluster))];
  const [l, r] = await Promise.all([
    peersOn('login', clusters, { days, exclude }),
    peersOn('reaction', clusters, { days, exclude }),
  ]);

  const width = (cluster: string) =>
    Math.max(l.breadth.get(cluster) ?? 0, r.breadth.get(cluster) ?? 0);

  const merged = new Map<number, { login: string[]; reaction: string[]; last: string }>();
  for (const [source, rows] of [
    ['login', l.rows],
    ['reaction', r.rows],
  ] as const) {
    for (const row of rows) {
      const entry = merged.get(row.userId) ?? { login: [], reaction: [], last: row.last };
      entry[source] = row.clusters;
      if (row.last > entry.last) entry.last = row.last;
      merged.set(row.userId, entry);
    }
  }

  const ranked = [...merged.entries()]
    .map(([userId, e]) => ({
      userId,
      ...e,
      narrowest: Math.min(...[...e.login, ...e.reaction].map(width)),
    }))
    .sort(
      (a, b) =>
        a.narrowest - b.narrowest ||
        b.login.length + b.reaction.length - (a.login.length + a.reaction.length) ||
        (a.last < b.last ? 1 : -1)
    );

  const page = ranked.slice(offset, offset + limit);
  const ids = page.map((p) => p.userId);
  const [byId, strikes] = await Promise.all([usersByIds(ids), strikeCountsByUserIds(ids)]);

  return {
    days,
    addresses: clusters.flatMap((cluster) =>
      (['login', 'reaction'] as const).map((source) => ({
        cluster,
        source,
        accounts: (source === 'login' ? l : r).breadth.get(cluster) ?? 0,
      }))
    ),
    totals: { login: l.total, reaction: r.total },
    matched: ranked.length,
    truncated: l.total > PEER_SCAN || r.total > PEER_SCAN,
    accounts: page.map((p) => {
      const user = byId.get(p.userId);
      return {
        userId: p.userId,
        username: user?.username ?? null,
        status: accountStatus(user),
        muted: !!user?.muted,
        strikes: strikes.get(p.userId) ?? 0,
        login: p.login,
        reaction: p.reaction,
        narrowest: p.narrowest,
        last: p.last,
      };
    }),
  };
}

export type SharedCluster = {
  cluster: string;
  source: LinkSource;
  /** Members of the asked-about set seen on it. */
  members: number[];
  /** Every account seen on it in the window, set members included. */
  accounts: number;
};

export type SetLinks = {
  days: number;
  clusters: SharedCluster[];
  /** The set split into groups connected through shared clusters. `viaLoginToo` is false for a group
   *  joined only by reaction addresses. */
  groups: { members: number[]; viaLoginToo: boolean }[];
  /** Set members sharing no cluster with any other member. */
  unlinked: number[];
};

const SET_CLUSTERS = 1_000;

/**
 * For a list of accounts a moderator already suspects, the addresses two or more of them share — by
 * reaction and by login — and the groups those addresses join them into.
 */
export async function getSetLinks(
  userIds: number[],
  days = DEFAULT_REACTION_DAYS
): Promise<SetLinks> {
  const ids = [...new Set(userIds)].filter(isInt4Id);
  if (ids.length < 2) return { days, clusters: [], groups: [], unlinked: ids };
  const set = ids.join(',');

  const ch = getClickhouse();
  const [reactionRows, loginRows] = await Promise.all([
    ch.$query<{ cluster: string; members: string[] }>(`
      SELECT cluster, groupUniqArray(userId) AS members
      FROM (
        SELECT userId, ${clusterSql()} AS cluster
        FROM default.reactions
        PREWHERE userId IN (${set})
        WHERE ${reactionWindow(days)} AND ${PUBLIC_IP_ONLY}
      )
      GROUP BY cluster HAVING uniq(userId) > 1
      ORDER BY uniq(userId) DESC LIMIT ${SET_CLUSTERS}
    `),
    ch.$query<{ cluster: string; members: string[] }>(`
      SELECT cluster, groupUniqArray(targetUserId) AS members
      FROM (
        SELECT targetUserId, ${clusterSql()} AS cluster
        FROM default.userActivities
        WHERE targetUserId IN (${set}) AND ${PUBLIC_IP_ONLY} AND ${OWN_ACTIVITY_ONLY}
      )
      GROUP BY cluster HAVING uniq(targetUserId) > 1
      ORDER BY uniq(targetUserId) DESC LIMIT ${SET_CLUSTERS}
    `),
  ]);

  const shared: SharedCluster[] = [
    ...reactionRows.map((r) => ({
      cluster: r.cluster,
      source: 'reaction' as const,
      members: r.members.map(Number),
      accounts: 0,
    })),
    ...loginRows.map((r) => ({
      cluster: r.cluster,
      source: 'login' as const,
      members: r.members.map(Number),
      accounts: 0,
    })),
  ].filter((c) => isClusterKey(c.cluster));

  const breadth = await clusterBreadth(
    shared.map((c) => c.cluster),
    days
  );
  for (const c of shared) c.accounts = breadth[c.source].get(c.cluster) ?? c.members.length;

  const groups = connect(ids, shared);
  return {
    days,
    clusters: shared.sort((a, b) => b.members.length - a.members.length || a.accounts - b.accounts),
    groups: groups.filter((g) => g.members.length > 1),
    unlinked: groups.filter((g) => g.members.length === 1).flatMap((g) => g.members),
  };
}

async function clusterBreadth(
  clusters: string[],
  days: number
): Promise<Record<LinkSource, Map<string, number>>> {
  const unique = [...new Set(clusters)];
  const match = clusterMatchSql(unique);
  const list = clusterList(unique);
  if (!match || !list) return { login: new Map(), reaction: new Map() };
  const ch = getClickhouse();
  const [login, reaction] = await Promise.all([
    ch.$query<{ cluster: string; accounts: string }>(`
      SELECT cluster, uniqExact(targetUserId) AS accounts
      FROM (SELECT targetUserId, ${clusterSql()} AS cluster FROM default.userActivities
            WHERE ${match} AND targetUserId > 0 AND ${OWN_ACTIVITY_ONLY})
      WHERE cluster IN (${list}) GROUP BY cluster
    `),
    ch.$query<{ cluster: string; accounts: string }>(`
      SELECT cluster, uniqExact(userId) AS accounts
      FROM (SELECT userId, ${clusterSql()} AS cluster FROM default.reactions
            PREWHERE ${match} WHERE ${reactionWindow(days)} AND userId > 0)
      WHERE cluster IN (${list}) GROUP BY cluster
    `),
  ]);
  const toMap = (rows: { cluster: string; accounts: string }[]) =>
    new Map(rows.map((r) => [r.cluster, Number(r.accounts)]));
  return { login: toMap(login), reaction: toMap(reaction) };
}

/** Union-find over the set, joined by every shared cluster. */
export function connect(
  ids: number[],
  shared: Pick<SharedCluster, 'members' | 'source'>[]
): { members: number[]; viaLoginToo: boolean }[] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: number): number => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  for (const c of shared) {
    const [first, ...rest] = c.members.filter((m) => parent.has(m));
    for (const m of rest) parent.set(find(m), find(first));
  }
  const groups = new Map<number, number[]>();
  for (const id of ids) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);

  return [...groups.values()]
    .map((members) => {
      const inGroup = new Set(members);
      return {
        members: members.sort((a, b) => a - b),
        viaLoginToo: shared.some(
          (c) => c.source === 'login' && c.members.filter((m) => inGroup.has(m)).length > 1
        ),
      };
    })
    .sort((a, b) => b.members.length - a.members.length);
}

export type ReactionBreadth = {
  days: number;
  reactions: number;
  reactors: number;
  /** Share of all reactions given by the most active 10 / 20 reactors, 0..1. */
  top10Share: number;
  top20Share: number;
  top: { userId: number; reactions: number }[];
};

/**
 * Who an account's reactions come from, as a spread: totals plus the top reactors' shares.
 *
 * `ownerId` is not in the sort key, so this reads the whole window and costs in proportion to `days`
 * (see `getReactors` in `reactor-lookup.service.ts`).
 */
export async function getReactionBreadth(userId: number, days = 90): Promise<ReactionBreadth> {
  const window = reactionWindow(days);
  const rows = await getClickhouse().$query<{
    reactions: string;
    reactors: string;
    top: [string, string][];
  }>(`
    SELECT sum(c) AS reactions, count() AS reactors,
           arraySlice(arrayReverseSort(x -> x.1, groupArray((c, userId))), 1, 20) AS top
    FROM (
      SELECT userId, count() AS c
      FROM default.reactions
      PREWHERE ownerId = ${userId}
      WHERE ${window} AND ${CREATES_ONLY} AND userId > 0 AND userId != ${userId}
      GROUP BY userId
    )
  `);
  const row = rows[0];
  const reactions = Number(row?.reactions ?? 0);
  const top = (row?.top ?? []).map(([c, id]) => ({ userId: Number(id), reactions: Number(c) }));
  const share = (n: number) =>
    reactions ? top.slice(0, n).reduce((s, t) => s + t.reactions, 0) / reactions : 0;
  return {
    days,
    reactions,
    reactors: Number(row?.reactors ?? 0),
    top10Share: share(10),
    top20Share: share(20),
    top: top.slice(0, 10),
  };
}

/**
 * Labels (`address 1`, `address 2`, …) for a viewer who could not read addresses in User Lookup, stable
 * within one masker: pass one across calls to keep them consistent. Labels, not blanks: "share address
 * 3, which carries 2 accounts" is still the finding.
 */
export function addressMasker(): (cluster: string) => string {
  const labels = new Map<string, string>();
  return (cluster) => {
    let value = labels.get(cluster);
    if (!value) {
      value = `address ${labels.size + 1}`;
      labels.set(cluster, value);
    }
    return value;
  };
}

export function maskLinkedAddresses(
  linked: LinkedAccounts,
  mask: (cluster: string) => string = addressMasker()
): LinkedAccounts {
  return {
    ...linked,
    addresses: linked.addresses.map((a) => ({ ...a, cluster: mask(a.cluster) })),
    accounts: linked.accounts.map((a) => ({
      ...a,
      login: a.login.map(mask),
      reaction: a.reaction.map(mask),
    })),
  };
}
