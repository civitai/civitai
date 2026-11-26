import { Prisma } from '@prisma/client';
import * as z from 'zod';
import type { dbRead } from '~/server/db/client';
import { dbWrite } from '~/server/db/client';
import {
  eventPlayerEligibleSql,
  eventPointsExcludedFromSql,
} from '~/server/events/player-eligibility';
import { logToAxiom } from '~/server/logging/client';
import { UserFlag } from '~/shared/constants/user-flags.constants';

export const COMEBACK_KIND = 'comeback';
const COMEBACK_SOURCE = 'comeback:result';
const DAY_MS = 24 * 60 * 60 * 1000;

const isUtcMidnight = (d: Date) => d.getTime() % DAY_MS === 0;
const dayWindow = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((w) => w.from < w.to && isUtcMidnight(w.from) && isUtcMidnight(w.to), {
    message: 'a window runs from one UTC midnight to a later one',
  });
type DayWindow = z.infer<typeof dayWindow>;
const prizeMode = z.enum(['off', 'shadow', 'live']);

// The `prizes` field of the flagRace key. Shadow computes and logs but grants nothing, and leaves
// the event's cleanup open so it runs again the next day.
export const eventPrizesSchema = z.object({
  champion: z
    .object({
      mode: prizeMode,
      // Team -> the badge cosmetic in its colour.
      badges: z.record(z.string(), z.number().int().positive()),
    })
    .optional(),
  comeback: z
    .object({
      mode: prizeMode,
      baseline: dayWindow,
      week: dayWindow,
      // A team averaging less than this per baseline day is measured against it instead.
      floorPerDay: z.number().int().positive(),
      badge: z.number().int().positive(),
    })
    .optional(),
});
export type EventPrizes = z.infer<typeof eventPrizesSchema>;
export type ComebackConfig = NonNullable<EventPrizes['comeback']>;

/**
 * The `prizes` field of the flagRace key's JSON; invalid throws. Undefined when the field is absent: a
 * scored event must say what it awards, even if that is nothing (`{}`), before its cleanup can end.
 */
export function parseEventPrizes(flagRaceJson: unknown): EventPrizes | undefined {
  const prizes = (flagRaceJson as { prizes?: unknown } | undefined)?.prizes;
  return prizes === undefined ? undefined : eventPrizesSchema.parse(prizes);
}

const daysIn = (w: DayWindow) => (w.to.getTime() - w.from.getTime()) / DAY_MS;

export type ComebackTeam = { team: string; baseline: number; week: number };
type CupWindows = Pick<ComebackConfig, 'baseline' | 'week' | 'floorPerDay'>;

/**
 * Each team's week per day over its own baseline per day, the baseline raised to the floor. Compared
 * exactly, cross-multiplied in BigInt (every team's week is the same length); every team on the
 * highest ratio wins. A team with no points in the week can't win.
 */
export function comebackCup(
  teams: ComebackTeam[],
  { baseline, week, floorPerDay }: CupWindows,
  // The days the week points were earned over: the whole week, or the part of it played so far.
  weekDays = daysIn(week)
) {
  const baselineDays = daysIn(baseline);
  const floor = BigInt(floorPerDay) * BigInt(baselineDays);
  const scored = teams.map((t) => {
    const total = BigInt(t.baseline);
    return { ...t, denominator: total > floor ? total : floor };
  });
  let winners: typeof scored = [];
  for (const t of scored) {
    if (t.week <= 0) continue;
    const best = winners[0];
    const diff = best ? BigInt(t.week) * best.denominator - BigInt(best.week) * t.denominator : 1n;
    if (diff > 0n) winners = [t];
    else if (diff === 0n) winners.push(t);
  }
  return {
    winners: winners.map((w) => w.team).sort(),
    teams: scored.map(({ team, baseline: b, week: w, denominator }) => ({
      team,
      baseline: b,
      week: w,
      ratio: w / weekDays / (Number(denominator) / baselineDays),
    })),
  };
}

export type PrizeEvent = { name: string; startDate: Date; endDate: Date; teams: readonly string[] };

// Play points only, from the daily snapshot. A user flagged ExcludeFromEventPoints counts for no day,
// whatever their exclusion start; the standings still count their days before it.
export async function comebackTeams(
  event: PrizeEvent,
  { baseline, week }: CupWindows,
  db: typeof dbRead | typeof dbWrite = dbWrite
) {
  const rows = await db.$queryRaw<{ team: string; baseline: bigint; week: bigint }[]>`
    SELECT d.team,
      COALESCE(sum(d.points) FILTER (WHERE d.day >= ${baseline.from}::date AND d.day < ${
    baseline.to
  }::date), 0)::bigint AS baseline,
      COALESCE(sum(d.points) FILTER (WHERE d.day >= ${week.from}::date AND d.day < ${
    week.to
  }::date), 0)::bigint AS week
    FROM "EventCosmeticScoreDaily" d
    JOIN "User" u ON u.id = d."userId"
    WHERE d.event = ${event.name}
      AND d.day < COALESCE(${eventPointsExcludedFromSql()}, 'infinity'::date)
      AND (u.flags & ${UserFlag.ExcludeFromEventPoints}::int) = 0
    GROUP BY d.team
  `;
  const byTeam = new Map(rows.map((r) => [r.team, r]));
  return event.teams.map((team) => ({
    team,
    baseline: Number(byTeam.get(team)?.baseline ?? 0),
    week: Number(byTeam.get(team)?.week ?? 0),
  }));
}

