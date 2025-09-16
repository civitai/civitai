import dayjs from '~/shared/utils/dayjs';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import type { DiscordRole } from '~/server/integrations/discord';
import { discord } from '~/server/integrations/discord';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createJob } from './job';

const ENTHUSIAST_ROLE_CUTOFF = 7; // days
const CREATOR_ROLE_CUTOFF = 14; // days
const applyDiscordActivityRoles = createJob(
  'apply-discord-activity-roles',
  '7 */6 * * *',
  async () => {
    const discordRoles = await discord.getAllRoles();

    // Too Expensive...
    // const enthusiastRole = discordRoles.find((r) => r.name === 'Enthusiast');
    // if (enthusiastRole) {
    //   const existingEntusiasts = await getAccountsInRole(enthusiastRole);

    //   const enthusiastCutoff = dayjs().subtract(ENTHUSIAST_ROLE_CUTOFF, 'day').toDate();
    //   const enthusiasts =
    //     (
    //       await dbWrite.$queryRawUnsafe<{ providerAccountId: string }[]>(`
    //     SELECT a."providerAccountId"
    //     FROM "Account" a
    //     WHERE a.provider = 'discord'
    //       AND EXISTS (
    //         SELECT 1
    //         FROM "Image" i
    //         WHERE i."userId" = a."userId"
    //           AND i."createdAt" > $1
    //         LIMIT 1
    //       )`, enthusiastCutoff)
    //     )?.map((x) => x.providerAccountId) ?? [];

    //   const newEntusiasts = enthusiasts.filter((u) => !existingEntusiasts.includes(u));
    //   await addRoleToAccounts(enthusiastRole, newEntusiasts);

    //   const removedEntusiasts = existingEntusiasts.filter((u) => !enthusiasts.includes(u));
    //   await removeRoleFromAccounts(enthusiastRole, removedEntusiasts);
    // }

    const creatorRole = discordRoles.find((r) => r.name === 'Creator');
    if (creatorRole) {
      const existingCreators = await getAccountsInRole(creatorRole);

      const creatorCutoff = dayjs().subtract(CREATOR_ROLE_CUTOFF, 'day').toDate();
      const creator = new Set(
        (
          await dbWrite.model.findMany({
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

export const applyDiscordLeaderboardRoles = async () => {
  const discordRoles = await discord.getAllRoles();

  const top10Role = discordRoles.find((r) => r.name === 'Top 10');
  const top100Role = discordRoles.find((r) => r.name === 'Top 100');
  if (!top100Role || !top10Role) return;

  const existingTop100 = await getAccountsInRole(top100Role);
  const existingTop10 = await getAccountsInRole(top10Role);

  // Get the top 100 users with a discord account
  const top100 =
    (
      await dbWrite.user.findMany({
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
};

const applyDiscordPaidRoles = createJob('apply-discord-paid-roles', '*/10 * * * *', async () => {
  const discordRoles = await discord.getAllRoles();

  // Apply the Supporter Role
  // ----------------------------------------
  const supporterRole = discordRoles.find((r) => r.name === 'Supporter');
  if (supporterRole) {
    const existingSupporters = await getAccountsInRole(supporterRole);

    // Add the supporter role to any new supporters
    const supporters =
      (
        await dbWrite.customerSubscription.findMany({
          where: {
            status: { in: ['active', 'trialing'] },
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
    const newSupporters = supporters.filter((u) => !existingSupporters.includes(u));
    await addRoleToAccounts(supporterRole, newSupporters);

    // Remove the supporter role from any expired supporters
    const expiredSupporters = existingSupporters.filter((u) => !supporters.includes(u));
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
        await dbWrite.purchase.findMany({
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
});

export const applyDiscordRoles = [applyDiscordActivityRoles, applyDiscordPaidRoles];

// #region [utilities]
const getAccountsInRole = async (role: DiscordRole) => {
  return (
    (
      await dbWrite.$queryRawUnsafe<{ providerAccountId: string }[]>(`
      SELECT
        "providerAccountId"
      FROM "Account"
      WHERE
          provider = 'discord'
      AND metadata -> 'roles' @> '["${role.name}"]';`)
    )?.map((x) => x.providerAccountId) ?? []
  );
};

const addRoleToAccounts = async (role: DiscordRole, providerAccountIds: string[]) => {
  // Update discord
  const tasks = providerAccountIds.map((providerAccountId) => async () => {
    try {
      await discord.addRoleToUser(providerAccountId, role.id);
    } catch (e) {
      console.error(e);
    }
  });
  await limitConcurrency(tasks, 10);

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
  const tasks = providerAccountIds.map((providerAccountId) => async () => {
    try {
      await discord.removeRoleFromUser(providerAccountId, role.id);
    } catch (e) {
      console.error(e);
    }
  });
  await limitConcurrency(tasks, 10);

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
