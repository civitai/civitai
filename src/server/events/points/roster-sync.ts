import { chunk } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { loadEvents } from '~/server/events/load-events';
import { eventPointSeason, seasonOwnerTopicId } from '~/server/events/points/keys';
import { getOwnerPoints } from '~/server/events/points/read';
import { eventRosterKeys, type RosterHat } from '~/server/events/points/roster';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';

// Keeps the roster sets (roster.ts) in step with Postgres, one member at a time or in batches. Every
// write re-derives the member from scratch, so the same call serves an opt-in, an opt-out, a hat
// gained, a ban and the hourly reconcile, and running it twice changes nothing. Reads Postgres, so it
// runs on write requests and jobs only, never on a page read.

export type RosterEvent = {
  name: string;
  startDate: Date;
  teams: readonly string[];
  join: { claimKey: string; design: string };
};

// What Postgres says about one user, for one event.
export type RosterMemberState = {
  userId: number;
  optedIn: boolean;
  // Not banned, deleted or excluded from leaderboards: the owners whose hats may earn.
  eligible: boolean;
  // The team of the join cosmetic they hold, or null when they never joined.
  team: string | null;
  joinedAt: Date | null;
  // Their event hats in shelf order (roster.ts RosterHat).
  hats: RosterHat[];
};

export const isListed = (s: RosterMemberState, event: RosterEvent) =>
  s.optedIn && s.eligible && !!s.team && event.teams.includes(s.team);

// The opt-in lives in User.settings, the durable record the sets are rebuilt from.
export const ROSTER_SETTING = 'eventRosterOptIn';

export async function loadRosterMemberStates(
  event: RosterEvent,
  userIds: number[],
  db: Pick<typeof dbRead, '$queryRaw'> = dbWrite
): Promise<RosterMemberState[]> {
  if (!userIds.length) return [];
  const rows = await db.$queryRaw<
    {
      userId: number;
      optedIn: boolean | null;
      eligible: boolean;
      team: string | null;
      joinedAt: Date | null;
      hats: RosterHat[] | null;
    }[]
  >`
    SELECT u.id AS "userId",
      (u.settings -> ${ROSTER_SETTING} ->> ${event.name}) = 'true' AS "optedIn",
      (u."bannedAt" IS NULL AND u."deletedAt" IS NULL AND NOT u."excludeFromLeaderboards") AS eligible,
      j.team, j."obtainedAt" AS "joinedAt", h.hats
    FROM "User" u
    LEFT JOIN LATERAL (
      SELECT c.data ->> 'team' AS team, uc."obtainedAt"
      FROM "UserCosmetic" uc
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      WHERE uc."userId" = u.id AND uc."claimKey" = ${event.join.claimKey}
        AND c.type = 'ContentDecoration'
        AND c.data ->> 'event' = ${event.name} AND c.data ->> 'design' = ${event.join.design}
      ORDER BY uc."obtainedAt", uc."cosmeticId"
      LIMIT 1
    ) j ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object('id', x."cosmeticId", 'worn', x.worn, 'price', x.price)
        ORDER BY x.worn DESC, x.price DESC NULLS LAST, x."obtainedAt" DESC, x."cosmeticId"
      ) AS hats
      FROM (
        SELECT uc."cosmeticId", uc."equippedToId" IS NOT NULL AS worn, uc."obtainedAt",
          (SELECT min(si."unitAmount") FROM "CosmeticShopItem" si
            WHERE si."cosmeticId" = uc."cosmeticId") AS price
        FROM "UserCosmetic" uc
        JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
        WHERE uc."userId" = u.id AND c.type = 'ContentDecoration'
          AND c.data ->> 'event' = ${event.name}
      ) x
    ) h ON true
    WHERE u.id = ANY(${userIds}::int[])
  `;
  const byId = new Map(rows.map((r) => [r.userId, r]));
  // A user with no row (deleted outright) is unlisted.
  return userIds.map((userId) => {
    const r = byId.get(userId);
    return {
      userId,
      optedIn: r?.optedIn === true,
      eligible: r?.eligible === true,
      team: r?.team ?? null,
      joinedAt: r?.joinedAt ?? null,
      hats: r?.hats ?? [],
    };
  });
}

