import { createJob } from './job';
import { dbRead, dbWrite } from '~/server/db/client';
import { discord } from '~/server/integrations/discord';

const LAST_RUN_KEY = 'last-applied-roles';
export const applyDiscordRoles = createJob('apply-discord-roles', '*/10 * * * *', async () => {
  // Get the last pushed time from keyValue
  const lastUpdated = new Date(
    ((
      await dbRead.keyValue.findUnique({
        where: { key: LAST_RUN_KEY },
      })
    )?.value as number) ?? 0
  );

  const discordRoles = await discord.getAllRoles();

  const supporterRole = discordRoles.find((r) => r.name === 'Supporter');
  if (supporterRole) {
    // Add the supporter role to any new supporters
    const newSupporters = await dbRead.customerSubscription.findMany({
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
    });

    const supporterIds = newSupporters.map((s) => s.user.accounts[0].providerAccountId);
    for (const supporterId of supporterIds)
      await discord.addRoleToUser(supporterId, supporterRole.id);

    // Remove the supporter role from any expired supporters
    const expiredSupporters = await dbRead.customerSubscription.findMany({
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
    });

    const expiredSupporterIds = expiredSupporters.map((s) => s.user.accounts[0].providerAccountId);
    for (const expiredSupporterId of expiredSupporterIds)
      await discord.removeRoleFromUser(expiredSupporterId, supporterRole.id);
  }

  // Update the last pushed time
  // --------------------------------------------
  await dbWrite?.keyValue.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });
});
