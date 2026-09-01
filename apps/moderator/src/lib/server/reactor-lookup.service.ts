import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { INTERNAL_IP_RANGE, IP_PATTERN } from './clickhouse-filters';
import { isInt4Id, usersByIds } from './users.service';
import { strikeCountsByUserIds } from './moderation-memory.service';

// Given a creator, the accounts pushing engagement at them, plus the addresses those accounts share.
//
// 🔴 `concentration` — an actor's share of their OWN activity landing on this target — is the product
// here, not a column on it. Raw count does not separate a ring from an audience: measured on
// eileen33bits, the confirmed sock sat sixth by count among thirteen accounts in one 380-410 band, and
// nothing but "100%, one creator" told them apart.

export type Category = 'reactions' | 'stickers' | 'collections';

export type Actor = {
  userId: number;
  username: string | null;
  /** Events aimed at the target inside the window. */
  count: number;
  /** Distinct pieces of the target's content touched — 400 reactions across 8 images is a different
   *  shape from 400 across 400, and only one of them is plausible browsing. */
  entities: number;
  /** The same actor's events aimed at ANYONE in the window; `null` when the category has no
   *  affordable denominator, in which case `concentration` is null too rather than 1. */
  totalGiven: number | null;
  /** Distinct creators they aimed at. `1` beside a high count is the signal. */
  owners: number | null;
  /** `count / totalGiven`, 0..1. */
  concentration: number | null;
  status: 'active' | 'banned' | 'deleted' | 'gone';
  strikes: number;
  createdAt: Date | null;
  /**
   * Email verified within `INSTANT_VERIFY_SECONDS` of signup — a human opening a mail client does not
   * do that. Null when either timestamp is missing, which is not the same as false.
   */
  instantVerify: boolean | null;
};

/** Fast enough that no person is in the loop. Two minutes would still be suspicious and would also
 *  catch a genuinely quick human; this is deliberately at the end where only automation lives. */
const INSTANT_VERIFY_SECONDS = 120;

const DELETE_TYPES = [
  'Image_Delete',
  'Comment_Delete',
  'CommentV2_Delete',
  'Review_Delete',
  'Question_Delete',
  'Answer_Delete',
  'BountyEntry_Delete',
  'Article_Delete',
] as const;

// A reaction being REMOVED is not one being given: counting both inflates the total past the
// Postgres-backed figure shown elsewhere, and renders one react-then-unreact account as two events.
const CREATES_ONLY = `type NOT IN (${DELETE_TYPES.map((t) => `'${t}'`).join(',')})`;

/**
 * Private and carrier-internal space, which correlates everyone and therefore no one. `10.124.0.0/16`
 * is ours and already inside `10/8`; it stays named so the shared constant governs the rest.
 *
 * 🔴 `ip != ''` is a guard, not a tidy-up. `isIPAddressInRange` RAISES on an empty string, and
 * `userActivities` holds a handful (3 in the last 30 days) — so whether this filter throws depends on
 * whether one lands in the range scanned. Order matters too: the guard has to be evaluated first.
 */
const PUBLIC_IP_ONLY = [
  `ip != ''`,
  ...[
    INTERNAL_IP_RANGE,
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '169.254.0.0/16',
    'fc00::/7',
    '::1/128',
  ].map((range) => `NOT isIPAddressInRange(ip, '${range}')`),
].join(' AND ');

const windowFilter = (days: number) => `time >= now() - INTERVAL ${Math.trunc(days)} DAY`;

/**
 * Every reactor on this creator in the window, scored — not the top N by count.
 *
 * 🔴 The cap must be applied AFTER scoring. Ranking by raw count and cutting at 100 drops exactly what
 * the page is for: on eileen33bits over 3 days, a 100%-on-one-creator account with 31 reactions sat at
 * rank 151 by count and never reached the page at all, while thirteen ordinary accounts above it
 * carried 380-410 each.
 *
 * One pass, not two. `ownerId` is NOT in the sort key (`time, reaction, entityId, userId`), so
 * filtering on it prunes nothing — the two-query version scanned the same window twice to compute a
 * denominator that `countIf` produces inline. `time` is what prunes, and it is why a wider lookback
 * costs proportionally: measured 0.25s at 3 days, 0.74s at 90, 5.1s at 365.
 *
 * `minCount` is what makes concentration mean anything. Ordered by concentration with no floor, the
 * head of the list is accounts that reacted ONCE, to this creator, and are therefore "100%" — 15 of
 * the 20 such rows on the measured account. A floor of 5 leaves the five real ones at ranks 1-5.
 *
 * 🔴 The nesting is required, not style. `ORDER BY count / total` alongside `count() OVER ()` in one
 * SELECT raises `Unknown column: divide(countIf(...), count())` — the window forces a resolution stage
 * where the aggregate aliases are not yet arithmetic operands. Nothing local catches that: it
 * typechecks, and a mocked `$query` never parses the string.
 */
