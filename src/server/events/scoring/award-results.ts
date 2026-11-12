import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import type { TeamAward } from '~/server/events/base.event';
import { eventPlayerEligibleSql } from '~/server/events/player-eligibility';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

export const CRUCIBLE_PLACE_KIND = 'crucible-place';

/** Crucibles whose places the event file pays by hand (`scoring.teamAwards`): never frozen too. */
export const HAND_PAID_CRUCIBLES: Record<string, readonly number[]> = {
  birthday2026: [254, 255, 256],
};

// Its own key, not a field of the turf override: one that fails to parse can't revert the turf
// config, and a bad turf override can't stop a freeze.
export const flagRaceConfigKey = (event: string) =>
  `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}:flagRace:config` as const;

export const flagRaceConfigSchema = z.object({
  mode: z.enum(['off', 'shadow', 'live']).default('off'),
  placements: z
    .object({
      // Off stops new freezes only: results already frozen keep counting.
      on: z.boolean(),
      // Points per place, first place first. A place past the list earns nothing.
      crucibles: z.array(
        z.object({
          id: z.number().int().positive(),
          prizes: z.array(z.number().int().nonnegative()).min(1).max(10),
        })
      ),
    })
    .optional(),
  flags: z
    .object({
      // Off stops new swaps and freezes; flags already frozen keep counting.
      on: z.boolean(),
      // The Collection the home block shows. Only the swap writes to it.
      homeCollectionId: z.number().int().positive(),
      size: z.number().int().min(1).max(10).default(10),
      // The pot per distinct participant: the step whose `from` is latest at or before the flag's cut
      // applies, read once at its freeze, so a new step never reprices a frozen flag.
      pot: z.object({
        steps: z
          .array(
            z.object({
              from: z.coerce.date(),
              perPerson: z.number().int().nonnegative(),
              upTo: z.number().int().nonnegative(),
              after: z.number().int().nonnegative(),
            })
          )
          .min(1),
        cap: z.number().int().positive(),
      }),
      // How strongly the winner's points lean toward the team behind: the turf catch-up
      // multiplier, its square root, or none.
      lean: z.enum(['full', 'sqrt', 'none']).default('sqrt'),
    })
    .optional(),
});
export type FlagRaceConfig = z.infer<typeof flagRaceConfigSchema>;
export type FlagsConfig = NonNullable<FlagRaceConfig['flags']>;

const OFF: FlagRaceConfig = { mode: 'off' };

/** The live flagRace key. Missing or unparseable reads as off, so nothing new is frozen. */
export async function readFlagRaceConfig(event: string): Promise<FlagRaceConfig> {
  const raw = await sysRedis.get(flagRaceConfigKey(event));
  if (!raw) return OFF;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = flagRaceConfigSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  logToAxiom({ type: 'error', name: 'flag-race-config-invalid', event, raw }).catch(() => null);
  return OFF;
}

type FreezeEvent = {
  name: string;
  startDate: Date;
  endDate: Date;
  teams: readonly string[];
  join?: { claimKey: string; design: string };
};

type PlaceRow = {
  crucibleId: number;
  endAt: Date;
  position: number;
  userId: number;
  team: string | null;
  eligible: boolean;
};

/**
 * Freezes the places of each listed Crucible that has completed: one row per paid place, on the
 * primary, inserted once. The team is the entrant's at this moment and never read again. Returns the
 * rows inserted (0 on a rerun).
 */
export async function freezeCruciblePlacements(event: FreezeEvent, config: FlagRaceConfig) {
  const { placements } = config;
  const join = event.join;
  if (!placements?.on || !join) return 0;
  const handPaid = new Set(HAND_PAID_CRUCIBLES[event.name] ?? []);
  const prizesById = new Map(
    placements.crucibles.filter((c) => !handPaid.has(c.id)).map((c) => [c.id, c.prizes])
  );
  if (!prizesById.size) return 0;
  const maxPlace = Math.max(...[...prizesById.values()].map((p) => p.length));

  const places = await dbWrite.$queryRaw<PlaceRow[]>`
    SELECT cr.id AS "crucibleId", cr."endAt", ce.position, ce."userId",
      (SELECT c.data->>'team' FROM "UserCosmetic" uc JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
        WHERE uc."userId" = u.id
          AND c.type = 'ContentDecoration'
          AND uc."claimKey" = ${join.claimKey}
          AND c.data->>'event' = ${event.name}
          AND c.data->>'design' = ${join.design}
          AND c.data->>'team' IS NOT NULL
        ORDER BY uc."obtainedAt", c.id
        LIMIT 1) AS team,
      ${eventPlayerEligibleSql(event.startDate)} AS eligible
    FROM "Crucible" cr
    JOIN "CrucibleEntry" ce ON ce."crucibleId" = cr.id
    JOIN "User" u ON u.id = ce."userId"
    WHERE cr.id IN (${Prisma.join([...prizesById.keys()])})
      AND cr.status = 'Completed'::"CrucibleStatus"
      AND cr."endAt" >= ${event.startDate} AND cr."endAt" < ${event.endDate}
      AND ce.position BETWEEN 1 AND ${maxPlace}
  `;

  const rows = places.flatMap((p) => {
    const prize = prizesById.get(p.crucibleId)?.[p.position - 1];
    if (prize === undefined) return [];
    const team = p.eligible && p.team && event.teams.includes(p.team) ? p.team : null;
    return [
      Prisma.sql`(${event.name}, ${`crucible:${p.crucibleId}:place:${p.position}`},
        ${CRUCIBLE_PLACE_KIND}, ${team}, ${team ? prize : 0}, ${p.endAt},
        ${JSON.stringify({ ...p, prize })}::jsonb)`,
    ];
  });
  if (!rows.length) return 0;
  return dbWrite.$executeRaw`
    INSERT INTO "EventAwardResult" (event, "sourceId", kind, team, points, at, inputs)
    VALUES ${Prisma.join(rows)}
    ON CONFLICT (event, "sourceId") DO NOTHING
  `;
}

/** Every frozen, unvoided award that pays a team. Rows never change once written, so any db reads them. */
export async function loadAwardResults(
  event: { name: string },
  db: typeof dbRead | typeof dbWrite = dbRead
): Promise<TeamAward[]> {
  const rows = await db.$queryRaw<{ team: string; points: number; at: Date; sourceId: string }[]>`
    SELECT team, points, at, "sourceId" FROM "EventAwardResult"
    WHERE event = ${event.name} AND "voidedAt" IS NULL AND team IS NOT NULL AND points > 0
  `;
  return rows.map((r) => ({ team: r.team, points: r.points, at: r.at, reason: r.sourceId }));
}

/**
 * The settle's freeze step. A failure is logged and skipped: nothing is lost, the next settle freezes
 * it, and the award still counts from its own date.
 */
export async function freezeEventAwards(event: FreezeEvent, now = new Date()) {
  try {
    const config = await readFlagRaceConfig(event.name);
    const places = await freezeCruciblePlacements(event, config);
    if (!config.flags) return places;
    const { freezeFlagDays } = await import('~/server/events/turf/flag-freeze');
    return places + (await freezeFlagDays(event, config.flags, now));
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'event-award-freeze-failed',
      event: event.name,
      error,
    }).catch(() => null);
    return 0;
  }
}
