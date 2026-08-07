import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { usersByIds } from './users.service';
import { strikeCountsByUserIds } from './moderation-memory.service';
import { INTERNAL_IP_RANGE, IP_PATTERN } from './clickhouse-filters';

// Everything behind `/api/user-signals` — the ban-evasion and abuse half of User Lookup.
//
// One file per endpoint is the rule for this page's services: the endpoint is also the latency budget,
// which is the constraint the whole page is built around. Do not group by when something was written.
//
// The ClickHouse helper interpolates values with NO escaping, so only numbers we control and IPs matched
// against IP_PATTERN are ever put into a query.

// SECURITY SIGNALS
//
// `userActivities` is ClickHouse. Use `targetUserId`, NOT `userId`: for Login and Registration rows
// `userId` is empty ~95% of the time (30M of 31.5M logins), so filtering on it silently finds nothing.
//
// The ClickHouse helper interpolates values with NO escaping (formatSqlType returns strings verbatim), so
// only numbers we control and IPs matched against IP_PATTERN are ever put into a query.

export type UserIp = {
  ip: string;
  type: string;
  first: string;
  last: string;
  events: number;
};

export async function getUserIps(userId: number): Promise<UserIp[]> {
  const rows = await getClickhouse().$query<{
    ip: string;
    type: string;
    first: string;
    last: string;
    events: string;
  }>(`
    SELECT ip, type, min(time) AS first, max(time) AS last, count() AS events
    FROM default.userActivities
    WHERE targetUserId = ${userId}
      AND NOT isIPAddressInRange(ip, '${INTERNAL_IP_RANGE}')
      AND type != 'Banned'
    GROUP BY ip, type
    ORDER BY last DESC
    LIMIT 100
  `);
  return rows.map((r) => ({
    ...r,
    first: clickhouseDate(r.first),
    last: clickhouseDate(r.last),
    events: Number(r.events),
  }));
}

// Retool's FindPreviousBans + SimilarIpStrikes: whether a linked account was itself actioned. Without
// it the linked-account lists say only that two accounts share an address, which is not by itself
// evidence of anything — the enforcement history is the part that makes the panel actionable.
export type LinkedAccount = {
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  muted: boolean | null;
  strikes: number;
};

export type SharedIpAccount = LinkedAccount & {
  ip: string;
  type: string;
  last: string;
};

// Ban-evasion signal: other accounts seen on the IPs this user REGISTERED or SUBSCRIBED from. Retool
// filtered to those two types deliberately — a login IP is often a shared/carrier address, while the
// address an account was created from is far more identifying.
//
// Capped hard at both ends: a carrier NAT can carry thousands of unrelated accounts, and returning them
// all would be slow and useless. A truncated result is reported rather than silently trimmed.
// Identifying IPs are selected by their OWN query, not filtered out of `getUserIps`. That list is
// capped at 100 (ip, type) groups ordered by recency, and a registration is by definition the oldest
// event on the account — so for any busy user the Registration row falls outside the cap and the
// ban-evasion panel silently reports "none found" on exactly the accounts worth investigating.
async function getIdentifyingIps(userId: number): Promise<string[]> {
  const rows = await getClickhouse().$query<{ ip: string }>(`
    SELECT DISTINCT ip
    FROM default.userActivities
    WHERE targetUserId = ${userId}
      AND type IN ('Registration', 'Subscribe')
      AND NOT isIPAddressInRange(ip, '${INTERNAL_IP_RANGE}')
    LIMIT 25
  `);
  return rows.map((r) => r.ip).filter((ip) => IP_PATTERN.test(ip));
}

export async function getSharedIpAccounts(
  userId: number
): Promise<{ accounts: SharedIpAccount[]; truncated: boolean }> {
  const identifying = await getIdentifyingIps(userId);
  if (!identifying.length) return { accounts: [], truncated: false };

  const LIMIT = 100;
  const list = identifying.map((ip) => `'${ip}'`).join(', ');
  const rows = await getClickhouse().$query<{
    userId: string;
    ip: string;
    type: string;
    last: string;
  }>(`
    SELECT targetUserId AS userId, ip, type, max(time) AS last
    FROM default.userActivities
    WHERE ip IN (${list})
      AND targetUserId != ${userId}
      AND targetUserId > 0
    GROUP BY targetUserId, ip, type
    ORDER BY last DESC
    LIMIT ${LIMIT + 1}
  `);

  const truncated = rows.length > LIMIT;
  const page = rows.slice(0, LIMIT);
  const ids = page.map((r) => Number(r.userId));
  const [byId, strikes] = await Promise.all([usersByIds(ids), strikeCountsByUserIds(ids)]);

  return {
    accounts: page.map((r) => {
      const id = Number(r.userId);
      const u = byId.get(id);
      return {
        userId: id,
        username: u?.username ?? null,
        bannedAt: u?.bannedAt ?? null,
        muted: u?.muted ?? null,
        strikes: strikes.get(id) ?? 0,
        ip: r.ip,
        type: r.type,
        last: clickhouseDate(r.last),
      };
    }),
    truncated,
  };
}

