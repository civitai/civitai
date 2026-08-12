import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import type { DiscordRole } from '~/server/integrations/discord';
import { discord } from '~/server/integrations/discord';
import { logToAxiom } from '~/server/logging/client';
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

// Nobody sheds half the leaderboard overnight, so a revoke list that size means our view of who is ranked
// collapsed. UserRank is rebuilt by TRUNCATE + INSERT, and updateLeaderboardRank({ leaderboardIds }) — the
// hourly event path — legitimately leaves it holding only that event's users until the next nightly rebuild.
// Before this job ran unguarded that could not reach us; now it can, and it would strip the roles for real.
const REVOKE_SHARE_LIMIT = 0.5;
const REVOKE_FLOOR = 10;

const withinBlastRadius = (role: DiscordRole, revoking: string[], holders: string[]) => {
  if (holders.length < REVOKE_FLOOR) return true;
  if (revoking.length <= holders.length * REVOKE_SHARE_LIMIT) return true;

  logToAxiom({
    type: 'discord-role-sync-aborted',
    name: 'apply-discord-leaderboard-roles',
    error: {
      reason: 'revoke list too large — refusing to strip the role in bulk',
      role: role.name,
      revoking: revoking.length,
      holders: holders.length,
    },
  });
  return false;
};

const getLeaderboardRoles = async () => {
  const discordRoles = await discord.getAllRoles();

  const top10Role = discordRoles.find((r) => r.name === 'Top 10');
  const top100Role = discordRoles.find((r) => r.name === 'Top 100');
  if (!top100Role || !top10Role) {
    logToAxiom({
      type: 'discord-role-sync-aborted',
      name: 'apply-discord-leaderboard-roles',
      error: {
        reason: 'leaderboard roles not found in guild',
        missing: [!top10Role && 'Top 10', !top100Role && 'Top 100'].filter(Boolean),
      },
    });
    return null;
  }

  return { top10Role, top100Role };
};

export const applyDiscordLeaderboardRoles = async () => {
  const roles = await getLeaderboardRoles();
  if (!roles) return;
  const { top10Role, top100Role } = roles;

  const existingTop100 = await getAccountsInRole(top100Role);
  const existingTop10 = await getAccountsInRole(top10Role);

  // Get the top 100 users with a discord account
  const top100 = (
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
  ).flatMap((s) =>
    s.accounts.map((account) => ({
      rank: s.rank?.leaderboardRank,
      providerAccountId: account.providerAccountId,
    }))
  );

  // Nobody ranked with a linked Discord account is not a real state — it means UserRank is empty or mid-rebuild.
  // Continuing would read that as "everyone left the top 100" and strip the roles from every holder.
  if (!top100.length) {
    logToAxiom({
      type: 'discord-role-sync-aborted',
      name: 'apply-discord-leaderboard-roles',
      error: {
        reason: 'no ranked users with a linked discord account',
        holders: existingTop100.length,
      },
    });
    return;
  }

  const top100Ids = new Set(top100.map((u) => u.providerAccountId));
  const top10Ids = new Set(
    top100.filter((u) => u.rank && u.rank <= 10).map((u) => u.providerAccountId)
  );

  // Get the new users in the top 100 and the users that are no longer in the top 100
  const newTop100 = [...top100Ids].filter((id) => !existingTop100.includes(id));
  await addRoleToAccounts(top100Role, newTop100);

  const removedTop100 = existingTop100.filter((id) => !top100Ids.has(id));
  if (withinBlastRadius(top100Role, removedTop100, existingTop100))
    await removeRoleFromAccounts(top100Role, removedTop100);

  // Get the new users in the top 10 and the users that are no longer in the top 10
  const newTop10 = [...top10Ids].filter((id) => !existingTop10.includes(id));
  await addRoleToAccounts(top10Role, newTop10);

  const removedTop10 = existingTop10.filter((id) => !top10Ids.has(id));
  if (withinBlastRadius(top10Role, removedTop10, existingTop10))
    await removeRoleFromAccounts(top10Role, removedTop10);
};

// Grant-only sync for a single user, so linking Discord doesn't mean waiting for the nightly cron. Removals stay
// with the cron: a link should never strip a role because our rank data happens to be mid-refresh.
export const syncUserDiscordLeaderboardRoles = async (userId: number) => {
  const roles = await getLeaderboardRoles();
  if (!roles) return;
  const { top10Role, top100Role } = roles;

  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: {
      rank: { select: { leaderboardRank: true } },
      accounts: {
        select: { providerAccountId: true },
        where: { provider: 'discord' },
      },
    },
  });

  const rank = user?.rank?.leaderboardRank;
  const providerAccountIds = user?.accounts.map((a) => a.providerAccountId) ?? [];
  if (!providerAccountIds.length || !rank || rank > 100) return;

  await addRoleToAccounts(top100Role, providerAccountIds);
  if (rank <= 10) await addRoleToAccounts(top10Role, providerAccountIds);
};

