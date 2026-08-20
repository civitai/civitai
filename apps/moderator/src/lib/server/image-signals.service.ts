import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { usersByIds } from './users.service';
import { INTERNAL_IP_RANGE } from './clickhouse-filters';

// Everything behind `/api/image-signals` — the ClickHouse half of Image Lookup. One file per endpoint,
// same rule as the User Lookup services.
//
// `reactions` is 825M rows and sorts by TIME first (time, reaction, entityId, userId), so filtering on
// the image id alone scans the table: 2.0s measured, 5.3s on a colder id. A reaction cannot predate the
// image it is on, so the image's own `createdAt` as a lower bound puts the query back on the sort key —
// 2.0s to 203ms. (`default.images` is deliberately UNBOUNDED; see `getImageEvents`.)
//
// The ClickHouse helper interpolates values with NO escaping, so only numbers we control and a bound
// matched against CH_DATETIME are ever put into a query.
//
// The bound arrives as a STRING the database formatted, never as a JS Date. `Image.createdAt` is
// `timestamp without time zone` and no pg type parser is registered for it, so node-pg reads it as local
// time in the server process; `toISOString()` then re-projects it and adds the offset. On a UTC-6 host
// that pushed the bound SIX HOURS into the image's life and hid 60% of a real ring (25 accounts and 37
// reactions became 13 and 16 on a live image) — while printing "nothing suggesting a ring" for any ring
// that fired in the hour after upload, which is the normal shape. Callers read it with `to_char`.
const CH_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const bounded = (createdAt: string | null, column: string) => {
  if (!createdAt) return '';
  if (!CH_DATETIME.test(createdAt)) throw new Error('[image-signals] malformed time bound');
  return `AND ${column} >= toDateTime('${createdAt}')`;
};

export type ImageEvent = {
  key: string;
  type: string;
  time: string;
  userId: number;
  tosReason: string | null;
  violationType: string | null;
  violationDetails: string;
  /** Owner AT THE TIME of the event, which a transfer makes different from the current one. */
  ownerId: number;
  nsfw: string | null;
  /** Model ids on a Resources event, as ClickHouse renders the array. */
  resources: string | null;
  ip: string | null;
  userAgent: string | null;
  via: string | null;
  /** The tag set as of that moment — on a Tags event this is what the scanner changed. */
  tags: string | null;
};

// `default.images` is the image's lifecycle log — Create / Delete / DeleteTOS / Tags / Resources /
// Restore / Play — and it is the only place the TOS reason and violation type for a removal are kept.
//
// NOT time-bounded, unlike the reactions scan below: the bound can only LOSE rows (anything logged
// before the Postgres `createdAt`), the truncation banner fires on the LIMIT so nothing on screen would
// say so, and unbounded is 8.2M rows / ~400ms. On the deleted path the oldest event is the original
// DeleteTOS, which is what the moderator came for.
export async function getImageEvents(
  imageId: number,
  limit = 50
): Promise<{ rows: ImageEvent[]; truncated: boolean }> {
  const rows = await getClickhouse().$query<{
    type: string;
    time: string;
    userId: string;
    ownerId: string;
    nsfw: string | null;
    tosReason: string | null;
    violationType: string | null;
    violationDetails: string;
    tags: string | null;
    resources: string | null;
    ip: string | null;
    userAgent: string | null;
    via: string | null;
  }>(`
    SELECT type, time, userId, ownerId, nsfw, tosReason, violationType, violationDetails,
           toString(tags) AS tags, toString(resources) AS resources, ip, userAgent, via
    FROM default.images
    WHERE imageId = ${imageId}
    ORDER BY time DESC
    LIMIT ${limit + 1}
  `);

  // ORDER BY time DESC means an over-cap image loses its OLDEST events — and on the deleted path the
  // original DeleteTOS is exactly what a moderator came for, so the cap has to be visible.
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit).map((r, i) => ({
    // The table has no row id and the same (type, time) pair genuinely repeats, so the ordinal is the
    // only stable key a list can use.
    key: `${i}:${r.time}`,
    type: r.type,
    time: clickhouseDate(r.time),
    userId: Number(r.userId),
    ownerId: Number(r.ownerId),
    nsfw: r.nsfw || null,
    tosReason: r.tosReason,
    violationType: r.violationType,
    violationDetails: r.violationDetails,
    tags: r.tags || null,
    resources: r.resources && r.resources !== '[]' ? r.resources : null,
    ip: r.ip || null,
    userAgent: r.userAgent || null,
    via: r.via || null,
  }));

  return { rows: page, truncated };
}

/** Does this image have any lifecycle log at all? Distinguishes "removed" from "never existed" for an id
 *  with no Postgres row — a distinction a moderator acts on. */
export async function hasImageEvents(imageId: number): Promise<boolean> {
  const rows = await getClickhouse().$query<{ n: string }>(`
    SELECT count() AS n FROM default.images WHERE imageId = ${imageId}
  `);
  return Number(rows[0]?.n ?? 0) > 0;
}

export type ReactionCluster = {
  ip: string;
  reactions: number;
  accounts: { userId: number; username: string | null; bannedAt: Date | null }[];
};

export type ReactionSignals = {
  totalReactions: number;
  distinctIps: number;
  clusters: ReactionCluster[];
  truncated: boolean;
};

// VOTE-RING DETECTION, and the reason this page is worth having. Retool ran two queries — every
// (userId, ip, reaction) row, and a separate count grouped by ip — and left the moderator to eyeball the
// join. This groups by IP directly and returns only the addresses carrying MORE THAN ONE account, which
// is the entire signal: a dozen reactions from a dozen addresses is a popular image, a dozen from one
// address is a ring.
//
// `Image_Create` ONLY. `Image_Delete` is a reaction being REMOVED, not given — counting it inflated the
// total above the Postgres-backed reaction count on the same page with no explanation, and let two
// people who each reacted-then-unreacted from one NAT render as a red two-account ring.
export async function getReactionSignals(
  imageId: number,
  createdAt: string,
  limit = 25
): Promise<ReactionSignals> {
  const bound = bounded(createdAt, 'time');
  const filter = `
      ${bound}
      AND type = 'Image_Create'
      AND NOT isIPAddressInRange(ip, '${INTERNAL_IP_RANGE}')`;

  const [totals] = await getClickhouse().$query<{ total: string; ips: string }>(`
    SELECT count() AS total, uniq(ip) AS ips
    FROM default.reactions
    WHERE entityId = ${imageId} ${filter}
  `);

  const rows = await getClickhouse().$query<{ ip: string; reactions: string; userIds: string[] }>(`
    SELECT ip, count() AS reactions, groupUniqArray(userId) AS userIds
    FROM default.reactions
    WHERE entityId = ${imageId} ${filter}
    GROUP BY ip
    HAVING uniq(userId) > 1
    ORDER BY reactions DESC
    LIMIT ${limit + 1}
  `);

  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const byId = await usersByIds(page.flatMap((r) => r.userIds.map(Number)));

  return {
    totalReactions: Number(totals?.total ?? 0),
    distinctIps: Number(totals?.ips ?? 0),
    truncated,
    clusters: page.map((r) => ({
      ip: r.ip,
      reactions: Number(r.reactions),
      accounts: r.userIds.map(Number).map((userId) => ({
        userId,
        username: byId.get(userId)?.username ?? null,
        bannedAt: byId.get(userId)?.bannedAt ?? null,
      })),
    })),
  };
}
