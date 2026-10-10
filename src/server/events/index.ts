import dayjs from '~/shared/utils/dayjs';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { DonationCosmeticData, EngagementEvent, TeamScore } from '~/server/events/base.event';
import type { EventAccess, EventViewer } from '~/server/events/event-access';
import {
  canPlayEvent,
  canReadEvent,
  getEventAccess,
  getEventScoringPhase,
} from '~/server/events/event-access';
import { birthday2026 } from '~/server/events/birthday2026.event';
import { holiday2024 } from '~/server/events/holiday2024.event';
import { eventPointSeason, eventPointsWindow } from '~/server/events/points/keys';
import { isEventPointsEnabled } from '~/server/events/points/enabled';
import { runEventPointsReferee } from '~/server/events/points/referee';
import { syncEventHats } from '~/server/events/points/sync';
import {
  getEventStandings,
  getTeamScoreHistory as getScoredTeamScoreHistory,
  hasStandingsSnapshot,
  refreshStandings,
} from '~/server/events/scoring/cosmetic-placement.service';
import { discord } from '~/server/integrations/discord';
import { logToAxiom } from '~/server/logging/client';
import {
  redis,
  REDIS_KEYS,
  REDIS_SUB_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { TeamScoreHistoryInput } from '~/server/schema/event.schema';
import {
  createBuzzTransaction,
  getAccountSummary,
  getTopContributors,
  getUserBuzzAccount,
} from '~/server/services/buzz.service';
import { updateLeaderboardRank } from '~/server/services/user.service';
import { cosmeticCache } from '~/server/redis/caches';
import { getEventDecorationDefinition } from '~/shared/constants/event-decoration.constants';

export const events = [holiday2024, birthday2026];

// How long after its end an event still gets its end-of-event cleanup. Evaluated per call, never at
// module load: a list frozen at boot drops the event on the first deploy after it ends, and cleanup
// silently never runs. Bounded so a deploy can never reach back to a long-finished event.
export const EVENT_CLEANUP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// Cleanup markers must outlive the grace window, so a finished cleanup never runs again.
const CLEANUP_MARKER_TTL_S = 30 * 24 * 60 * 60;
// Events the hourly scoring may have work for: started, or inside a preview window.
function getScorableEvents(now: Date) {
  return events.filter(
    (x) =>
      (x.startDate <= now || (!!x.previewFrom && x.previewFrom <= now)) &&
      x.endDate.getTime() + EVENT_CLEANUP_GRACE_MS >= now.getTime()
  );
}
export function getActiveEvents(now = new Date()) {
  return events.filter(
    (x) => x.startDate <= now && x.endDate.getTime() + EVENT_CLEANUP_GRACE_MS >= now.getTime()
  );
}

type EventDef = (typeof events)[number];
function getEventDef(event: string) {
  const eventDef = events.find((x) => x.name === event);
  if (!eventDef) throw new Error("That event doesn't exist");
  return eventDef;
}
function scoredEvent(eventDef: EventDef) {
  const { scoring } = eventDef;
  return scoring ? { ...eventDef, scoring } : undefined;
}
// Set by the hourly scoring once a scored event's final run has named its winner; its value is the
// winning team, or NO_WINNER when no team ranked first. Either way scoring is done.
// In sysRedis, which does not evict: losing it would name the winner again.
const winnerKey = (event: string) =>
  `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.WINNER}` as const;
const NO_WINNER = 'none';
async function flagWinnerCosmetic(eventDef: EventDef, winner: string) {
  const winnerCosmeticId = await eventDef.getTeamCosmetic(winner);
  if (winnerCosmeticId) {
    await dbWrite.$executeRaw`
      UPDATE "Cosmetic"
      SET data = jsonb_set(data, '{winner}', 'true'::jsonb)
      WHERE id = ${winnerCosmeticId}
    `;
  }
  return winnerCosmeticId;
}
// Scores are read from the start of the window the viewer is in: the preview's for a previewer,
// the event's for everyone else, so test-run scores never reach the public standings.
function scoredEventFor(eventDef: EventDef, access: EventAccess) {
  const scored = scoredEvent(eventDef);
  if (!scored) return undefined;
  const scoreFrom =
    access === 'preview' && eventDef.previewFrom ? eventDef.previewFrom : eventDef.startDate;
  return { ...scored, scoreFrom };
}
// The art of each team's join cosmetic. A team whose cosmetic is not found gets no url.
async function getJoinHats(eventDef: EventDef) {
  const ids = await Promise.all(eventDef.teams.map((team) => eventDef.getTeamCosmetic(team)));
  const cosmetics = await cosmeticCache.fetch(ids.filter((id): id is number => !!id));
  return eventDef.teams.map((team, i) => {
    const id = ids[i];
    const data = id ? (cosmetics[id]?.data as { url?: unknown } | undefined) : undefined;
    return { team, url: typeof data?.url === 'string' ? data.url : null };
  });
}
function findEventDef(event: string) {
  return events.find((x) => x.name === event);
}

export const eventEngine = {
  async processEngagement(event: EngagementEvent) {
    const ctx = { ...event, db: dbWrite };
    for (const eventDef of getActiveEvents()) {
      if (eventDef.startDate <= new Date() && eventDef.endDate >= new Date()) {
        await eventDef.onEngagement?.(ctx);
      }
    }
  },
  async dailyReset(now = new Date()) {
    for (const eventDef of getActiveEvents(now)) {
      // Ignore events that aren't active yet
      if (eventDef.startDate > now) continue;

      const scores = await this.getTeamScores(eventDef.name);

      // If the event is over, clean it up once
      if (eventDef.endDate < now) {
        // Check to see if we've already cleaned up this event
        const cleanupKey = `${REDIS_KEYS.EVENT.EVENT_CLEANUP}:${eventDef.name}` as const;
        const alreadyCleanedUp = await redis.get(cleanupKey);
        if (alreadyCleanedUp) continue;

        // A scored event's cosmetics stay on content: owners keep them after the event (see
        // canWearEventDecorations). Its winner is named by the hourly scoring, on the first run that
        // settles the whole finalize window (updateLeaderboard), so its cleanup waits for that. While
        // the engine is switched off it waits too.
        const scoredWinner = eventDef.scoring ? await sysRedis.get(winnerKey(eventDef.name)) : null;
        if (eventDef.scoring && (!scoredWinner || !(await isEventPointsEnabled()))) continue;

        // Get 1st place team
        const winner = scoredWinner
          ? scoredWinner === NO_WINNER
            ? undefined
            : scoredWinner
          : scores.find(({ rank }) => rank === 1)?.team;
        if (!winner) continue;

        // Update first place cosmetic and set to winner (a scored event's is already flagged)
        const winnerCosmeticId = scoredWinner
          ? await eventDef.getTeamCosmetic(winner)
          : await flagWinnerCosmetic(eventDef, winner);

        if (!eventDef.scoring) {
          // Unequip all event cosmetics
          const cosmeticIds = [];
          for (const team of eventDef.teams) {
            const cosmeticId = await eventDef.getTeamCosmetic(team);
            if (!cosmeticId) continue;
            cosmeticIds.push(cosmeticId);
          }
          await dbWrite.userCosmetic.updateMany({
            where: { cosmeticId: { in: cosmeticIds } },
            data: { equippedAt: null },
          });
        }

        await eventDef.onCleanup?.({ scores, db: dbWrite, winner, winnerCosmeticId });

        // Mark cleanup as complete, only after every step succeeded so a failure retries tomorrow.
        await redis.set(cleanupKey, `true`, { EX: CLEANUP_MARKER_TTL_S });
      } else {
        // If the event isn't over, run the daily reset
        if (eventDef.onDailyReset) {
          if (!scores) continue;

          await eventDef.onDailyReset({ scores, db: dbWrite });
        }
      }

      await eventDef.clearKeys();
    }
  },
  async updateLeaderboard(now = new Date()) {
    let updated = false;
    for (const eventDef of getScorableEvents(now)) {
      const scored = scoredEvent(eventDef);
      if (scored) {
        // A scored event never falls through to the old leaderboard below. It keeps running past
        // the end until a run has settled the whole finalize window and named the winner; the referee
        // clips every window to the season's end.
        if (eventPointsWindow(scored).to < now && (await sysRedis.get(winnerKey(eventDef.name))))
          continue;
        // Before launch this is the preview, where only flagged users' hats earn (the hat sync
        // applies the flag), settled into its own season.
        const phase = await getEventScoringPhase(eventDef, now);
        if (!phase) continue;
        const standingsEvent = { ...scored, scoreFrom: phase.from };
        // Kill switch off: no settling and no winner, only the snapshot below, so the pages show the
        // last settled numbers from the durable table rather than nothing. Past the window nothing
        // more can settle while off, so one snapshot there is enough.
        const enabled = await isEventPointsEnabled();
        if (
          !enabled &&
          eventPointsWindow(scored).to < now &&
          (await hasStandingsSnapshot(standingsEvent))
        )
          continue;
        let final = false;
        if (enabled) {
          await syncEventHats(now);
          const season = eventPointSeason(eventDef.startDate, now);
          // A failed settle must not also freeze the standings snapshot or stop the other events.
          try {
            const result = await runEventPointsReferee(scored, season, now);
            final = result.final;
            logToAxiom({
              type: 'info',
              name: 'event-points-referee',
              event: eventDef.name,
              ...result,
            }).catch(() => undefined);
          } catch (error) {
            logToAxiom({
              type: 'error',
              name: 'event-points-referee',
              event: eventDef.name,
              message: (error as Error).message,
            }).catch(() => undefined);
          }
        }
        const standings = await refreshStandings(standingsEvent, dbWrite);
        // The first run that settles the whole finalize window names the winner, on the standings it
        // just computed from the primary. A failed run names none, and the next hour's run tries again.
        if (final) {
          const winner = standings.teams.find(({ rank }) => rank === 1)?.team;
          if (winner) await flagWinnerCosmetic(eventDef, winner);
          await sysRedis.set(winnerKey(eventDef.name), winner ?? NO_WINNER, {
            EX: CLEANUP_MARKER_TTL_S,
          });
        }
        continue;
      }

      // Ignore events that aren't active yet
      if (eventDef.startDate > now) continue;

      // If the event is over, don't update the leaderboard
      if (eventDef.endDate < now) continue;

      const teamAccounts = this.getTeamAccounts(eventDef.name);
      const accountTeams = Object.fromEntries(Object.entries(teamAccounts).map((x) => x.reverse()));
      const accountIds = Object.values(teamAccounts);

      // Create leaderboards if missing
      const leaderboards = {
        'all-time': 'Top Donors',
        day: 'Top Donors Today',
        ...Object.fromEntries(eventDef.teams.map((x) => [x.toLowerCase(), `${x} Team Top Donors`])),
      };
      await dbWrite.$executeRawUnsafe(`
        INSERT INTO "Leaderboard" ("id", "index", "title", "description", "scoringDescription", "query", "active", "public") VALUES
        ${Object.entries(leaderboards)
          .map(
            ([id, title], index) =>
              `('${eventDef.name}:${id}', ${
                100 + index
              }, '${title}', 'The people that have given the most Buzz', 'Buzz donated', '', true, true)`
          )
          .join(',')}
        ON CONFLICT DO NOTHING
      `);

      // Top each team all time
      const allTimeContributorsByAccount = await getTopContributors({ accountIds, limit: 500 });
      for (const [accountId, contributors] of Object.entries(allTimeContributorsByAccount)) {
        const team = accountTeams[accountId];
        const leaderboardId = `${eventDef.name}:${team.toLowerCase()}`;
        const transaction = [
          dbWrite.$executeRaw`
            DELETE FROM "LeaderboardResult"
            WHERE "leaderboardId" = ${leaderboardId} AND date = current_date
          `,
        ];
        if (contributors.length > 0) {
          transaction.push(
            dbWrite.$executeRawUnsafe(`
              INSERT INTO "LeaderboardResult"("leaderboardId", "date", "userId", "score", "position")
              SELECT
                '${leaderboardId}' as "leaderboardId",
                current_date as date,
                *,
                row_number() OVER (ORDER BY score DESC) as position
              FROM (${contributors
                .map((x) => `SELECT ${x.userId} as "userId", ${x.amount ?? 0} as "score"`)
                .join(' UNION ')}) as scores
            `)
          );
        }

        await dbWrite.$transaction(transaction);
      }

      // Top all teams all time
      const allTimeContributors = Object.values(allTimeContributorsByAccount)
        .flat()
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 500);
      await dbWrite.$transaction([
        dbWrite.$executeRawUnsafe(`
          DELETE FROM "LeaderboardResult"
          WHERE "leaderboardId" = '${eventDef.name}:all-time' AND date = current_date
        `),
        dbWrite.$executeRawUnsafe(`
          INSERT INTO "LeaderboardResult"("leaderboardId", "date", "userId", "score", "position")
          SELECT
            '${eventDef.name}:all-time' as "leaderboardId",
            current_date as date,
            *,
            row_number() OVER (ORDER BY score DESC) as position
          FROM (${allTimeContributors
            .map((x) => `SELECT ${x.userId} as "userId", ${x.amount} as "score"`)
            .join(' UNION ')}) as scores
        `),
      ]);

      // Top all teams 24 hours
      const start = dayjs().subtract(1, 'day').toDate();
      const dayContributorsByAccount = await getTopContributors({ accountIds, limit: 500, start });
      const dayContributors = Object.values(dayContributorsByAccount)
        .flat()
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 500);
      await dbWrite.$transaction([
        dbWrite.$executeRawUnsafe(`
          DELETE FROM "LeaderboardResult"
          WHERE "leaderboardId" = '${eventDef.name}:day' AND date = current_date
        `),
        dbWrite.$executeRawUnsafe(`
          INSERT INTO "LeaderboardResult"("leaderboardId", "date", "userId", "score", "position")
          SELECT
            '${eventDef.name}:day' as "leaderboardId",
            current_date as date,
            *,
            row_number() OVER (ORDER BY score DESC) as position
          FROM (${dayContributors
            .map((x) => `SELECT ${x.userId} as "userId", ${x.amount} as "score"`)
            .join(' UNION ')}) as scores
        `),
      ]);

      // Update User Rank
      const leaderboardIds = Object.keys(leaderboards);
      await updateLeaderboardRank({ leaderboardIds });

      // Purge cache
      await redis.del(
        `${REDIS_KEYS.EVENT.BASE}:${eventDef.name}:${REDIS_SUB_KEYS.EVENT.CONTRIBUTORS}`
      );
      await redis.purgeTags(leaderboardIds.map((id) => `leaderboard-${eventDef.name}:${id}`));
      await redis.purgeTags([`event-donors-${eventDef.name}`]);
      updated = true;
    }

    // Purge leaderboard positions cache
    if (updated) await redis.purgeTags('leaderboard-positions');
  },
  // Each team's join hat art, for the page to show what joining gets you. Ungated: callers check
  // access first.
  // The design every member gets free on joining, which is never a shop item.
  getJoinDesign(event: string) {
    return getEventDef(event).join?.design;
  },
  async getJoinHats(event: string) {
    const eventDef = getEventDef(event);
    return eventDef.join ? getJoinHats(eventDef) : [];
  },
  async getEventData(event: string, viewer: EventViewer, now = new Date()) {
    const eventDef = getEventDef(event);
    const access = await this.assertReadable(event, viewer, now);

    let coverImage = eventDef.coverImage;
    let coverImageUser;
    if (eventDef.coverImageCollection) {
      const [banner] = await dbRead.$queryRaw<{ url: string; username: string }[]>`
        SELECT
          i.url,
          u.username
        FROM "CollectionItem" ci
        JOIN "Collection" c ON c.id = ci."collectionId"
        JOIN "Image" i ON i.id = ci."imageId"
        JOIN "User" u ON u.id = i."userId"
        WHERE c."userId" = -1 AND c.name = ${eventDef.coverImageCollection}
        ORDER BY ci."createdAt" DESC
        LIMIT 1
      `;
      coverImage = banner?.url;
      coverImageUser = banner?.username;
    }
    const decoration = getEventDecorationDefinition(event);

    return {
      title: eventDef.title,
      startDate: eventDef.startDate,
      endDate: eventDef.endDate,
      // Scores keep taking late data until then; the winner is decided on the standings after it.
      finalAt: eventDef.scoring
        ? eventPointsWindow({ ...eventDef, scoring: eventDef.scoring }).to
        : undefined,
      teams: eventDef.teams,
      cosmeticName: eventDef.cosmeticName,
      coverImage,
      coverImageUser,
      scored: !!eventDef.scoring,
      reactionWeight: eventDef.scoring?.types.reaction?.weight,
      joinable: !!eventDef.join,
      preview: access === 'preview',
      previewFrom: eventDef.previewFrom,
      page: eventDef.page,
      // The fair-play rules the page explains, read from what the scoring job applies.
      rules: eventDef.scoring && {
        viewWeight: eventDef.scoring.types.view?.weight,
        reactionWeight: eventDef.scoring.types.reaction?.weight,
        commentWeight: eventDef.scoring.types.comment?.weight,
        stickerWeight: eventDef.scoring.types.sticker?.weight,
        remixWeight: eventDef.scoring.types.remix?.weight,
        modelLikeWeight: eventDef.scoring.types.modelLike?.weight,
        pointsCapPerDay: eventDef.scoring.capPerActorPerOwnerPerDay,
        newAccountDays: eventDef.scoring.newAccountDays,
      },
      decoration: decoration && {
        label: decoration.label,
        entityTypes: decoration.entityTypes,
        moveCooldownMs: decoration.moveCooldownMs,
      },
    };
  },
  getTeamAccounts(event: string) {
    const { bankIndex, teams } = getEventDef(event);
    if (bankIndex === undefined) return {} as Record<string, number>;

    // Get team accounts from buzz accounts
    const teamAccounts: Record<string, number> = {};
    for (const [index, team] of teams.entries()) {
      const accountId = bankIndex - index;
      teamAccounts[team] = accountId;
    }

    return teamAccounts;
  },
  // Ungated: the jobs read this after the start, and routes check access before calling it.
  async getTeamScores(
    event: string,
    access: EventAccess = 'open',
    read?: Parameters<typeof getEventStandings>[1]
  ) {
    const eventDef = getEventDef(event);
    const scored = scoredEventFor(eventDef, access);
    if (scored) return (await getEventStandings(scored, read)).teams;

    // Get team scores from buzz accounts
    const teamScores: TeamScore[] = [];
    for (const [index, team] of eventDef.teams.entries()) {
      const accountId = (eventDef.bankIndex ?? 0) - index;
      const buzzAccount = await getUserBuzzAccount({ accountId });
      teamScores.push({
        team,
        score: buzzAccount[0]?.balance ?? 0,
        rank: 0,
      });
    }

    // Apply rank
    teamScores.sort((a, b) => b.score - a.score);
    teamScores.forEach((x, i) => (x.rank = i + 1));
    return teamScores;
  },
  // Ungated like getTeamScores.
  async getTeamScoreHistory(
    { event, window, start }: TeamScoreHistoryInput,
    access: EventAccess = 'open',
    read?: Parameters<typeof getEventStandings>[1]
  ) {
    const eventDef = getEventDef(event);
    const scored = scoredEventFor(eventDef, access);
    if (scored) return getScoredTeamScoreHistory(scored, read);

    // Get team scores from buzz accounts
    const accounts = this.getTeamAccounts(event);

    const summaries = await getAccountSummary({
      accountIds: Object.values(accounts),
      start: start ?? eventDef.startDate,
      window,
    });

    const now = new Date();
    const teamScoreHistory = Object.entries(accounts).map(([team, accountId]) => {
      const summary = summaries[accountId];
      return {
        team,
        scores: summary
          .filter((x) => x.date < now)
          .map((x) => ({ date: x.date, score: x.balance })),
      };
    });

    return teamScoreHistory;
  },
  async getUserData({ event, userId }: { event: string; userId: number }) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    const cosmeticId = await eventDef.getUserCosmeticId(userId);
    const team = await eventDef.getUserTeam(userId);
    const accountId = this.getTeamAccounts(event)?.[team] ?? null;

    return { cosmeticId, team, accountId };
  },
  // Scored-event reads. Like getEventData, an event this viewer cannot read reads as nonexistent.
  async getReadableScoredEvent(event: string, viewer: EventViewer, now = new Date()) {
    const access = await this.assertReadable(event, viewer, now);
    const scored = scoredEventFor(getEventDef(event), access);
    if (!scored) throw new Error("That event doesn't exist");
    return scored;
  },
  isJoinEvent(event: string) {
    return !!getEventDef(event).join;
  },
  // Grants the user's team cosmetic once, inside the event window. Idempotent: a double click or a
  // second tab inserts nothing, and so does a user whose team was reassigned after joining (they
  // keep the cosmetic they got).
  async join(event: string, user: { id: number; isModerator?: boolean }, now = new Date()) {
    const eventDef = getEventDef(event);
    const claimKey = eventDef.join?.claimKey;
    if (!claimKey) throw new Error('This event has no join');
    await this.assertPlayable(event, user, now);
    const userId = user.id;

    // Strict: a degraded manual-assignment read refuses the join rather than granting the computed
    // team's colour to someone assigned by hand.
    const team = await eventDef.getUserTeam(userId, { strict: true });
    const cosmeticId = await eventDef.getTeamCosmetic(team);
    if (!cosmeticId) throw new Error("This event's cosmetics are not set up yet");

    const teamByCosmetic = new Map<number, string>();
    for (const t of eventDef.teams) {
      const id = await eventDef.getTeamCosmetic(t);
      if (id) teamByCosmetic.set(id, t);
    }
    const teamCosmeticIds = [...teamByCosmetic.keys()];

    const inserted = await dbWrite.$executeRaw`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", "obtainedAt")
      SELECT ${userId}, ${cosmeticId}, ${claimKey}, now()
      WHERE NOT EXISTS (
        SELECT 1 FROM "UserCosmetic"
        WHERE "userId" = ${userId} AND "claimKey" = ${claimKey}
          AND "cosmeticId" = ANY(${teamCosmeticIds}::int[])
      )
      ON CONFLICT DO NOTHING
    `;

    if (inserted > 0) return { team, cosmeticId, joined: true };

    // Already joined. Report the cosmetic actually held, which differs from `team` when the user was
    // reassigned after joining.
    const [held] = await dbWrite.$queryRaw<{ cosmeticId: number }[]>`
      SELECT "cosmeticId" FROM "UserCosmetic"
      WHERE "userId" = ${userId} AND "claimKey" = ${claimKey}
        AND "cosmeticId" = ANY(${teamCosmeticIds}::int[])
      LIMIT 1
    `;
    const heldId = held?.cosmeticId ?? cosmeticId;
    return { team: teamByCosmetic.get(heldId) ?? team, cosmeticId: heldId, joined: false };
  },
  // What this viewer may do with the event; see event-access.ts. An unknown event is closed.
  async getAccess(event: string, viewer: EventViewer, now = new Date()): Promise<EventAccess> {
    const eventDef = findEventDef(event);
    return eventDef ? getEventAccess(eventDef, viewer, now) : 'closed';
  },
  // Unannounced until this viewer may see it: every route reads such an event like an unknown slug.
  async assertReadable(event: string, viewer: EventViewer, now = new Date()) {
    const access = await this.getAccess(event, viewer, now);
    if (!canReadEvent(access)) throw new Error("That event doesn't exist");
    return access;
  },
  async assertPlayable(event: string, viewer: EventViewer, now = new Date()) {
    const access = await this.assertReadable(event, viewer, now);
    if (!canPlayEvent(access)) throw new Error('This event is not running');
    return access;
  },
  async getRewards(event: string) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    return eventDef.getRewards();
  },
  async donate(event: string, { userId, amount }: { userId: number; amount: number }) {
    const eventDef = getEventDef(event);
    if (eventDef.bankIndex === undefined) throw new Error('This event does not take donations');

    const { team, accountId } = await this.getUserData({ event, userId });
    if (!team || !accountId) throw new Error("You don't have a team for this event");

    const { title, startDate, endDate } = await this.getEventData(event, { id: userId });

    await createBuzzTransaction({
      toAccountId: accountId,
      fromAccountId: userId,
      type: TransactionType.Donation,
      amount,
      description: `${title} Donation - ${team}`,
    });

    // Record donation to user cosmetic
    const cosmeticId = await eventDef.getUserCosmeticId(userId);
    if (!cosmeticId) return;

    // Get current donation total
    const userCosmetic = await dbWrite.userCosmetic.findFirst({
      where: { cosmeticId, userId },
      select: { data: true },
    });
    const userCosmeticData = (userCosmetic?.data ?? {}) as DonationCosmeticData;
    userCosmeticData.donated = (userCosmeticData.donated ?? 0) + amount;

    // Get current purchased total
    let purchased = 0;
    try {
      [{ purchased }] = (await clickhouse!.$query<{ purchased: number }>`
        SELECT
          sum(amount) as purchased
        FROM buzzTransactions
        WHERE toAccountId = ${userId}
        AND fromAccountId = 0
        AND type = 'purchase'
        AND toAccountType = 'yellow'
        AND date BETWEEN ${startDate} AND ${endDate};
      `) ?? [{ purchased: 0 }];
      userCosmeticData.purchased = purchased;
    } catch (e) {
      const error = e as Error;
      logToAxiom({
        type: 'error',
        name: 'event-donation-error',
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      });
    }

    // Update user cosmetic
    const toUpdate = {
      donated: userCosmeticData.donated,
      purchased: userCosmeticData.purchased,
    };
    console.log('update user cosmetic', toUpdate);
    await dbWrite.$queryRawUnsafe(`
      UPDATE "UserCosmetic"
      SET data = COALESCE(data, '{}'::jsonb) || to_jsonb('${JSON.stringify(toUpdate)}'::jsonb)
      WHERE "userId" = ${userId} AND "cosmeticId" = ${cosmeticId};
    `);
    await eventDef.onDonate?.({ userId, amount, db: dbWrite, userCosmeticData });

    return { team, title, accountId };
  },
  // 2024-12-12: Deprecated in favor of direct query on donation
  // async processPurchase({ userId, amount }: { userId: number; amount: number }) {

  // for (const eventDef of activeEvents) {
  //   if (eventDef.startDate <= new Date() && eventDef.endDate >= new Date()) {
  //     // Record to user cosmetic
  //     const cosmeticId = await eventDef.getUserCosmeticId(userId);
  //     if (!cosmeticId) continue;

  //     // Get current purchased total
  //     const userCosmetic = await dbWrite.userCosmetic.findFirst({
  //       where: { cosmeticId, userId },
  //       select: { data: true },
  //     });
  //     const userCosmeticData = (userCosmetic?.data ?? {}) as DonationCosmeticData;
  //     userCosmeticData.purchased = (userCosmeticData.purchased ?? 0) + amount;

  //     // Update user cosmetic
  //     await dbWrite.$queryRaw`
  //       UPDATE "UserCosmetic"
  //       SET data = jsonb_set(
  //         COALESCE(data, '{}'::jsonb),
  //         '{purchased}',
  //         to_jsonb(${userCosmeticData.purchased})
  //       )
  //       WHERE "userId" = ${userId} AND "cosmeticId" = ${cosmeticId}; -- Your conditions here
  //     `;

  //     await eventDef.onPurchase?.({ userId, amount, db: dbWrite, userCosmeticData });
  //   }
  // }
  // },
  async getTopContributors(event: string, limit = 10) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    const cacheJson = await redis.get(
      `${REDIS_KEYS.EVENT.BASE}:${eventDef.name}:${REDIS_SUB_KEYS.EVENT.CONTRIBUTORS}`
    );
    if (cacheJson) return JSON.parse(cacheJson) as TopContributors;

    const teamAccounts = this.getTeamAccounts(event);
    const accountIds = Object.values(teamAccounts);
    if (!accountIds.length) return { allTime: [], day: [], teams: {} } as TopContributors;
    const accountTeams = Object.fromEntries(Object.entries(teamAccounts).map((x) => x.reverse()));

    // Determine top contributors across all teams all time
    const allTimeContributorsByAccount = await getTopContributors({ accountIds, limit });
    const allTimeContributors = Object.entries(allTimeContributorsByAccount)
      .flatMap(([accountId, contributors]) =>
        contributors.map((x) => ({ ...x, team: accountTeams[accountId] }))
      )
      .sort((a, b) => b.amount - a.amount)
      .slice(0, limit);

    // Pivot back from accounts to team names
    const allTimeContributorsByTeamName: Record<string, typeof allTimeContributors> =
      Object.fromEntries(
        Object.entries(allTimeContributorsByAccount).map(([accountId, contributors]) => [
          accountTeams[accountId],
          contributors,
        ])
      );

    // Determine top contributors across all teams today
    const start = dayjs().subtract(1, 'day').toDate();
    const dayContributorsByAccount = await getTopContributors({ accountIds, limit, start });
    const dayContributors = Object.entries(dayContributorsByAccount)
      .flatMap(([accountId, contributors]) =>
        contributors.map((x) => ({ ...x, team: accountTeams[accountId] }))
      )
      .sort((a, b) => b.amount - a.amount)
      .slice(0, limit);

    // Cache results for 24 hours
    const result = {
      allTime: allTimeContributors,
      day: dayContributors,
      teams: allTimeContributorsByTeamName,
    } as TopContributors;
    await redis.set(
      `${REDIS_KEYS.EVENT.BASE}:${eventDef.name}:${REDIS_SUB_KEYS.EVENT.CONTRIBUTORS}`,
      JSON.stringify(result),
      {
        EX: 60 * 60 * 24,
      }
    );

    return result;
  },
  async getPartners(event: string) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    let partnersCache: string[] = [];
    try {
      // Wall-clock deadline + fail-open: a fast sysRedis DOWN would 500 this
      // read; a silent half-open would park the awaited lRange ~11min. On
      // DOWN/SLOW fail open to an empty partners list.
      partnersCache = await withSysReadDeadline(
        sysRedis.lRange(`${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.PARTNERS}`, 0, -1)
      );
    } catch (err) {
      logSysRedisFailOpen('read-degraded', 'events.getPartners', err, { event });
      return [];
    }
    const partners = partnersCache.map((x) => JSON.parse(x)) as EventPartner[];

    return partners.sort((a, b) => b.amount - a.amount);
  },
  async queueAddRole({ event, team, userId }: { event: string; team: string; userId: number }) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    try {
      // Best-effort write fail-open (NOT deadline-raced — writes are bounded
      // by the sys client's commandsQueueMaxLength, not this helper). On a
      // sysRedis DOWN/SLOW the queued role-add is dropped (acceptable feature
      // degrade — the Discord team role just isn't granted this cycle) rather
      // than 500ing the caller.
      await sysRedis.lPush(
        `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.ADD_ROLE}`,
        JSON.stringify({ team, userId })
      );
    } catch (err) {
      logSysRedisFailOpen('write-degraded', 'events.queueAddRole', err, { event, team, userId });
    }
  },
  async addRole({ event, team, userId }: { event: string; team: string; userId: number }) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    const teamRoles = await eventDef.getDiscordRoles();
    const roleId = teamRoles[team];
    if (!roleId) return;

    const discordId = await discord.getDiscordId(userId);
    if (!discordId) return;

    try {
      await discord.addRoleToUser(discordId, roleId);
    } catch (e) {
      console.error(e);
    }
  },
  async processAddRoleQueue() {
    for (const eventDef of getActiveEvents()) {
      const queueKey =
        `${REDIS_SYS_KEYS.EVENT}:${eventDef.name}:${REDIS_SUB_KEYS.EVENT.ADD_ROLE}` as const;

      // Both reads are deadline-raced + fail-open. On a sysRedis DOWN/SLOW we
      // SKIP this event's queue this cycle and drain it next cycle.
      // lPopCount is an atomic LPOP-with-count. On a fast DOWN the command is
      // never written → nothing is popped → items stay queued (safe, #2922).
      // CAVEAT (slow-but-alive): if the LPOP *does* execute server-side but its
      // reply lands after the ~2s deadline, those items are popped-then-skipped
      // and lost. That window is narrow and the payload is best-effort Discord
      // team-role grants (no money/security/correctness) — an acceptable trade
      // vs the ~11min park the deadline prevents. If loss ever mattered here,
      // switch to a non-destructive lRange + conditional lTrim.
      let queueLength = 0;
      try {
        queueLength = await withSysReadDeadline(sysRedis.lLen(queueKey));
      } catch (err) {
        logSysRedisFailOpen('read-degraded', 'events.processAddRoleQueue lLen', err, {
          event: eventDef.name,
        });
        continue;
      }
      if (!queueLength) continue;

      let queueJson: string[] | null = null;
      try {
        queueJson = await withSysReadDeadline(sysRedis.lPopCount(queueKey, queueLength));
      } catch (err) {
        logSysRedisFailOpen('read-degraded', 'events.processAddRoleQueue lPopCount', err, {
          event: eventDef.name,
        });
        continue;
      }
      if (!queueJson) continue;
      const queue = queueJson.map((x) => JSON.parse(x)) as { team: string; userId: number }[];

      // Fetch roles
      const teamRoles = await eventDef.getDiscordRoles();

      // Fetch discord ids
      const discordIds = await discord.getDiscordIds(queue.map((x) => x.userId));

      for (const { team, userId } of queue) {
        const roleId = teamRoles[team];
        const discordId = discordIds.get(userId);
        if (!roleId || !discordId) continue;

        try {
          await discord.addRoleToUser(discordId, roleId);
        } catch (e) {
          console.error(e);
        }
      }
    }
  },
};

type Contributor = { userId: number; amount: number; team: string };
type TopContributors = {
  allTime: Contributor[];
  day: Contributor[];
  teams: Record<string, Contributor[]>;
};

type EventPartner = {
  title: string;
  amount: number;
  image: string;
  url: string;
};
