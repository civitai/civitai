import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import type { FlagsConfig } from '~/server/events/scoring/award-results';
import { eventPlayerEligibleSql } from '~/server/events/player-eligibility';
import { imageVisible, ownerActive } from '~/server/events/turf/turf-sql';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';

/** The award kind of a frozen flag result in EventAwardResult. */
export const FLAG_KIND = 'flag';

/** The cached flag summary (getFlagSummary). A swap clears it, so a cached closed day never hides the new one. */
export const flagSummaryKey = (event: string) =>
  `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}:flagRace:summary` as const;
/** Counts swaps: a cached summary built before the latest one is stale. */
export const flagSummaryGenKey = (event: string) => `${flagSummaryKey(event)}:gen` as const;

/** The event tag that makes a Crucible a flag Crucible: its top places become the next day's flags. */
export const flagCrucibleTag = (event: string) => `${event}-flag`;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A flag day's cut: a random moment in the hour before the next swap (a day after its Crucible ended),
 * or before the event ends if that comes first. Random so nobody can time a last-second pile-on.
 */
export function flagCloseAt(crucibleEndAt: Date, eventEnd: Date) {
  return new Date(Math.min(crucibleEndAt.getTime() + DAY_MS, eventEnd.getTime()));
}
export function pickCutAt(crucibleEndAt: Date, eventEnd: Date, random = randomInt) {
  return new Date(flagCloseAt(crucibleEndAt, eventEnd).getTime() - 1 - random(HOUR_MS));
}

type PotSteps = FlagsConfig['pot'];

/** The pot a flag with `participants` distinct players carries under the step live at `at`. */
export function flagPot(pot: PotSteps, participants: number, at: Date) {
  const step = [...pot.steps]
    .filter((s) => s.from.getTime() <= at.getTime())
    .sort((a, b) => b.from.getTime() - a.from.getTime())[0];
  if (!step) return { pot: 0, step: undefined };
  const early = Math.min(participants, step.upTo);
  const late = Math.max(0, participants - step.upTo);
  return { pot: Math.min(pot.cap, early * step.perPerson + late * step.after), step };
}

/** The teams with the most hats on a flag; all of them when tied, none when no hats. */
export function flagWinners(hatsByTeam: Record<string, number>) {
  const most = Math.max(0, ...Object.values(hatsByTeam));
  if (most === 0) return [];
  return Object.keys(hatsByTeam)
    .filter((t) => hatsByTeam[t] === most)
    .sort();
}

export type FlagDayRow = {
  id: number;
  crucibleId: number;
  startsAt: Date;
  cutAt: Date;
  closesAt: Date;
  imageIds: number[];
};

/** The flag day showing now: the latest one started. Closed once its cutAt has passed. */
export async function currentFlagDay(event: string, now: Date): Promise<FlagDayRow | undefined> {
  const [row] = await dbWrite.$queryRaw<FlagDayRow[]>`
    SELECT id, "crucibleId", "startsAt", "cutAt", "closesAt", "imageIds" FROM "FlagDay"
    WHERE event = ${event} AND "startsAt" <= ${now}
    ORDER BY "startsAt" DESC LIMIT 1
  `;
  return row;
}

/**
 * Turns the latest finished flag Crucible into the next flag day: its top places, in rank order, kept
 * only while the image is still visible and rated PG or PG-13 now (entries get re-rated after they
 * enter). Writes the FlagDay once, then makes those images the home Collection's only items. A rerun
 * finds the FlagDay and changes nothing. Returns the new day, if one was made.
 */