type CupInputs = ReturnType<typeof comebackCup> & {
  baseline: DayWindow;
  week: DayWindow;
  floorPerDay: number;
};
const sameWindow = (a: { from: string | Date; to: string | Date }, b: DayWindow) =>
  new Date(a.from).getTime() === b.from.getTime() && new Date(a.to).getTime() === b.to.getTime();

/**
 * Freezes the Cup once, as a team-less, zero-point award row, so it can never count toward a total.
 * Returns the frozen winners; throws when the config's windows no longer match the frozen ones.
 */
export async function freezeComebackCup(event: PrizeEvent, config: CupWindows) {
  const result = comebackCup(await comebackTeams(event, config), config);
  const inputs: CupInputs = { ...result, ...config };
  await dbWrite.$executeRaw`
    INSERT INTO "EventAwardResult" (event, "sourceId", kind, team, points, at, inputs)
    VALUES (${event.name}, ${COMEBACK_SOURCE}, ${COMEBACK_KIND}, NULL, 0, ${config.week.to},
      ${JSON.stringify(inputs)}::jsonb)
    ON CONFLICT (event, "sourceId") DO NOTHING
  `;
  const [frozen] = await dbWrite.$queryRaw<{ inputs: CupInputs }[]>`
    SELECT inputs FROM "EventAwardResult"
    WHERE event = ${event.name} AND "sourceId" = ${COMEBACK_SOURCE} AND "voidedAt" IS NULL
  `;
  if (!frozen) throw new Error('The Comeback Cup result is voided');
  if (
    !sameWindow(frozen.inputs.baseline, config.baseline) ||
    !sameWindow(frozen.inputs.week, config.week)
  )
    throw new Error('The Comeback Cup was frozen with other windows');
  return frozen.inputs.winners;
}

type ScorerBadge = { cosmeticId: number; teams: string[] } & DayWindow;

const scorers = (event: PrizeEvent, { teams, from, to }: ScorerBadge) => Prisma.sql`
  SELECT u.id FROM "User" u
  WHERE u.id IN (
      SELECT d."userId" FROM "EventCosmeticScoreDaily" d
      WHERE d.event = ${event.name} AND d.team IN (${Prisma.join(teams)})
        AND d.day >= ${from}::date AND d.day < ${to}::date
      GROUP BY d."userId" HAVING sum(d.points) > 0
    )
    AND ${eventPlayerEligibleSql(event.startDate)}
`;

/**
 * The badge to every player of the teams whose hats earned points in the window, still eligible now.
 * Returns the badges granted; a rerun grants none twice.
 */
export async function grantScorerBadge(event: PrizeEvent, badge: ScorerBadge) {
  if (!badge.teams.length) return 0;
  return dbWrite.$executeRaw`
    INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "obtainedAt")
    SELECT id, ${badge.cosmeticId}, now() FROM (${scorers(event, badge)}) s
    ON CONFLICT ("userId", "cosmeticId", "claimKey") DO NOTHING
  `;
}

async function countScorers(event: PrizeEvent, badge: ScorerBadge) {
  if (!badge.teams.length) return 0;
  const [row] = await dbWrite.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (${scorers(event, badge)}) s
  `;
  return row?.n ?? 0;
}

/**
 * The end-of-event prizes, run by the event cleanup once the winner is named. An invalid config throws;
 * `pending` means a prize is in shadow or none is configured yet. Either way the cleanup stays open.
 */
export async function awardEventPrizes(event: PrizeEvent, winner: string, flagRaceJson: unknown) {
  const prizes = parseEventPrizes(flagRaceJson);
  if (!prizes) {
    logToAxiom({
      type: 'info',
      name: 'event-prizes',
      event: event.name,
      message: 'not configured',
    });
    return { pending: true };
  }
  const { champion, comeback } = prizes;
  const report: Record<string, unknown> = {};
  let pending = false;

  if (champion && champion.mode !== 'off') {
    const cosmeticId = champion.badges[winner];
    if (!cosmeticId) throw new Error(`No Champion badge configured for ${winner}`);
    const badge = { cosmeticId, teams: [winner], from: event.startDate, to: event.endDate };
    if (champion.mode === 'live')
      report.champion = { granted: await grantScorerBadge(event, badge) };
    else {
      pending = true;
      report.champion = { shadow: true, recipients: await countScorers(event, badge) };
    }
  }

  if (comeback && comeback.mode !== 'off') {
    if (comeback.mode === 'live') {
      const winners = await freezeComebackCup(event, comeback);
      const badge = { cosmeticId: comeback.badge, teams: winners, ...comeback.week };
      report.comeback = { winners, granted: await grantScorerBadge(event, badge) };
    } else {
      pending = true;
      const result = comebackCup(await comebackTeams(event, comeback), comeback);
      const badge = { cosmeticId: comeback.badge, teams: result.winners, ...comeback.week };
      report.comeback = { shadow: true, ...result, recipients: await countScorers(event, badge) };
    }
  }

  if (champion || comeback)
    logToAxiom({ type: 'info', name: 'event-prizes', event: event.name, payload: report });
  return { pending };
}