async function getReactors(
  ownerId: number,
  days: number,
  { limit, minCount }: { limit: number; minCount: number }
): Promise<InflationReport> {
  const rows = await getClickhouse().$query<{
    userId: string;
    count: string;
    entities: string;
    total: string;
    owners: string;
    matched: string;
  }>(`
    SELECT userId, count, entities, total, owners, matched
    FROM (
      SELECT *, count() OVER () AS matched
      FROM (
        SELECT userId,
               countIf(ownerId = ${ownerId}) AS count,
               uniqIf(entityId, ownerId = ${ownerId}) AS entities,
               count() AS total,
               uniq(ownerId) AS owners
        FROM default.reactions
        WHERE ${windowFilter(days)}
          AND ${CREATES_ONLY}
          AND userId != 0
        GROUP BY userId
        HAVING count >= ${Math.max(1, Math.trunc(minCount))}
      )
    )
    ORDER BY count / total DESC, count DESC
    LIMIT ${limit}
  `);

  return {
    // Everything over the floor, so the page can say which slice of it is on screen. `.length` would
    // report the cap as the answer.
    total: Number(rows[0]?.matched ?? 0),
    capped: false,
    actors: rows.map((r) => {
      const total = Number(r.total);
      const count = Number(r.count);
      return {
        userId: Number(r.userId),
        username: null,
        count,
        entities: Number(r.entities),
        totalGiven: total || null,
        owners: Number(r.owners) || null,
        concentration: total > 0 ? count / total : null,
        status: 'gone' as const,
        strikes: 0,
        createdAt: null,
        instantVerify: null,
      };
    }),
  };
}

/**
 * Postgres, not ClickHouse: `default.stickerUsageEvents` carries no owner and 621 rows total.
 *
 * Declined and removed rows are counted deliberately — a placer whose stickers keep being rejected is
 * who this page is looking for, and `approved`-only would hide a ring already being cleaned up.
 */
async function getStickerPlacers(
  ownerId: number,
  days: number,
  { limit, minCount }: { limit: number; minCount: number }
): Promise<InflationReport> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await dbRead
    .selectFrom('Placement')
    .select((eb) => [
      'placerId',
      eb.fn.countAll<string>().as('count'),
      sql<string>`count(distinct ("targetType", "targetId"))`.as('entities'),
    ])
    .where('ownerId', '=', ownerId)
    .where('surface', '=', 'sticker')
    .where('createdAt', '>=', since)
    .groupBy('placerId')
    .having((eb) => eb.fn.countAll(), '>=', Math.max(1, Math.trunc(minCount)))
    .orderBy('count', 'desc')
    .limit(limit)
    .execute();
  if (!rows.length) return { actors: [], total: 0, capped: false };

  const totals = await dbRead
    .selectFrom('Placement')
    .select((eb) => [
      'placerId',
      eb.fn.countAll<string>().as('total'),
      sql<string>`count(distinct "ownerId")`.as('owners'),
    ])
    .where(
      'placerId',
      'in',
      rows.map((r) => r.placerId)
    )
    .where('surface', '=', 'sticker')
    .where('createdAt', '>=', since)
    .groupBy('placerId')
    .execute();
  const byUser = new Map(totals.map((t) => [t.placerId, t]));

  const actors = rows.map((r) => {
    const total = Number(byUser.get(r.placerId)?.total ?? 0);
    const count = Number(r.count);
    return {
      userId: r.placerId,
      username: null,
      count,
      entities: Number(r.entities),
      totalGiven: total || null,
      owners: Number(byUser.get(r.placerId)?.owners ?? 0) || null,
      concentration: total > 0 ? count / total : null,
      status: 'gone' as const,
      strikes: 0,
      createdAt: null,
      instantVerify: null,
    };
  });

  // Ordered by concentration to match the reactions tab, in JS because the denominator arrives in the
  // second query. Affordable only because the whole `Placement` table is ~5.5k rows site-wide; if
  // stickers grow, this needs the reactions tab's single-pass shape instead.
  actors.sort((a, b) => (b.concentration ?? 0) - (a.concentration ?? 0) || b.count - a.count);
  return { actors, total: actors.length, capped: false };
}