export async function swapFlagDay(
  event: { name: string; endDate: Date },
  flags: FlagsConfig,
  now: Date
) {
  if (!flags.on || now >= event.endDate) return undefined;
  const [crucible] = await dbWrite.$queryRaw<{ id: number; endAt: Date }[]>`
    SELECT cr.id, cr."endAt" FROM "Crucible" cr
    WHERE cr.status = 'Completed'::"CrucibleStatus"
      AND cr."eventTags" @> ARRAY[${flagCrucibleTag(event.name)}]::text[]
      AND cr."endAt" > ${new Date(now.getTime() - DAY_MS)} AND cr."endAt" <= ${now}
      -- Not one already swapped, and never back to a Crucible older than the one showing: a late or missed pass must not
      -- replace a newer flag day.
      AND NOT EXISTS (SELECT 1 FROM "FlagDay" f JOIN "Crucible" c2 ON c2.id = f."crucibleId"
        WHERE f.event = ${event.name} AND c2."endAt" >= cr."endAt")
    ORDER BY cr."endAt" DESC LIMIT 1
  `;
  if (!crucible) return undefined;

  const top = await dbWrite.$queryRaw<{ imageId: number }[]>`
    SELECT ce."imageId" FROM "CrucibleEntry" ce
    JOIN "Image" i ON i.id = ce."imageId"
    JOIN "Post" p ON p.id = i."postId"
    JOIN "User" o ON o.id = i."userId"
    WHERE ce."crucibleId" = ${crucible.id} AND ce.position BETWEEN 1 AND ${flags.size}
      AND i."nsfwLevel" IN (1, 2) AND ${imageVisible} AND ${ownerActive}
    ORDER BY ce.position
  `;
  const imageIds = [...new Set(top.map((r) => r.imageId))];
  const cutAt = pickCutAt(crucible.endAt, event.endDate);
  const closesAt = flagCloseAt(crucible.endAt, event.endDate);

  const day = await dbWrite.$transaction(async (tx) => {
    const [made] = await tx.$queryRaw<FlagDayRow[]>`
      INSERT INTO "FlagDay" (event, "crucibleId", "startsAt", "cutAt", "closesAt", "imageIds")
      VALUES (${event.name}, ${crucible.id}, ${now}, ${cutAt}, ${closesAt}, ${imageIds}::int[])
      ON CONFLICT (event, "crucibleId") DO NOTHING
      RETURNING id, "crucibleId", "startsAt", "cutAt", "closesAt", "imageIds"
    `;
    if (!made) return undefined;
    await tx.$executeRaw`DELETE FROM "CollectionItem" WHERE "collectionId" = ${flags.homeCollectionId}`;
    if (imageIds.length) {
      // Newest first is first on the row, so rank 1 gets the latest createdAt.
      const rows = imageIds.map(
        (imageId, rank) =>
          Prisma.sql`(${flags.homeCollectionId}, ${imageId}, 'ACCEPTED'::"CollectionItemStatus",
            ${new Date(now.getTime() - rank)})`
      );
      await tx.$executeRaw`
        INSERT INTO "CollectionItem" ("collectionId", "imageId", status, "createdAt")
        VALUES ${Prisma.join(rows)}
      `;
    }
    return made;
  });
  if (!day) return undefined;
  await homeBlockCacheBust(HomeBlockType.Collection, flags.homeCollectionId).catch((error) =>
    logToAxiom({ type: 'error', name: 'flag-race-swap', message: 'cache bust failed', error })
  );
  await Promise.all([
    sysRedis.incr(flagSummaryGenKey(event.name)),
    sysRedis.del(flagSummaryKey(event.name)),
  ]).catch((error) =>
    logToAxiom({ type: 'error', name: 'flag-race-swap', message: 'summary bust failed', error })
  );
  void logToAxiom({
    type: 'info',
    name: 'flag-race-swap',
    event: event.name,
    flagDayId: day.id,
    crucibleId: crucible.id,
    flags: imageIds.length,
  }).catch(() => null);
  return day;
}

export type FlagTally = {
  hats: Map<number, Record<string, number>>;
  players: Map<number, number>;
};

/**
 * Per flag, the hats each team placed before the cut and the distinct players who placed them,
 * counting only players eligible for event points (no alts, banned or excluded accounts). The badge
 * and the freeze both read this, so what the row shows is what gets paid.
 */
export async function flagTally(
  event: { startDate: Date },
  day: Pick<FlagDayRow, 'id' | 'cutAt'>,
  db: typeof dbRead | typeof dbWrite = dbRead,
  imageId?: number
): Promise<FlagTally> {
  const oneFlag = imageId === undefined ? Prisma.empty : Prisma.sql`AND s."imageId" = ${imageId}`;
  // Summed per player first, so each player's eligibility is read once, not once per placement.
  const rows = await db.$queryRaw<
    { imageId: number; team: string | null; hats: number; players: number }[]
  >`
    SELECT p."imageId", p.team, SUM(p.hats)::int AS hats, COUNT(DISTINCT p."userId")::int AS players
    FROM (
      SELECT s."imageId", s.team, s."userId", SUM(s.count) AS hats
      FROM "EventTurfFlagSticker" s
      WHERE s."flagDayId" = ${day.id} AND s."createdAt" < ${day.cutAt} ${oneFlag}
      GROUP BY s."imageId", s.team, s."userId"
    ) p
    JOIN "User" u ON u.id = p."userId"
    WHERE ${eventPlayerEligibleSql(event.startDate)}
    GROUP BY GROUPING SETS ((p."imageId", p.team), (p."imageId"))
  `;
  const tally: FlagTally = { hats: new Map(), players: new Map() };
  for (const r of rows) {
    if (r.team === null) {
      tally.players.set(r.imageId, r.players);
      continue;
    }
    const byTeam = tally.hats.get(r.imageId) ?? {};
    byTeam[r.team] = r.hats;
    tally.hats.set(r.imageId, byTeam);
  }
  return tally;
}