const applyDiscordPaidRoles = createJob('apply-discord-paid-roles', '*/10 * * * *', async () => {
  const discordRoles = await discord.getAllRoles();

  const supporterRole = discordRoles.find((r) => r.name === 'Supporter');
  const donatorRole = discordRoles.find((r) => r.name === 'Donator');

  // Process Supporter and Donator roles in parallel
  await Promise.all([
    // Apply the Supporter Role
    (async () => {
      if (!supporterRole) return;

      const existingSupporters = await getAccountsInRole(supporterRole);

      // Get current supporters using optimized direct join query
      const supporters = new Set(
        (
          await dbWrite.$queryRaw<{ providerAccountId: string }[]>`
            SELECT DISTINCT a."providerAccountId"
            FROM "CustomerSubscription" cs
            JOIN "Account" a ON a."userId" = cs."userId" AND a.provider = 'discord'
            WHERE cs.status IN ('active', 'trialing')
          `
        )?.map((s) => s.providerAccountId) ?? []
      );

      const newSupporters = [...supporters].filter((u) => !existingSupporters.includes(u));
      await addRoleToAccounts(supporterRole, newSupporters);

      const expiredSupporters = existingSupporters.filter((u) => !supporters.has(u));
      await removeRoleFromAccounts(supporterRole, expiredSupporters);
    })(),

    // Apply the Donator Role
    (async () => {
      if (!donatorRole) return;

      const existingDonators = await getAccountsInRole(donatorRole);

      // Get current donators using optimized direct join query
      const donatorCutoff = dayjs().subtract(1, 'month').toDate();
      const donators = new Set(
        (
          await dbWrite.$queryRaw<{ providerAccountId: string }[]>`
            SELECT DISTINCT a."providerAccountId"
            FROM "Purchase" p
            JOIN "Account" a ON a."userId" = p."userId" AND a.provider = 'discord'
            WHERE p."createdAt" > ${donatorCutoff}
            AND p."priceId" = ${env.STRIPE_DONATE_ID}
          `
        )?.map((s) => s.providerAccountId) ?? []
      );

      const newDonators = [...donators].filter((u) => !existingDonators.includes(u));
      await addRoleToAccounts(donatorRole, newDonators);

      const removedDonators = existingDonators.filter((u) => !donators.has(u));
      await removeRoleFromAccounts(donatorRole, removedDonators);
    })(),
  ]);
});

export const applyDiscordRoles = [applyDiscordActivityRoles, applyDiscordPaidRoles];

// #region [utilities]
const getAccountsInRole = async (role: DiscordRole) => {
  const roleValue = JSON.stringify([role.name]);
  return (
    (
      await dbWrite.$queryRaw<{ providerAccountId: string }[]>`
      SELECT
        "providerAccountId"
      FROM "Account"
      WHERE
          provider = 'discord'
      AND metadata -> 'roles' @> ${roleValue}::jsonb`
    )?.map((x) => x.providerAccountId) ?? []
  );
};

// Our metadata is a record of what Discord accepted, so only the accounts Discord actually accepted may be
// written. Recording a role we failed to apply is unrecoverable: the next run reads it back as already-granted
// and never retries.
const applyToDiscord = async (
  role: DiscordRole,
  providerAccountIds: string[],
  action: 'add' | 'remove'
) => {
  const applied: string[] = [];
  let notInGuild = 0;
  const errors: string[] = [];

  const tasks = providerAccountIds.map((providerAccountId) => async () => {
    try {
      const ok =
        action === 'add'
          ? await discord.addRoleToUser(providerAccountId, role.id)
          : await discord.removeRoleFromUser(providerAccountId, role.id);
      if (ok) applied.push(providerAccountId);
      else notInGuild++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  });
  await limitConcurrency(tasks, 10);

  if (notInGuild || errors.length) {
    logToAxiom({
      type: 'discord-role-sync',
      name: 'apply-discord-roles',
      // civitai-prod is at its column cap, so `error` is the only top-level container new fields can go in.
      error: {
        role: role.name,
        action,
        requested: providerAccountIds.length,
        applied: applied.length,
        notInGuild,
        failed: errors.length,
        errors: [...new Set(errors)].slice(0, 5),
      },
    });
  }

  return applied;
};

const addRoleToAccounts = async (role: DiscordRole, providerAccountIds: string[]) => {
  if (providerAccountIds.length === 0) return;
  const granted = await applyToDiscord(role, providerAccountIds, 'add');
  if (granted.length === 0) return;

  const roleValue = JSON.stringify([role.name]);
  await dbWrite.$executeRaw`
    UPDATE "Account"
    SET metadata = jsonb_set(
      metadata,
      '{roles}',
      (COALESCE(metadata->'roles', '[]'::jsonb) - ${role.name}::text) || ${roleValue}::jsonb,
      true
    )
    WHERE provider = 'discord' AND "providerAccountId" IN (${Prisma.join(granted)})`;
};

const removeRoleFromAccounts = async (role: DiscordRole, providerAccountIds: string[]) => {
  if (providerAccountIds.length === 0) return;
  const revoked = await applyToDiscord(role, providerAccountIds, 'remove');
  if (revoked.length === 0) return;

  await dbWrite.$executeRaw`
    UPDATE "Account"
    SET metadata = jsonb_set(
      metadata,
      '{roles}',
      COALESCE(metadata->'roles', '[]'::jsonb) - ${role.name}::text,
      true
    )
    WHERE provider = 'discord' AND "providerAccountId" IN (${Prisma.join(revoked)})`;
};
// #endregion
