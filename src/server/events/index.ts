import dayjs from '~/shared/utils/dayjs';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { DonationCosmeticData, EngagementEvent, TeamScore } from '~/server/events/base.event';
import { holiday2024 } from '~/server/events/holiday2024.event';
import { discord } from '~/server/integrations/discord';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS, REDIS_SUB_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import type { TeamScoreHistoryInput } from '~/server/schema/event.schema';
import {
  createBuzzTransaction,
  getAccountSummary,
  getTopContributors,
  getUserBuzzAccount,
} from '~/server/services/buzz.service';
import { updateLeaderboardRank } from '~/server/services/user.service';

// Only include events that aren't completed
export const events = [holiday2024];
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

      const scores = await this.getTeamScores(eventDef.name);

      // If the event is over, unequip the event cosmetics from all users
      if (eventDef.endDate < new Date()) {
        // Check to see if we've already cleaned up this event
        const alreadyCleanedUp = await redis.get(
          `${REDIS_KEYS.EVENT.EVENT_CLEANUP}:${eventDef.name}`
        );
        if (alreadyCleanedUp) continue;

        // Get 1st place team
        const winner = scores.find(({ rank }) => rank === 1)?.team;
        if (!winner) return;

        // Update first place cosmetic and set to winner
        const winnerCosmeticId = await eventDef.getTeamCosmetic(winner);
        if (winnerCosmeticId) {
          await dbWrite.$executeRaw`
            UPDATE "Cosmetic"
            SET data = jsonb_set(data, '{winner}', true)
            WHERE id = ${winnerCosmeticId}
          `;
        }

        // Unequip all event cosmetics
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

        await eventDef.onCleanup?.({ scores, db: dbWrite, winner, winnerCosmeticId });

        // Mark cleanup as complete
        // Only need 7 days, because next deploy should make this event be ignored
        await redis.set(`${REDIS_KEYS.EVENT.EVENT_CLEANUP}:${eventDef.name}`, `true`, {
          EX: 60 * 60 * 24 * 7,
        });
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
  async updateLeaderboard() {
    let updated = false;
    for (const eventDef of activeEvents) {
      // Ignore events that aren't active yet
      if (eventDef.startDate > new Date()) continue;

      // If the event is over, don't update the leaderboard
      if (eventDef.endDate < new Date()) continue;

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
  async getEventData(event: string) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

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

    return {
      title: eventDef.title,
      startDate: eventDef.startDate,
      endDate: eventDef.endDate,
      teams: eventDef.teams,
      cosmeticName: eventDef.cosmeticName,
      coverImage,
      coverImageUser,
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
  async getTeamScoreHistory({ event, window, start }: TeamScoreHistoryInput) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

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
  async getRewards(event: string) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    return eventDef.getRewards();
  },
  async donate(event: string, { userId, amount }: { userId: number; amount: number }) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    const { team, accountId } = await this.getUserData({ event, userId });
    if (!team || !accountId) throw new Error("You don't have a team for this event");

    const { title, startDate, endDate } = await this.getEventData(event);

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
        AND toAccountType = 'user'
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

    const partnersCache = await sysRedis.lRange(
      `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.PARTNERS}`,
      0,
      -1
    );
    const partners = partnersCache.map((x) => JSON.parse(x)) as EventPartner[];

    return partners.sort((a, b) => b.amount - a.amount);
  },
  async queueAddRole({ event, team, userId }: { event: string; team: string; userId: number }) {
    const eventDef = events.find((x) => x.name === event);
    if (!eventDef) throw new Error("That event doesn't exist");

    await sysRedis.lPush(
      `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.ADD_ROLE}`,
      JSON.stringify({ team, userId })
    );
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
    for (const eventDef of activeEvents) {
      const queueKey =
        `${REDIS_SYS_KEYS.EVENT}:${eventDef.name}:${REDIS_SUB_KEYS.EVENT.ADD_ROLE}` as const;
      const queueLength = await sysRedis.lLen(queueKey);
      const queueJson = await sysRedis.lPopCount(queueKey, queueLength);
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