// ACCOUNT LIFECYCLE EVENTS (Retool's ClickhouseUserActivities). Registration, subscribe, cancel,
// ban/unban, mute/unmute — the account's own history, which `ModActivity` does not hold: that table
// keys on content, and these events predate it.
//
// Retool UNIONed a second half over `default.images` for moderator actions on this user's images;
// that half is what ModActivityPanel already reads from Postgres, with usernames and no duplication.
export type AccountEvent = {
  /** `userActivities` has no primary key and repeats freely; the ordinal is the only stable identity. */
  key: string;
  type: string;
  time: string;
  actorId: number | null;
  actor: string | null;
};

export async function getAccountEvents(userId: number, limit = 50): Promise<AccountEvent[]> {
  const rows = await getClickhouse().$query<{ type: string; time: string; actorId: string }>(`
    SELECT type, time, userId AS actorId
    FROM default.userActivities
    WHERE targetUserId = ${userId}
    ORDER BY time DESC
    LIMIT ${limit}
  `);

  const byId = await usersByIds(rows.map((r) => Number(r.actorId)));
  return rows.map((r, i) => {
    // Self-service events (registration, subscribe) carry the user's own id or none at all; only a
    // DIFFERENT id is a moderator acting on the account.
    const actorId = Number(r.actorId);
    const isActor = actorId > 0 && actorId !== userId;
    return {
      key: `${i}:${r.time}`,
      type: r.type,
      time: clickhouseDate(r.time),
      actorId: isActor ? actorId : null,
      actor: isActor ? (byId.get(actorId)?.username ?? null) : null,
    };
  });
}

export type UserSocial = { id: number; url: string; type: string };

// Matching key, not a display value: scheme, `www.` and trailing slashes are cosmetic, and treating them
// as significant splits a ring in half. Measured: one spam domain is held by 35 accounts with a trailing
// slash and 25 without, and those two sets do not overlap at all — an exact match reports 24 alts on a
// 60-account ring.
const normalizedUrl = (column: string) =>
  sql<string>`regexp_replace(regexp_replace(lower(btrim(${sql.ref(column)})), '^https?://(www\\.)?', ''), '/+$', '')`;

// `UserLink` has no uniqueness on (userId, url) — one account holds the same link up to 19 times — so
// every read here dedupes. Left raw it renders a link 19 times, and in the shared-account list it
// produces a duplicate `{#each}` key, which Svelte throws on in production from inside the `:then`
// branch where the `{:catch}` cannot see it.
export async function getSocials(userId: number): Promise<UserSocial[]> {
  return dbRead
    .selectFrom('UserLink')
    .select(['id', 'url', 'type'])
    .distinctOn(normalizedUrl('url'))
    .where('userId', '=', userId)
    .orderBy(normalizedUrl('url'))
    .orderBy('id')
    .execute();
}

export type SharedSocialAccount = LinkedAccount & { url: string };

// Ban-evasion signal in the same class as shared IPs, and in practice a sharper one: the most-shared
// links in the table are spam-network domains posted by dozens of accounts each.
//
// Retool did this by SELECTing the entire UserLink table and matching in the browser. Matching in SQL
// as a self-join is worse still — 21s for a user with many links, because it drives a sequential scan
// per link. Two statements instead: collect this user's URLs, then one scan matching all of them (~40ms).
// `url` has no index.
//
// The cap counts ACCOUNTS, not rows. Capping rows let one account holding 25 shared links fill the whole
// window and report "25+ accounts" for what is a single alt, while pushing every genuinely distinct
// account out of sight.
export async function getSharedSocialAccounts(
  userId: number
): Promise<{ accounts: SharedSocialAccount[]; truncated: boolean }> {
  const mine = await dbRead
    .selectFrom('UserLink')
    .select(normalizedUrl('url').as('url'))
    .distinct()
    .where('userId', '=', userId)
    .execute();
  const urls = mine.map((r) => r.url).filter(Boolean);
  if (!urls.length) return { accounts: [], truncated: false };

  const LIMIT = 25;
  const rows = await dbRead
    .selectFrom('UserLink as ul')
    .innerJoin('User as u', 'u.id', 'ul.userId')
    .select(['ul.userId', 'ul.url', 'u.username', 'u.bannedAt', 'u.muted'])
    .distinctOn('ul.userId')
    .where(normalizedUrl('ul.url'), 'in', urls)
    .where('ul.userId', '!=', userId)
    .orderBy('ul.userId')
    .orderBy('ul.id')
    .limit(LIMIT + 1)
    .execute();

  // DISTINCT ON fixes the row order, so banned-first ordering is applied here rather than in SQL.
  const sorted = rows.sort((a, b) => Number(!!b.bannedAt) - Number(!!a.bannedAt));
  const page = sorted.slice(0, LIMIT);
  const strikes = await strikeCountsByUserIds(page.map((r) => r.userId));

  return {
    accounts: page.map((r) => ({ ...r, strikes: strikes.get(r.userId) ?? 0 })),
    truncated: sorted.length > LIMIT,
  };
}

