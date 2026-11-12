import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import type { FlagsConfig } from '~/server/events/scoring/award-results';
import {
  FLAG_KIND,
  flagPot,
  flagTally,
  flagWinners,
  type FlagDayRow,
} from '~/server/events/turf/flag-day';
import { getTurfEvent, turfCatchUpAt } from '~/server/events/turf/turf.service';

// A placement checks the cut when it starts and is stamped then, so it may commit just after the cut.
// The freeze waits this long past the cut so no such hat is left out of what it pays.
export const FLAG_FREEZE_GRACE_MS = 60_000;

const leanOf = (lean: FlagsConfig['lean'], multiplier: number) =>
  lean === 'none' ? 1 : lean === 'sqrt' ? Math.sqrt(multiplier) : multiplier;

/**
 * Freezes every flag whose day has been cut: per flag, the team or tied teams with the most hats
 * placed before the cut (flagTally) split its pot, each share leaned by that team's catch-up at the freeze. Each
 * flag writes a team-less row recording what it was computed from, and one row per winning team;
 * all are inserted in one statement, once, on the primary. A day whose team-less row exists is
 * never computed again, so a later ban or catch-up change can't reprice it. Returns the rows inserted.
 */
export async function freezeFlagDays(
  event: { name: string; startDate: Date },
  flags: FlagsConfig,
  now: Date
) {
  if (!flags.on) return 0;
  const days = await dbWrite.$queryRaw<FlagDayRow[]>`
    SELECT id, "crucibleId", "startsAt", "cutAt", "closesAt", "imageIds" FROM "FlagDay" f
    WHERE f.event = ${event.name} AND f."cutAt" <= ${new Date(now.getTime() - FLAG_FREEZE_GRACE_MS)}
      AND cardinality(f."imageIds") > 0
      AND NOT EXISTS (SELECT 1 FROM "EventAwardResult" r WHERE r.event = f.event
        AND r."sourceId" = 'flag:' || f.id || ':' || f."imageIds"[1])
  `;
  if (!days.length) return 0;
  const turfEvent = await getTurfEvent(event.name, now);

  let inserted = 0;
  for (const day of days) {
    const tally = await flagTally(event, day, dbWrite);

    const rows: Prisma.Sql[] = [];
    for (const imageId of day.imageIds) {
      const hatsByTeam = tally.hats.get(imageId) ?? {};
      const players = tally.players.get(imageId) ?? 0;
      const { pot, step } = flagPot(flags.pot, players, day.cutAt);
      const winners = flagWinners(hatsByTeam);
      const share = winners.length ? pot / winners.length : 0;
      const paid: Record<string, { multiplier: number; points: number }> = {};
      for (const team of winners) {
        const multiplier = turfEvent ? await turfCatchUpAt(turfEvent, team, day.cutAt) : 1;
        paid[team] = { multiplier, points: Math.round(share * leanOf(flags.lean, multiplier)) };
      }
      const inputs = {
        flagDayId: day.id,
        imageId,
        hatsByTeam,
        players,
        pot,
        step,
        lean: flags.lean,
        paid,
      };
      const source = `flag:${day.id}:${imageId}`;
      rows.push(
        Prisma.sql`(${event.name}, ${source}, ${FLAG_KIND}, NULL, 0, ${day.cutAt},
          ${JSON.stringify(inputs)}::jsonb)`
      );
      for (const [team, { points }] of Object.entries(paid))
        rows.push(
          Prisma.sql`(${event.name}, ${`${source}:${team}`}, ${FLAG_KIND}, ${team}, ${points},
            ${day.cutAt}, ${JSON.stringify(inputs)}::jsonb)`
        );
    }
    inserted += await dbWrite.$executeRaw`
      INSERT INTO "EventAwardResult" (event, "sourceId", kind, team, points, at, inputs)
      VALUES ${Prisma.join(rows)}
      ON CONFLICT (event, "sourceId") DO NOTHING
    `;
  }
  return inserted;
}