/**
 * How many images the collections pass will consider. `CollectionItem` is 202M rows with no index on
 * the content OWNER and none on `createdAt`, so the only path in is one index probe per image the
 * creator has: measured 9,984 probes / 58K buffers / 725ms for a 10K-image account, and it scales
 * linearly from there.
 *
 * Newest images first, because a cap taken off the oldest would answer about content nobody is
 * currently collecting. `capped` is reported so the page can say which half it read rather than
 * presenting a partial answer as the whole one.
 */
const COLLECTION_IMAGE_CAP = 20_000;

/**
 * Who has been putting a creator's images into collections.
 *
 * No denominator: it would need the same probe-per-image walk over every image each adder has ever
 * collected, which is unbounded in a way the reactions query is not. `concentration` is null here
 * rather than fabricated — `entities` and the shared-IP panel carry the signal instead.
 */
async function getCollectionAdders(
  ownerId: number,
  days: number,
  limit: number
): Promise<InflationReport> {
  const since = new Date(Date.now() - days * 86_400_000);

  // Newest first: a cap taken off the oldest answers about content nobody is currently collecting.
  const recentImages = dbRead
    .selectFrom('Image')
    .select('id')
    .where('userId', '=', ownerId)
    .orderBy('id', 'desc')
    .limit(COLLECTION_IMAGE_CAP);

  // A subquery, NOT ids fetched and pasted back into an `in` list. Postgres drives this as a nested
  // loop of index probes either way, so materialising 20k ids buys a round trip and a query string
  // megabytes long.
  const [{ images } = { images: 0 }, rows] = await Promise.all([
    dbRead
      .selectFrom('Image')
      .select((eb) => eb.fn.countAll<string>().as('images'))
      .where('userId', '=', ownerId)
      .executeTakeFirst()
      .then((r) => ({ images: Number(r?.images ?? 0) })),
    dbRead
      .selectFrom('CollectionItem')
      .select((eb) => [
        'addedById',
        eb.fn.countAll<string>().as('count'),
        sql<string>`count(distinct "collectionId")`.as('entities'),
      ])
      .where('imageId', 'in', recentImages)
      .where('createdAt', '>=', since)
      .where('addedById', 'is not', null)
      // The creator adding their own work to their own collections is not the abuse this looks for,
      // and at the top of the list it pushes the rows that are off the page.
      .where('addedById', '!=', ownerId)
      .groupBy('addedById')
      .orderBy('count', 'desc')
      .limit(limit)
      .execute(),
  ]);

  return {
    capped: images > COLLECTION_IMAGE_CAP,
    total: rows.length,
    actors: rows.map((r) => ({
      userId: r.addedById!,
      username: null,
      count: Number(r.count),
      // Distinct COLLECTIONS, not distinct images: "one account put this creator into 40 collections"
      // is the shape Val described, and the image count is the less interesting half of it.
      entities: Number(r.entities),
      totalGiven: null,
      owners: null,
      concentration: null,
      status: 'gone' as const,
      strikes: 0,
      createdAt: null,
      instantVerify: null,
    })),
  };
}

/** Names, enforcement state, account age and the instant-verify flag for a shortlist. */
async function hydrate(actors: Actor[]): Promise<Actor[]> {
  const ids = actors.map((a) => a.userId).filter(isInt4Id);
  if (!ids.length) return actors;

  const [byId, strikes, signup] = await Promise.all([
    usersByIds(ids),
    strikeCountsByUserIds(ids),
    dbRead
      .selectFrom('User')
      .select(['id', 'createdAt', 'emailVerified'])
      .where('id', 'in', ids)
      .execute(),
  ]);
  const bySignup = new Map(signup.map((s) => [s.id, s]));

  return actors.map((a) => {
    const user = byId.get(a.userId);
    const times = bySignup.get(a.userId);
    const createdAt = times?.createdAt ?? null;
    const verified = times?.emailVerified ?? null;
    return {
      ...a,
      username: user?.username ?? null,
      strikes: strikes.get(a.userId) ?? 0,
      createdAt,
      instantVerify:
        createdAt && verified
          ? verified.getTime() - createdAt.getTime() < INSTANT_VERIFY_SECONDS * 1000
          : null,
      status: !user
        ? ('gone' as const)
        : user.bannedAt
        ? ('banned' as const)
        : user.deletedAt
        ? ('deleted' as const)
        : ('active' as const),
    };
  });
}

