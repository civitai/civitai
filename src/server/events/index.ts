import { dbWrite } from '~/server/db/client';
import { EngagementEvent, TeamScore } from '~/server/events/base.event';
import { holiday2023 } from '~/server/events/holiday2023.event';
import { redis } from '~/server/redis/client';
import { getAccountSummary, getUserBuzzAccount } from '~/server/services/buzz.service';
import { TeamScoreHistoryInput } from '~/server/schema/event.schema';

// Only include events that aren't completed
const events = [holiday2023];
export const activeEvents = events.filter((x) => x.endDate >= new Date());

export const eventEngine = {
  async processEngagement(event: EngagementEvent) {
    const ctx = { ...event, db: dbWrite };
    for (const eventDef of activeEvents) {
      if (eventDef.startDate <= new Date() && eventDef.endDate >= new Date()) {
        await eventDef.onEngagement?.(ctx);
      }
    }
  },
  async dailyReset() {
    for (const eventDef of activeEvents) {
      // Ignore events that aren't active yet
      if (eventDef.startDate > new Date()) continue;

      // If the event is over, unequip the event cosmetics from all users
      if (eventDef.endDate < new Date()) {
        // Check to see if we've already cleaned up this event
        const alreadyCleanedUp = await redis.get(`eventCleanup:${eventDef.name}`);
        if (alreadyCleanedUp) continue;

        const cosmeticIds = [];
        const cosmeticNames = eventDef.teams.map((x) => `${eventDef.cosmeticName} - ${x}`);
        for (const name in cosmeticNames) {
          const cosmeticId = await eventDef.getCosmetic(name);
          if (!cosmeticId) continue;
          cosmeticIds.push(cosmeticId);
        }

        await dbWrite.userCosmetic.updateMany({
          where: { cosmeticId: { in: cosmeticIds } },
          data: { equippedAt: null },
        });

        // Mark cleanup as complete
        // Only need 7 days, because next deploy should make this event be ignored
        await redis.set(`eventCleanup:${eventDef.name}`, `true`, { EX: 60 * 60 * 24 * 7 });
      } else {
        // If the event isn't over, run the daily reset
        if (eventDef.onDailyReset) {
          const scores = await this.getTeamScores(eventDef.name);
          if (!scores) continue;

          await eventDef.onDailyReset({ scores, db: dbWrite });
        }
      }

      await eventDef.clearKeys();
    }
  },
  getEventData(event: string) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    return {
      title: eventDef.title,
      startDate: eventDef.startDate,
      endDate: eventDef.endDate,
      teams: eventDef.teams,
      cosmeticName: eventDef.cosmeticName,
      coverImage: eventDef.coverImage,
    };
  },
  getTeamAccounts(event: string) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    // Get team accounts from buzz accounts
    const teamAccounts: Record<string, number> = {};
    for (const [index, team] of eventDef.teams.entries()) {
      const accountId = eventDef.bankIndex - index;
      teamAccounts[team] = accountId;
    }

    return teamAccounts;
  },
  async getTeamScores(event: string) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    // Get team scores from buzz accounts
    const teamScores: TeamScore[] = [];
    for (const [index, team] of eventDef.teams.entries()) {
      const accountId = eventDef.bankIndex - index;
      const buzzAccount = await getUserBuzzAccount({ accountId });
      teamScores.push({
        team,
        score: buzzAccount?.balance ?? 0,
        rank: 0,
      });
    }

    // Apply rank
    teamScores.sort((a, b) => b.score - a.score);
    teamScores.forEach((x, i) => (x.rank = i + 1));
    return teamScores;
  },
  async getTeamScoreHistory({ event, window }: TeamScoreHistoryInput) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    // Get team scores from buzz accounts
    const accounts = this.getTeamAccounts(event);

    const summaries = await getAccountSummary({
      accountIds: Object.values(accounts),
      start: eventDef.startDate,
      window,
    });

    const teamScoreHistory = Object.entries(accounts).map(([team, accountId]) => {
      const summary = summaries[accountId];
      return {
        team,
        scores: summary.map((x) => ({ date: x.date, score: x.balance })),
      };
    });

    return teamScoreHistory;
  },
  async getUserData({ event, userId }: { event: string; userId: number }) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    const cosmeticId = await eventDef.getUserCosmeticId(userId);
    const team = eventDef.getUserTeam(userId);
    const accountId = this.getTeamAccounts(event)?.[team] ?? null;

    return { cosmeticId, team, accountId };
  },
  async getRewards(event: string) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    return eventDef.getRewards();
  },
};
