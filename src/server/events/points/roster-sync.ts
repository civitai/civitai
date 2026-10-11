import { randomUUID } from 'crypto';
import { chunk } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { loadEvents } from '~/server/events/load-events';
import { eventPointSeason, seasonOwnerTopicId } from '~/server/events/points/keys';
import { getOwnerPoints } from '~/server/events/points/read';
import {
  eventRosterKeys,
  gateTeam,
  LISTED_SEPARATOR,
  TOMBSTONE_PREFIX,
  type RosterHat,
} from '~/server/events/points/roster';
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
    -- The event's decorations, read once: joined per user, Cosmetic would be scanned per user.
    WITH ev AS MATERIALIZED (
      SELECT id, data ->> 'team' AS team, data ->> 'design' AS design
      FROM "Cosmetic"
      WHERE type = 'ContentDecoration' AND data ->> 'event' = ${event.name}
    )
    SELECT u.id AS "userId",
      (u.settings -> ${ROSTER_SETTING} ->> ${event.name}) = 'true' AS "optedIn",
      (u."bannedAt" IS NULL AND u."deletedAt" IS NULL AND NOT u."excludeFromLeaderboards") AS eligible,
      j.team, j."obtainedAt" AS "joinedAt", h.hats
    FROM "User" u
    LEFT JOIN LATERAL (
      SELECT ev.team, uc."obtainedAt"
      FROM "UserCosmetic" uc
      JOIN ev ON ev.id = uc."cosmeticId"
      WHERE uc."userId" = u.id AND uc."claimKey" = ${event.join.claimKey}
        AND ev.design = ${event.join.design}
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
        JOIN ev ON ev.id = uc."cosmeticId"
        WHERE uc."userId" = u.id
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
const HIDDEN_PREFIX = TOMBSTONE_PREFIX;
export const isTombstone = (value: string | null | undefined) =>
  !!value && value.startsWith(HIDDEN_PREFIX);
export const rosterTeam = gateTeam;
const listedValue = (team: string) => `${team}${LISTED_SEPARATOR}${randomUUID().slice(0, 8)}`;
// Tombstones older than this go at the reconcile: long past any sync that read before them.
const TOMBSTONE_TTL_MS = 60 * 60 * 1000;
// A sync that has run this long gives up its writes (see syncRosterMembersWith): far inside the
// tombstone TTL, so nothing it read can have been pruned.
const STALL_MS = 10 * 60 * 1000;
// Unique per write, so every unlisting changes the gate, even two in the same millisecond.
export const tombstone = (at: Date) =>
  `${HIDDEN_PREFIX}${at.getTime()}:${randomUUID().slice(0, 8)}`;
export const tombstoneTime = (value: string) =>
  Number(value.slice(HIDDEN_PREFIX.length).split(':')[0]) || 0;
// Deletes each field (ARGV pairs: field, value) only if it still holds that value.
const DELETE_IF_UNCHANGED = `for i = 1, #ARGV, 2 do
if redis.call('HGET', KEYS[1], ARGV[i]) == ARGV[i + 1] then redis.call('HDEL', KEYS[1], ARGV[i]) end
end
return 0`;
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
// how many entries were removed, for the reconcile's log.
//
// The gate is read before Postgres, and both reads go to the primary: that order is what lets the
// compare-and-set below refuse a sync that read Postgres before an unlisting it has not seen.
export async function syncRosterMembersWith(
  event: RosterEvent,
  userIds: number[],
  deps: RosterSyncDeps,
  attempt = 1
): Promise<{ listed: number; removed: number }> {
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
  // Members whose gate changed under this sync: re-derived from fresh reads below.
  const changed: number[] = [];
  // A sync that stalled so long that the tombstones it might have read could be pruned since
  // treats its listings as refused, and derives again from fresh reads. Unlistings still go: hiding
  // is the safe side, and refusing one could keep a banned member listed.
  const stalled = () => deps.now().getTime() - now.getTime() > STALL_MS;
  const gateWrite = async (userId: number, value: string) => {
    if (!isTombstone(value) && stalled()) return false;
    const opened = await deps.redis.eval(LIST_IF_UNCHANGED, {
      keys: [keys.members],
      arguments: [String(userId), previous.get(userId) ?? '', value],
    });
    return Number(opened) === 1;
  };

  // Unlisting hides before listing writes anything, so no read can pair a remaining score with a
  // listed member.
  // Everyone unlisted gets a fresh tombstone, listed before or not: a ban or an opt-out can land
  // while someone's first opt-in is still in flight, and only a changed gate stops that listing.
  // The reconcile prunes them after TOMBSTONE_TTL_MS.
  // Each member's entries are cleared before its tombstone goes in. Reads filter by the gate, so
  // clearing first can only hide; and a listing that wrote entries after the clear must have read
  // the gate before the tombstone, so its own compare-and-set fails and it derives again, rewriting
  // them. Clearing after the tombstone would wipe such a listing's entries once it had won.
  const closed: number[] = [];
  for (const group of chunk(unlisted, LIST_CONCURRENCY))
    await Promise.all(
      group.map(async (s) => {
        // A failed clear must not stop the hide: the tombstone still goes in, and the gate keeps
        // any leftover entries out of every read.
        await clearEntries(event, [s.userId], deps).catch((error) =>
          logRoster('error', 'syncRosterMembersWith.clear', {
            event: event.name,
            userId: s.userId,
            error: (error as Error).message,
          })
        );
        if (await gateWrite(s.userId, tombstone(now))) closed.push(s.userId);
        else changed.push(s.userId);
      })
    );
  const removed = closed.filter((id) => rosterTeam(previous.get(id))).length;

  // Listing writes the scores first and opens the gate last. Members go LIST_CONCURRENCY at a
  // time: each is a few round trips, and a reconcile lists hundreds a batch.
  const points = listed.length
    ? await deps.ownerPoints(
        event,
        listed.map((s) => s.userId),
        now
      )
    : {};
  for (const group of chunk(listed, LIST_CONCURRENCY))
    await Promise.all(group.map((s) => listOne(s)));

  // The gate moved under these (an opt-in, opt-out, ban or prune landed meanwhile): what this sync
  // read may be stale either way, so derive them again from fresh reads. After MAX_SYNC_ATTEMPTS
  // the member is left hidden, which is the side to fail on.
  let retried = { listed: 0, removed: 0 };
  if (changed.length && attempt < MAX_SYNC_ATTEMPTS)
    retried = await syncRosterMembersWith(event, changed, deps, attempt + 1);
  else if (changed.length) {
    const current = await deps.redis.hmGet(keys.members, changed.map(String));
    // Only hides: the gate already keeps leftovers out of every read, so a failed clear is logged.
    await clearEntries(
      event,
      changed.filter((_, i) => !rosterTeam(current[i])),
      deps
    ).catch((error) =>
      logRoster('error', 'syncRosterMembersWith.giveUpClear', {
        event: event.name,
        error: (error as Error).message,
      })
    );
    logRoster('warning', 'syncRosterMembersWith', { event: event.name, gaveUp: changed.length });
  }
  return {
    listed:
      listed.length -
      changed.filter((id) => listed.some((s) => s.userId === id)).length +
      retried.listed,
    removed: removed + retried.removed,
  };

  async function listOne(s: RosterMemberState) {
    const team = s.team!;
    const member = String(s.userId);
    const wasTeam = rosterTeam(previous.get(s.userId));
    if (wasTeam && wasTeam !== team)
      await Promise.all(teamKeys(keys, wasTeam).map((k) => deps.redis.zRem(k, member)));
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
    if (!(await gateWrite(s.userId, listedValue(team)))) changed.push(s.userId);
  }
}
const LIST_CONCURRENCY = 25;
// How many times a member whose gate keeps moving is derived again before being left hidden.
const MAX_SYNC_ATTEMPTS = 3;

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

// Every sync reads the primary (see syncRosterMembersWith). The member query measured 105-443ms per
// 500 users on the prod replica (2026-10), so a 40k reconcile is roughly 10-35s of reads.
export const defaultRosterSyncDeps = (
  db: Pick<typeof dbRead, '$queryRaw'> = dbWrite
): RosterSyncDeps => ({
  redis: sysRedis,
  loadStates: (event, userIds) => loadRosterMemberStates(event, userIds, db),
  ownerPoints: (event, ownerIds, now) => getOwnerPoints(event, ownerIds, now),
  now: () => new Date(),
});

// The events a roster write applies to: those with a join, from their preview on. No end: a roster
// stays readable after its event, so a ban or an opt-out then must still take a member off it.
export async function rosterEvents(now = new Date()): Promise<RosterEvent[]> {
  const events = await loadEvents();
  return events
    .filter((e) => e.scoring && e.join && now >= (e.previewFrom ?? e.startDate))
    .map((e) => ({
      name: e.name,
      startDate: e.startDate,
      teams: e.teams,
      join: e.join!,
    }));
}

// For write paths that may change someone's listing (a hat bought or put on, a ban). Never throws: a
// failure only leaves the entry stale until the hourly reconcile. `onlyIfListed` is for changes that
// can alter a listed member's entry but never list anyone (a hat bought or worn): it skips the
// Postgres read for everyone not listed, which is nearly everyone.
export function syncEventRosterMember(userId: number, options: SyncMembersOptions = {}) {
  return syncEventRosterMembers([userId], options);
}

type SyncMembersOptions = { event?: string; onlyIfListed?: boolean };

// The same for many users at once (a bulk takedown): one gate read and RECONCILE_BATCH users per
// Postgres query, one batch at a time, instead of a sync per user all at once.
export async function syncEventRosterMembers(
  userIds: number[],
  { event: onlyEvent, onlyIfListed = false }: SyncMembersOptions = {},
  deps: RosterSyncDeps = defaultRosterSyncDeps(),
  events?: RosterEvent[]
) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  let all: RosterEvent[];
  try {
    all = events ?? (await rosterEvents());
  } catch (error) {
    logRoster('error', 'syncEventRosterMembers', { error: (error as Error).message });
    return;
  }
  // One event's failure must not skip the others: a ban still has to reach every roster.
  for (const event of all) {
    if (onlyEvent && event.name !== onlyEvent) continue;
    try {
      let todo = ids;
      if (onlyIfListed) {
        const gate = await deps.redis.hmGet(eventRosterKeys(event.name).members, ids.map(String));
        todo = ids.filter((_, i) => rosterTeam(gate[i]));
      }
      for (const batch of chunk(todo, RECONCILE_BATCH))
        await syncRosterMembersWith(event, batch, deps);
    } catch (error) {
      logRoster('error', 'syncEventRosterMembers', {
        event: event.name,
        users: ids.length,
        error: (error as Error).message,
      });
    }
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
  events?: RosterEvent[],
  // Stop starting batches after this (ms since epoch), for a caller holding a lock. What is left
  // is the hourly run's.
  { deadline = Infinity }: { deadline?: number } = {}
) {
  let complete = true;
  for (const event of events ?? (await rosterEvents(deps.now()))) {
    try {
      const gate = await deps.gate(event.name);
      const now = deps.now().getTime();
      const stale = Object.entries(gate)
        .filter(([, v]) => isTombstone(v) && now - tombstoneTime(v) > TOMBSTONE_TTL_MS)
        .map(([id]) => id);
      // Each only if it still holds the tombstone read: a sync may have listed them since.
      if (stale.length)
        await deps.redis.eval(DELETE_IF_UNCHANGED, {
          keys: [eventRosterKeys(event.name).members],
          arguments: stale.flatMap((id) => [id, gate[id]]),
        });
      const ids = Object.entries(gate)
        .filter(([, v]) => rosterTeam(v))
        .map(([id]) => Number(id));
      let listed = 0;
      let removed = 0;
      for (const batch of chunk(ids, RECONCILE_BATCH)) {
        if (deps.now().getTime() >= deadline) {
          complete = false;
          break;
        }
        const r = await syncRosterMembersWith(event, batch, deps);
        listed += r.listed;
        removed += r.removed;
      }
      if (removed)
        logRoster('warning', 'reconcileEventRosters', { event: event.name, listed, removed });
    } catch (error) {
      complete = false;
      logRoster('error', 'reconcileEventRosters', {
        event: event.name,
        error: (error as Error).message,
      });
    }
  }
  return { complete };
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