export type SharedAddress = {
  /** An exact address, or an IPv6 `/64` — see `clusterExpr`. */
  cluster: string;
  /**
   * Every account the site has ever seen on it, from any event. `null` when `userActivities` holds no
   * row for the address at all, which is not zero — an address with no login or registration behind
   * it is unknown breadth, and rendering it as `0` would sort it to the top as the strongest possible
   * signal.
   */
  totalAccounts: number | null;
};

export type SharedIpPeer = { userId: number; username: string | null; isTarget: boolean };

/**
 * Keyed by ACCOUNT, not by address, because address-keyed repeats itself into uselessness on the
 * dominant real pattern. A residential connection rotates its address constantly: on the case this
 * was built from, one reactor and the creator share six addresses in 88.4/88.7, which renders as six
 * rows carrying the same two names. Inverted, that is one entry saying "this account, six addresses,
 * with the creator" — and it lines up with the table beside it, which is also a list of accounts.
 */
export type SharedIpAccount = {
  userId: number;
  username: string | null;
  /** Shares at least one address with the creator being looked up. The finding. */
  withTarget: boolean;
  /** Narrowest first, so the most identifying address leads. */
  addresses: SharedAddress[];
  /** Everyone else seen on those addresses, creator first. */
  peers: SharedIpPeer[];
};

/**
 * The clustering expression, in ClickHouse, shared by both queries below.
 *
 * 🔴 IPv6 collapses to `/64` because a residential prefix rotates its suffix per connection: seven
 * addresses differing only in the low 64 bits, carrying the same four accounts, filled the panel on the
 * first run. The grouping has to happen INSIDE the query — done afterwards in JS, the
 * `HAVING uniq(...) > 1` that keeps the panel bounded runs per exact address, and the rotation case it
 * exists to catch (two accounts on one prefix, never on the same suffix) is exactly what it drops.
 *
 * IPv4 stays exact by default — a `/24` merges unrelated subscribers on one ISP block — with
 * `groupIpv4` for a hosting range doing the same rotation. The branch on `:` is load-bearing:
 * `toIPv6` maps IPv4 into `::ffff:0:0/96`, so one unbranched `/64` would collapse every IPv4 address
 * in the table into a single bucket.
 */
const clusterExpr = (groupIpv4: boolean) => `if(position(ip, ':') > 0,
      concat(IPv6NumToString(tupleElement(IPv6CIDRToRange(toIPv6OrDefault(ip), 64), 1)), '/64'),
      ${
        groupIpv4 ? `concat(IPv4NumToString(bitAnd(toIPv4OrDefault(ip), 4294967040)), '/24')` : 'ip'
      })`;

/**
 * The side panel: addresses two or more of the listed accounts were seen on, and how many accounts the
 * site has EVER seen on each.
 *
 * 🔴 `totalAccounts` is what makes this usable rather than a false-positive generator. Measured on the
 * case this was built from: the operator's own address carried 2 accounts, a small proxy 79, and a
 * public VPN exit 358. All three look identical if you only count the listed accounts sharing them.
 *
 * 🔴 **Deliberately NOT bounded by the page's lookback.** The actor list answers "who is inflating this
 * account lately"; an address correlation answers "are these the same person", which is not a question
 * about recent activity. Windowing it to 3 days loses exactly the evidence the tool exists to surface:
 * on eileen33bits, the sock and the target share 88.4.147.16 and 88.5.53.35, last used in MARCH — five
 * months outside the default window, and invisible at every lookback the page offers.
 *
 * `userActivities` rather than `reactions`, for all three categories. It is where registration and
 * login IPs live, it is the table the breadth count already reads (so the cluster keys agree by
 * construction), and unbounded it costs 0.6s against 4.6s for the 844M-row reaction table. The cost is
 * addresses seen ONLY in a reaction — which by definition have no activity row, so their breadth was
 * unmeasurable anyway.
 */