export type RosterWriteRedis = Pick<
  typeof sysRedis,
  'hmGet' | 'hSet' | 'hDel' | 'zAdd' | 'zRem' | 'eval'
>;

// What an unlisted member's gate entry holds for a while: never a team, so no read lists them, and
// different from what any sync in flight read, so its listing write (below) fails.
const HIDDEN_PREFIX = 'x:';
export const isTombstone = (value: string | null | undefined) =>
  !!value && value.startsWith(HIDDEN_PREFIX);
export const rosterTeam = (value: string | null | undefined) =>
  value && !isTombstone(value) ? value : null;
// Tombstones older than this go at the reconcile: long past any sync that read before them.
const TOMBSTONE_TTL_MS = 60 * 60 * 1000;
// Opens the gate only if it still holds what this sync read before it read Postgres. A sync that
// read someone as opted in just before they opted out finds the opt-out's tombstone and lists
// nobody.
const LIST_IF_UNCHANGED = `local v = redis.call('HGET', KEYS[1], ARGV[1]) or ''
if v == ARGV[2] then redis.call('HSET', KEYS[1], ARGV[1], ARGV[3]) return 1 end
return 0`;

export type RosterSyncDeps = {
  redis: RosterWriteRedis;
  loadStates: (event: RosterEvent, userIds: number[]) => Promise<RosterMemberState[]>;
  // Exact owner totals in the season of `now` (read.ts).
  ownerPoints: (
    event: RosterEvent,
    ownerIds: number[],
    now: Date
  ) => Promise<Record<string, number>>;
  now: () => Date;
};

const seasonsFrom = (event: RosterEvent, now: Date) =>
  eventPointSeason(event.startDate, now) === 'preview'
    ? (['preview', 'live'] as const)
    : (['live'] as const);

