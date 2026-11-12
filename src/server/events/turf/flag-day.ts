import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import { dbWrite } from '~/server/db/client';
import type { FlagsConfig } from '~/server/events/scoring/award-results';
import { logToAxiom } from '~/server/logging/client';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';

/** The event tag that makes a Crucible a flag Crucible: its top places become the next day's flags. */
export const flagCrucibleTag = (event: string) => `${event}-flag`;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A flag day's cut: a random moment in the hour before the next swap (a day after its Crucible ended),
 * or before the event ends if that comes first. Random so nobody can time a last-second pile-on.
 */
export function pickCutAt(crucibleEndAt: Date, eventEnd: Date, random = randomInt) {
  const close = Math.min(crucibleEndAt.getTime() + DAY_MS, eventEnd.getTime());
  return new Date(close - 1 - random(HOUR_MS));
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
  imageIds: number[];
};

/** The flag day showing now: the latest one started. Closed once its cutAt has passed. */
export async function currentFlagDay(event: string, now: Date): Promise<FlagDayRow | undefined> {
  const [row] = await dbWrite.$queryRaw<FlagDayRow[]>`
    SELECT id, "crucibleId", "startsAt", "cutAt", "imageIds" FROM "FlagDay"
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
      AND NOT EXISTS (SELECT 1 FROM "FlagDay" f WHERE f.event = ${event.name}
        AND f."crucibleId" = cr.id)
    ORDER BY cr."endAt" DESC LIMIT 1
  `;
  if (!crucible) return undefined;

  const top = await dbWrite.$queryRaw<{ imageId: number }[]>`
    SELECT ce."imageId" FROM "CrucibleEntry" ce
    JOIN "Image" i ON i.id = ce."imageId"
    JOIN "Post" p ON p.id = i."postId"
    JOIN "User" o ON o.id = i."userId"
    WHERE ce."crucibleId" = ${crucible.id} AND ce.position BETWEEN 1 AND ${flags.size}
      AND i."nsfwLevel" IN (1, 2)
      AND p."publishedAt" <= now() AND p.availability <> 'Private'
      AND i.ingestion = 'Scanned' AND NOT i."tosViolation" AND i."needsReview" IS NULL
      AND i."blockedFor" IS NULL AND o."bannedAt" IS NULL AND o."deletedAt" IS NULL
    ORDER BY ce.position
  `;
  const imageIds = [...new Set(top.map((r) => r.imageId))];
  const cutAt = pickCutAt(crucible.endAt, event.endDate);

  const day = await dbWrite.$transaction(async (tx) => {
    const [made] = await tx.$queryRaw<FlagDayRow[]>`
      INSERT INTO "FlagDay" (event, "crucibleId", "startsAt", "cutAt", "imageIds")
      VALUES (${event.name}, ${crucible.id}, ${now}, ${cutAt}, ${imageIds}::int[])
      ON CONFLICT (event, "crucibleId") DO NOTHING
      RETURNING id, "crucibleId", "startsAt", "cutAt", "imageIds"
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