export async function getSharedIps(
  userIds: number[],
  {
    targetId,
    groupIpv4 = false,
    limit = 50,
  }: { targetId: number; groupIpv4?: boolean; limit?: number }
): Promise<SharedIpAccount[]> {
  // 🔴 The target belongs in the correlation set even when it is not in the actor list — it usually
  // is not. A creator appears among their own reactors only through self-reactions, and plenty have
  // none (measured: 0 for user 5227124 over 3 days, against 168 for 2832460). Leave the target out
  // and the panel silently cannot test "this reactor shares an address with the creator they are
  // boosting", which is the strongest thing it has to say.
  const ids = [...new Set([...userIds, targetId])].filter(isInt4Id);
  if (ids.length < 2) return [];

  const rows = await getClickhouse().$query<{
    cluster: string;
    userIds: string[];
    ips: string[];
  }>(`
    SELECT ${clusterExpr(groupIpv4)} AS cluster,
           groupUniqArray(targetUserId) AS userIds,
           groupUniqArray(20)(ip) AS ips
    FROM default.userActivities
    WHERE targetUserId IN (${ids.join(',')})
      AND ${PUBLIC_IP_ONLY}
    GROUP BY cluster
    HAVING uniq(targetUserId) > 1
    ORDER BY max(targetUserId = ${targetId}) DESC, uniq(targetUserId) ASC, cluster ASC
    LIMIT ${limit}
  `);
  if (!rows.length) return [];

  // Ordered in SQL, not after: clusters holding the target have to outrank the LIMIT, not just the
  // other rows on the page. Narrowest next — a cluster of two is the decisive one, and ordering by
  // "most accounts", the obvious choice, puts the VPN exits on top and buries the evidence.
  const [breadth, byId] = await Promise.all([
    accountsPerCluster(
      rows.flatMap((r) => r.ips),
      groupIpv4
    ),
    usersByIds(rows.flatMap((r) => r.userIds.map(Number))),
  ]);

  const accounts = new Map<number, { addresses: SharedAddress[]; peers: Set<number> }>();
  for (const row of rows) {
    const members = row.userIds.map(Number);
    const address = { cluster: row.cluster, totalAccounts: breadth.get(row.cluster) ?? null };
    for (const userId of members) {
      // The creator gets no entry of its own: it is a member of every finding here, so its entry
      // would be a copy of the whole panel.
      if (userId === targetId) continue;
      const entry = accounts.get(userId) ?? { addresses: [], peers: new Set<number>() };
      entry.addresses.push(address);
      for (const peer of members) if (peer !== userId) entry.peers.add(peer);
      accounts.set(userId, entry);
    }
  }

  // Unknown breadth sorts as wide, not narrow: `null` means no activity row to measure, which is
  // weaker evidence than a measured 2, and `?? 0` would rank it as the strongest thing on the page.
  const width = (a: SharedAddress) => a.totalAccounts ?? Number.MAX_SAFE_INTEGER;
  const narrowest = (list: SharedAddress[]) => Math.min(...list.map(width));

  return [...accounts.entries()]
    .map(([userId, entry]) => ({
      userId,
      username: byId.get(userId)?.username ?? null,
      withTarget: entry.peers.has(targetId),
      addresses: entry.addresses.sort((a, b) => width(a) - width(b)),
      peers: [...entry.peers]
        .sort((a, b) => Number(b === targetId) - Number(a === targetId) || a - b)
        .map((peer) => ({
          userId: peer,
          username: byId.get(peer)?.username ?? null,
          isTarget: peer === targetId,
        })),
    }))
    .sort(
      (a, b) =>
        Number(b.withTarget) - Number(a.withTarget) ||
        narrowest(a.addresses) - narrowest(b.addresses) ||
        b.addresses.length - a.addresses.length
    );
}

async function accountsPerCluster(ips: string[], groupIpv4: boolean): Promise<Map<string, number>> {
  const safe = [...new Set(ips)].filter((ip) => IP_PATTERN.test(ip));
  if (!safe.length) return new Map();

  const rows = await getClickhouse().$query<{ cluster: string; total: string }>(`
    SELECT ${clusterExpr(groupIpv4)} AS cluster, uniqExact(targetUserId) AS total
    FROM default.userActivities
    WHERE ip IN (${safe.map((ip) => `'${ip}'`).join(',')})
      AND targetUserId > 0
    GROUP BY cluster
  `);
  return new Map(rows.map((r) => [r.cluster, Number(r.total)]));
}

export type InflationReport = {
  actors: Actor[];
  /** Everyone over the floor, of whom `actors` is the top slice. */
  total: number;
  /** The creator has more images than the collections pass walks, so the counts are a floor. */
  capped: boolean;
};

export async function getInflationActors(
  ownerId: number,
  {
    category,
    days,
    limit = 100,
    minCount,
  }: { category: Category; days: number; limit?: number; minCount: number }
): Promise<InflationReport> {
  const empty = { actors: [], total: 0, capped: false };
  if (!isInt4Id(ownerId)) return empty;

  const report =
    category === 'collections'
      ? await getCollectionAdders(ownerId, days, limit)
      : category === 'stickers'
      ? await getStickerPlacers(ownerId, days, { limit, minCount })
      : await getReactors(ownerId, days, { limit, minCount });
  return { ...report, actors: await hydrate(report.actors) };
}