// Brings these users' roster entries up to date with Postgres. Returns how many are listed and
// how many entries were removed, for the reconcile's log. `hide` is for an opt-out: it leaves a
// tombstone even for someone not listed yet, in case their opt-in's sync is still in flight.
//
// The gate is read before Postgres, and both reads go to the primary: that order is what lets the
// compare-and-set below refuse a sync that read Postgres before an unlisting it has not seen.
export async function syncRosterMembersWith(
  event: RosterEvent,
  userIds: number[],
  deps: RosterSyncDeps,
  { hide = false }: { hide?: boolean } = {}
) {
  const ids = [...new Set(userIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return { listed: 0, removed: 0 };
  const keys = eventRosterKeys(event.name);
  const now = deps.now();
  const season = eventPointSeason(event.startDate, now);
  const gate = await deps.redis.hmGet(keys.members, ids.map(String));
  const previous = new Map(ids.map((id, i) => [id, gate[i] ?? null]));
  const states = await deps.loadStates(event, ids);
  const listed = states.filter((s) => isListed(s, event));
  const unlisted = states.filter((s) => !isListed(s, event));
  const points = listed.length
    ? await deps.ownerPoints(
        event,
        listed.map((s) => s.userId),
        now
      )
    : {};

  // Unlisting closes the gate first, so no read can pair a remaining score with a listed member.
  // Anyone with a gate entry, or anyone hidden on request, gets a fresh tombstone. Everyone else
  // never had one, and writing one for every banned stranger would only grow the hash.
  const removed = unlisted.filter((s) => rosterTeam(previous.get(s.userId))).length;
  const toHide = unlisted.filter((s) => hide || previous.get(s.userId));
  if (toHide.length)
    await deps.redis.hSet(
      keys.members,
      Object.fromEntries(toHide.map((s) => [String(s.userId), `${HIDDEN_PREFIX}${now.getTime()}`]))
    );
  await clearEntries(
    event,
    unlisted.map((s) => s.userId),
    deps
  );

  // Listing writes the scores first and opens the gate last.
  for (const s of listed) {
    const team = s.team!;
    const member = String(s.userId);
    const was = previous.get(s.userId);
    if (was && was !== team)
      await Promise.all(teamKeys(keys, was).map((k) => deps.redis.zRem(k, member)));
    await Promise.all([
      deps.redis.zAdd(keys.joined(team), {
        score: (s.joinedAt ?? now).getTime(),
        value: member,
      }),
      deps.redis.zAdd(keys.hats(team), { score: s.hats.length, value: member }),
      deps.redis.hSet(keys.hatList, member, JSON.stringify(s.hats)),
      // The current season's exact total. A later season starts at zero, and only if absent: by the
      // time it starts, the award adds to it.
      deps.redis.zAdd(keys.points(team, season), {
        score: points[member] ?? 0,
        value: member,
      }),
      ...seasonsFrom(event, now)
        .filter((x) => x !== season)
        .map((x) =>
          deps.redis.zAdd(keys.points(team, x), { score: 0, value: member }, { condition: 'NX' })
        ),
      deps.redis.hSet(
        keys.topics,
        Object.fromEntries(
          seasonsFrom(event, now).map((x) => [seasonOwnerTopicId(event.name, s.userId, x), member])
        )
      ),
    ]);
    const opened = await deps.redis.eval(LIST_IF_UNCHANGED, {
      keys: [keys.members],
      arguments: [member, was ?? '', team],
    });
    // Unlisted while this ran: take back what it just wrote.
    if (Number(opened) !== 1) await clearEntries(event, [s.userId], deps);
  }
  return { listed: listed.length, removed };
}

// Everything but the gate: a member's scores, hat list and owner topics.
async function clearEntries(event: RosterEvent, userIds: number[], deps: RosterSyncDeps) {
  if (!userIds.length) return;
  const keys = eventRosterKeys(event.name);
  const members = userIds.map(String);
  await Promise.all([
    deps.redis.hDel(keys.hatList, members),
    deps.redis.hDel(
      keys.topics,
      userIds.flatMap((id) => allTopicIds(event, id))
    ),
    ...event.teams.flatMap((team) => teamKeys(keys, team).map((k) => deps.redis.zRem(k, members))),
  ]);
}

const teamKeys = (keys: ReturnType<typeof eventRosterKeys>, team: string) => [
  keys.joined(team),
  keys.hats(team),
  keys.points(team, 'preview'),
  keys.points(team, 'live'),
];

const allTopicIds = (event: RosterEvent, userId: number) =>
  (['preview', 'live'] as const).map((season) => seasonOwnerTopicId(event.name, userId, season));

// Every sync reads the primary (see syncRosterMembersWith). About 1.6ms a member, measured on prod
// with 16 members, so a 40k reconcile is about a minute of light indexed reads an hour.
export const defaultRosterSyncDeps = (
  db: Pick<typeof dbRead, '$queryRaw'> = dbWrite
): RosterSyncDeps => ({
  redis: sysRedis,
  loadStates: (event, userIds) => loadRosterMemberStates(event, userIds, db),
  ownerPoints: (event, ownerIds, now) => getOwnerPoints(event, ownerIds, now),
  now: () => new Date(),
});

// The events a roster write applies to: those with a join, from their preview to their end.
export async function rosterEvents(now = new Date()): Promise<RosterEvent[]> {
  const events = await loadEvents();
  return events
    .filter((e) => e.scoring && e.join && now >= (e.previewFrom ?? e.startDate) && now < e.endDate)
    .map((e) => ({ name: e.name, startDate: e.startDate, teams: e.teams, join: e.join! }));
}

// For write paths that may change someone's listing (a hat bought or put on, a ban). Never throws: a
// failure only leaves the entry stale until the hourly reconcile. `onlyIfListed` is for changes that
// can alter a listed member's entry but never list anyone (a hat bought or worn): it skips the
// Postgres read for everyone not listed, which is nearly everyone.
export async function syncEventRosterMember(
  userId: number,
  { event: onlyEvent, onlyIfListed = false }: { event?: string; onlyIfListed?: boolean } = {}
) {
  try {
    for (const event of await rosterEvents()) {
      if (onlyEvent && event.name !== onlyEvent) continue;
      if (
        onlyIfListed &&
        !rosterTeam(await sysRedis.hGet(eventRosterKeys(event.name).members, String(userId)))
      )
        continue;
      await syncRosterMembersWith(event, [userId], defaultRosterSyncDeps());
    }
  } catch (error) {
    logRoster('error', 'syncEventRosterMember', { userId, error: (error as Error).message });
  }
}

const RECONCILE_BATCH = 500;

// The hourly safety net: re-derives every listed member, so points the referee re-based, a missed
// hat and a missed ban all come right, and drops tombstones past their use. Only members already
// listed are visited; an opt-in that never reached Redis is recovered by rebuildEventRoster.
export async function reconcileEventRosters(
  deps: RosterSyncDeps & { gate: (event: string) => Promise<Record<string, string>> } = {
    ...defaultRosterSyncDeps(),
    gate: (event) => sysRedis.hGetAll(eventRosterKeys(event).members),
  },
  events?: RosterEvent[]
) {
  for (const event of events ?? (await rosterEvents(deps.now()))) {
    try {
      const gate = await deps.gate(event.name);
      const now = deps.now().getTime();
      const stale = Object.entries(gate)
        .filter(
          ([, v]) =>
            isTombstone(v) && now - Number(v.slice(HIDDEN_PREFIX.length)) > TOMBSTONE_TTL_MS
        )
        .map(([id]) => id);
      if (stale.length) await deps.redis.hDel(eventRosterKeys(event.name).members, stale);
      const ids = Object.entries(gate)
        .filter(([, v]) => rosterTeam(v))
        .map(([id]) => Number(id));
      let listed = 0;
      let removed = 0;
      for (const batch of chunk(ids, RECONCILE_BATCH)) {
        const r = await syncRosterMembersWith(event, batch, deps);
        listed += r.listed;
        removed += r.removed;
      }
      if (removed)
        logRoster('warning', 'reconcileEventRosters', { event: event.name, listed, removed });
    } catch (error) {
      logRoster('error', 'reconcileEventRosters', {
        event: event.name,
        error: (error as Error).message,
      });
    }
  }
}

// Rebuilds an event's roster from User.settings, for when Redis lost it. A full scan of User, so a
// one-off run from scripts/, never a request. Returns how many users had opted in and how many of
// them are listed now.
export async function rebuildEventRoster(
  event: RosterEvent,
  deps: RosterSyncDeps & { optedInUserIds: (event: string) => Promise<number[]> } = {
    ...defaultRosterSyncDeps(),
    optedInUserIds: async (name) =>
      (
        await dbRead.$queryRaw<{ id: number }[]>`
          SELECT id FROM "User" WHERE (settings -> ${ROSTER_SETTING} ->> ${name}) = 'true'
        `
      ).map((r) => r.id),
  }
) {
  const ids = await deps.optedInUserIds(event.name);
  let listed = 0;
  for (const batch of chunk(ids, RECONCILE_BATCH))
    listed += (await syncRosterMembersWith(event, batch, deps)).listed;
  return { optedIn: ids.length, listed };
}

function logRoster(type: 'warning' | 'error', fn: string, extra: object) {
  void logToAxiom({ type, name: 'event-roster', fn, ...extra }).catch(() => undefined);
}