// Retool's PotentialSpammer/V2 (Postgres, despite sitting beside the ClickHouse queries): a burst of
// comments in a short window. V2 supersedes V1 by summing both comment tables instead of returning a row
// per table, so only that behaviour is ported.
export async function getCommentBurst(userId: number): Promise<number> {
  const [v2, v1] = await Promise.all(
    (['CommentV2', 'Comment'] as const).map(async (table) => {
      const r = await dbRead
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('userId', '=', userId)
        .where('createdAt', '>', sql<Date>`now() - interval '2 days'`)
        .executeTakeFirst();
      return Number(r?.count ?? 0);
    })
  );
  return v2 + v1;
}

// GENERATION ABUSE (Retool's GetBlockedPrompts, GenRateLimited).
//
// `GeneratorCount` — an all-time COUNT over the 1.08B-row textToImageJobs, which sorts by createdAt — is
// deliberately NOT ported: it would scan the table, and `UserStat.generationCountAllTime` already carries
// the same number for free (it is on the Reputation panel).
export type BlockedPrompt = {
  /** `prohibitedRequests` has no primary key and genuinely repeats — one user has 35 rows with the same
   *  (time, prompt) — so the row's ordinal is the only stable identity a list can key on. */
  key: string;
  time: string;
  prompt: string;
  negativePrompt: string | null;
  source: string;
};

export async function getBlockedPrompts(
  userId: number,
  limit = 25
): Promise<{ prompts: BlockedPrompt[]; total: number }> {
  const rows = await getClickhouse().$query<{
    time: string;
    prompt: string;
    negativePrompt: string | null;
    source: string;
    total: string;
  }>(`
    SELECT time, prompt, negativePrompt, source, count() OVER () AS total
    FROM default.prohibitedRequests
    WHERE userId = ${userId}
    ORDER BY time DESC
    LIMIT ${limit}
  `);
  return {
    total: Number(rows[0]?.total ?? 0),
    prompts: rows.map(({ total: _total, ...r }, i) => ({
      ...r,
      key: `${i}:${r.time}`,
      time: clickhouseDate(r.time),
    })),
  };
}

/** Generation jobs in the last 24h — the rate-limit signal. Bounded to stay on the sort key. */
export async function getRecentGenerations(userId: number): Promise<number> {
  const rows = await getClickhouse().$query<{ count: string }>(`
    SELECT count() AS count
    FROM orchestration.textToImageJobs
    WHERE createdAt > now() - INTERVAL 24 HOUR
      AND userId = ${userId}
  `);
  return Number(rows[0]?.count ?? 0);
}

// HAS THIS ACCOUNT SPOKEN TO A MODERATOR? (Retool's FindChats + FindChatsWithMods.)
//
// The ticket asks for a warning on lookup, not a chat browser — the transcript belongs to the Chat Audit
// app. So this returns a count and the most recent contact, not messages.
//
// Retool hardcoded sixteen moderator user ids inline; this derives from `User.isModerator` so the list
// cannot go stale as the team changes.
//
// `id > 0` is NOT cosmetic. The `civitai` account is id -1, carries `isModerator`, and auto-posts a
// system line ("<name> joined") into every chat anyone joins — 586,576 messages across 266,350 chats.
// Including it made this banner fire for 133,081 users, i.e. essentially anyone who has ever been in a
// DM, asserting moderator contact that never happened. Retool's hardcoded list did not contain -1, so
// deriving the list is only an improvement once system accounts are excluded.
export async function getModeratorContact(
  userId: number
): Promise<{ chats: number; lastAt: Date | null }> {
  const row = await dbRead
    .selectFrom('ChatMessage as cm')
    .select((eb) => [
      eb.fn.count<string>('cm.chatId').distinct().as('chats'),
      eb.fn.max('cm.createdAt').as('lastAt'),
    ])
    .where('cm.chatId', 'in', (eb) =>
      eb.selectFrom('ChatMember').select('chatId').where('userId', '=', userId)
    )
    .where('cm.userId', '!=', userId)
    .where('cm.userId', 'in', (eb) =>
      eb.selectFrom('User').select('id').where('isModerator', '=', true).where('id', '>', 0)
    )
    .executeTakeFirst();

  return { chats: Number(row?.chats ?? 0), lastAt: row?.lastAt ?? null };
}
