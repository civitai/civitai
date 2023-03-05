import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { discord, DiscordRole } from '~/server/integrations/discord';
import { env } from '~/env/server.mjs';
import dayjs from 'dayjs';

const applyDiscordActivityRoles = createJob(
  'apply-discord-activity-roles',
  '7 */6 * * *',
  async () => {
    const discordRoles = await discord.getAllRoles();

    const enthusiastRole = discordRoles.find((r) => r.name === 'Entusiast');
    if (enthusiastRole) {
      const existingEntusiasts = await getAccountsInRole(enthusiastRole);

      const enthusiastCutoff = dayjs().subtract(1, 'week').toDate();
      const enthusiast = new Set(
        (
          await dbRead.image.findMany({
            where: {
              createdAt: { gte: enthusiastCutoff },
              user: {
                accounts: {
                  some: { provider: 'discord' },
                },
              },
            },
            select: {
              user: {
                select: {
                  accounts: {
                    select: { providerAccountId: true },
                    where: { provider: 'discord' },
                  },
                },
              },
            },
          })
        ).map((i) => i.user.accounts[0].providerAccountId) ?? []
      );

      const newEntusiasts = [...enthusiast].filter((u) => !existingEntusiasts.includes(u));
      await addRoleToAccounts(enthusiastRole, newEntusiasts);

      const removedEntusiasts = existingEntusiasts.filter((u) => !enthusiast.has(u));
      await removeRoleFromAccounts(enthusiastRole, removedEntusiasts);
    }

    const creatorRole = discordRoles.find((r) => r.name === 'Creator');
    if (creatorRole) {
      const existingCreators = await getAccountsInRole(creatorRole);

      const creatorCutoff = dayjs().subtract(1, 'week').toDate();
      const creator = new Set(
        (
          await dbRead.model.findMany({
            where: {
              OR: [
                { publishedAt: { gte: creatorCutoff } },
                { lastVersionAt: { gte: creatorCutoff } },
              ],
              user: {
                accounts: {
                  some: { provider: 'discord' },
                },
              },
            },
            select: {
              user: {
                select: {
                  accounts: {
                    select: { providerAccountId: true },
                    where: { provider: 'discord' },
                  },
                },
              },
            },
          })
        ).map((i) => i.user.accounts[0].providerAccountId) ?? []
      );

      const newCreators = [...creator].filter((u) => !existingCreators.includes(u));
      await addRoleToAccounts(creatorRole, newCreators);

      const removedCreators = existingCreators.filter((u) => !creator.has(u));
      await removeRoleFromAccounts(creatorRole, removedCreators);
    }
  }
);

const applyDiscordLeadboardRoles = createJob(
  'apply-discord-leaderboard-roles',
  '3 */1 * * *',
  async () => {
    const discordRoles = await discord.getAllRoles();

    const top10Role = discordRoles.find((r) => r.name === 'Top 10');
    const top100Role = discordRoles.find((r) => r.name === 'Top 100');
    if (!top100Role || !top10Role) return;

    const existingTop100 = await getAccountsInRole(top100Role);
    const existingTop10 = await getAccountsInRole(top10Role);

    // Get the top 100 users with a discord account
    const top100 =
      (
        await dbRead.user.findMany({
          where: {
            rank: { leaderboardRank: { lte: 100 } },
            accounts: {
              some: { provider: 'discord' },
            },
          },
          select: {
            rank: {
              select: {
                leaderboardRank: true,
              },
            },
            accounts: {
              select: { providerAccountId: true },
              where: { provider: 'discord' },
            },
          },
        })
      )?.map((s) => ({
        rank: s.rank?.leaderboardRank,
        providerAccountId: s.accounts[0].providerAccountId,
      })) ?? [];

    // Get the new users in the top 100 and the users that are no longer in the top 100
    const newTop100 = top100
      .filter((u) => !existingTop100.includes(u.providerAccountId))
      .map((u) => u.providerAccountId);
    await addRoleToAccounts(top100Role, newTop100);

    const removedTop100 = existingTop100.filter(
      (u) => !top100.map((u) => u.providerAccountId).includes(u)
    );
    await removeRoleFromAccounts(top100Role, removedTop100);

    // Get the new users in the top 10 and the users that are no longer in the top 10
    const newTop10 = top100
      .filter((u) => u.rank && u.rank <= 10)
      .filter((u) => !existingTop10.includes(u.providerAccountId))
      .map((u) => u.providerAccountId);
    await addRoleToAccounts(top10Role, newTop10);

    const removedTop10 = existingTop10.filter(
      (u) => !top100.map((u) => u.providerAccountId).includes(u)
    );
    await removeRoleFromAccounts(top10Role, removedTop10);
  }
);

const LAST_RUN_KEY = 'last-applied-roles';
const applyDiscordPaidRoles = createJob('apply-discord-paid-roles', '*/10 * * * *', async () => {
  // Get the last pushed time from keyValue
  const lastUpdated = new Date(
    ((
      await dbRead.keyValue.findUnique({
        where: { key: LAST_RUN_KEY },
      })
    )?.value as number) ?? 0
  );

  const discordRoles = await discord.getAllRoles();

  // Apply the Supporter Role
  // ----------------------------------------
  const supporterRole = discordRoles.find((r) => r.name === 'Supporter');
  if (supporterRole) {
    // Add the supporter role to any new supporters
    const newSupporters =
      (
        await dbRead.customerSubscription.findMany({
          where: {
            status: 'active',
            OR: [{ updatedAt: { gt: lastUpdated } }, { createdAt: { gt: lastUpdated } }],
            user: {
              accounts: {
                some: { provider: 'discord' },
              },
            },
          },
          select: {
            user: {
              select: {
                accounts: {
                  select: { providerAccountId: true },
                  where: { provider: 'discord' },
                },
              },
            },
          },
        })
      )?.map((s) => s.user.accounts[0].providerAccountId) ?? [];
    await addRoleToAccounts(supporterRole, newSupporters);

    // Remove the supporter role from any expired supporters
    const expiredSupporters =
      (
        await dbRead.customerSubscription.findMany({
          where: {
            status: 'canceled',
            endedAt: { gt: lastUpdated },
            user: {
              accounts: {
                some: { provider: 'discord' },
              },
            },
          },
          select: {
            user: {
              select: {
                accounts: {
                  select: { providerAccountId: true },
                  where: { provider: 'discord' },
                },
              },
            },
          },
        })
      )?.map((s) => s.user.accounts[0].providerAccountId) ?? [];
    await removeRoleFromAccounts(supporterRole, expiredSupporters);
  }

  // Apply the Donator Role
  // ----------------------------------------
  const donatorRole = discordRoles.find((r) => r.name === 'Donator');
  if (donatorRole) {
    // Get the accounts with the donator role
    const existingDonators = await getAccountsInRole(donatorRole);

    // Get the current donators
    const donatorCutoff = dayjs().subtract(1, 'month').toDate();
    const donators = new Set(
      (
        await dbRead.purchase.findMany({
          where: {
            createdAt: { gt: donatorCutoff },
            priceId: env.STRIPE_DONATE_ID,
            customer: {
              accounts: {
                some: { provider: 'discord' },
              },
            },
          },
          select: {
            customer: {
              select: {
                accounts: {
                  select: { providerAccountId: true },
                  where: { provider: 'discord' },
                },
              },
            },
          },
        })
      )?.map((s) => s.customer.accounts[0].providerAccountId) ?? []
    );

    const newDonators = [...donators].filter((u) => !existingDonators.includes(u));
    await addRoleToAccounts(donatorRole, newDonators);

    const removedDonators = existingDonators.filter((u) => !donators.has(u));
    await removeRoleFromAccounts(donatorRole, removedDonators);
  }

  // Update the last pushed time
  // --------------------------------------------
  await dbWrite?.keyValue.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });
});

export const applyDiscordRoles = [
  applyDiscordActivityRoles,
  applyDiscordPaidRoles,
  applyDiscordLeadboardRoles,
];

// #region [utilities]
const getAccountsInRole = async (role: DiscordRole) => {
  const accounts =
    (
      await dbRead.account.findMany({
        where: {
          provider: 'discord',
          metadata: {
            path: ['roles'],
            array_contains: role.name,
          },
        },
        select: {
          providerAccountId: true,
        },
      })
    )?.map((x) => x.providerAccountId) ?? [];
  return accounts;
};

const addRoleToAccounts = async (role: DiscordRole, providerAccountIds: string[]) => {
  // Update discord
  for (const providerAccountId of providerAccountIds)
    try {
      await discord.addRoleToUser(providerAccountId, role.id);
    } catch (e) {
      console.error(e);
    }

  // Update the accounts in the database
  const roleValue = JSON.stringify([role.name]);
  const ids = providerAccountIds.map((id) => `'${id}'`).join(',');
  if (ids.length === 0) return;
  await dbWrite.$executeRawUnsafe(`
    UPDATE "Account"
    SET metadata = jsonb_set(
      metadata,
      '{roles}',
      COALESCE(metadata->'roles', '[]'::jsonb) || '${roleValue}'::jsonb,
      true
    )
    WHERE "providerAccountId" IN (${ids})`);
};

const removeRoleFromAccounts = async (role: DiscordRole, providerAccountIds: string[]) => {
  // Update discord
  for (const providerAccountId of providerAccountIds)
    try {
      await discord.removeRoleFromUser(providerAccountId, role.id);
    } catch (e) {
      console.error(e);
    }

  // Update the accounts in the database
  const ids = providerAccountIds.map((id) => `'${id}'`).join(',');
  if (ids.length === 0) return;
  await dbWrite.$executeRawUnsafe(`
    UPDATE "Account"
    SET metadata = jsonb_set(
      metadata,
      '{roles}',
      COALESCE(metadata->'roles', '[]'::jsonb) - '${role.name}',
      true
    )
    WHERE "providerAccountId" IN (${ids})`);
};
// #endregion
