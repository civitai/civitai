import dayjs from '~/shared/utils/dayjs';
import { NotificationCategory } from '~/server/common/enums';
import { cosmeticCache, cosmeticEntityCaches } from '~/server/redis/caches';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { createNotification } from '~/server/services/notification.service';
import type { DonationCosmeticData } from './base.event';
import { createEvent } from './base.event';

type CosmeticData = {
  lights: number;
  upgradedLights: number;
  earned: [number, number][];
  milestonesEarned: number[];
} & DonationCosmeticData;

const lightMilestones = [1, 6, 12];
const donationRewards = {
  Donor: 5000,
  'Golden Donor': 25000,
};
export const holiday2024 = createEvent(REDIS_KEYS.HOLIDAY['2024']['BASE'], {
  title: 'Get Lit & Give Back 2024',
  startDate: new Date('2024-12-14T00:00:00.000Z'),
  endDate: new Date('2025-01-01T08:00:00.000Z'),
  teams: ['Yellow', 'Red', 'Green', 'Blue'],
  bankIndex: -110,
  cosmeticName: 'Holiday Garland 2024',
  badgePrefix: 'Holiday 2024',
  coverImageCollection: 'Holiday 2024: Banners',
  async onEngagement({ entityType, entityId, userId, db }) {
    if (entityType !== 'challenge') return;

    // Check to see if they've already engaged for the day
    const dayStr = dayjs().utc().format('YYYY-MM-DD');
    const dayKey = `${REDIS_KEYS.HOLIDAY['2024']['CACHE']}:${dayStr}` as const;
    const alreadyEngaged = await redis.packed.hGet<true>(dayKey, `${userId}`);
    if (alreadyEngaged) return;

    // Get User Cosmetic Data
    const cosmeticId = await holiday2024.getUserCosmeticId(userId);
    if (!cosmeticId) return;
    const userCosmetic = await db.userCosmetic.findFirst({
      where: { cosmeticId, userId },
      select: { data: true, equippedToId: true, equippedToType: true },
    });
    if (!userCosmetic) return;
    const data = (userCosmetic.data ?? {}) as CosmeticData;
    data.lights ??= 0;
    data.earned ??= [];
    data.milestonesEarned ??= [];

    // Check for duplicate engagement
    const alreadyEarned = data.earned.some(([id]) => id === entityId);
    if (alreadyEarned) return;

    // Increment lights
    data.earned.push([entityId, Date.now()]);
    data.lights = Math.min(data.earned.length, 12); // Cap at 12

    // Set redis key for day
    await redis.packed.hSet(dayKey, `${userId}`, true);

    // Check for milestone
    for (const milestone of lightMilestones) {
      if (data.milestonesEarned.includes(milestone)) continue;
      if (data.lights < milestone) continue;

      // Send notification about available award
      const milestoneCosmeticId = await holiday2024.getCosmetic(
        `Holiday 2024: ${milestone} lights`
      );
      if (!milestoneCosmeticId) return;
      await createNotification({
        userId,
        key: `holiday2024:${userId}:${milestone}lights`,
        type: 'system-announcement',
        category: NotificationCategory.System,
        details: {
          message: `You've earned the ${milestone} lights badge! Claim it now.`,
          url: `/claim/cosmetic/${milestoneCosmeticId}`,
        },
      });

      // Append for update
      data.milestonesEarned.push(milestone);
    }

    // Update userCosmetic
    await db.userCosmetic.updateMany({
      where: { cosmeticId, userId },
      data: { data },
    });

    // Update cache
    await holiday2024.clearUserCosmeticCache(userId);
    // Refresh equipped entity
    if (userCosmetic.equippedToId && userCosmetic.equippedToType)
      await cosmeticEntityCaches[userCosmetic.equippedToType].refresh(userCosmetic.equippedToId);
  },
  async onDonate(buzzEvent) {
    const data = (buzzEvent.userCosmeticData ?? {}) as CosmeticData;
    data.purchased ??= 0;
    data.donated ??= 0;
    data.milestonesEarned ??= [];

    const newMilestones: number[] = [];

    // Check for milestone
    for (const [key, milestone] of Object.entries(donationRewards)) {
      if (data.milestonesEarned.includes(milestone)) continue;
      if (data.purchased < milestone || data.donated < milestone) continue;

      // Send notification about available award
      const milestoneCosmeticId = await holiday2024.getCosmetic(`Holiday 2024: ${key}`);
      if (!milestoneCosmeticId) return;
      await createNotification({
        userId: buzzEvent.userId,
        key: `holiday2024:${buzzEvent.userId}:${milestone}donated`,
        type: 'system-announcement',
        category: NotificationCategory.System,
        details: {
          message: `You've earned the ${key} badge! Claim it now.`,
          url: `/claim/cosmetic/${milestoneCosmeticId}`,
        },
      });

      // Append for update
      newMilestones.push(milestone);
    }

    // Update milestonesEarned on user cosmetic
    if (newMilestones.length) {
      const cosmeticId = await holiday2024.getUserCosmeticId(buzzEvent.userId);
      const json = JSON.stringify(newMilestones);
      await buzzEvent.db.$executeRawUnsafe(`
        UPDATE "UserCosmetic"
        SET data = jsonb_set(
          COALESCE(data, '{}'::jsonb),
          '{milestonesEarned}',
          COALESCE(
              (data->'milestonesEarned')::jsonb || to_jsonb('${json}'::jsonb),
              to_jsonb('${json}'::jsonb)
          ),
          true
        )
        WHERE "cosmeticId" = ${cosmeticId} AND "userId" = ${buzzEvent.userId}
      `);
    }
  },
  async onDailyReset({ scores, db }) {
    const yesterdayStr = dayjs().utc().subtract(1, 'day').format('YYYY-MM-DD');
    const yesterdayKey = `${REDIS_KEYS.HOLIDAY['2024']['CACHE']}:${yesterdayStr}` as const;
    await redis.del(yesterdayKey);

    // Update light brightness
    for (const { team, rank } of scores) {
      const cosmeticId = await holiday2024.getTeamCosmetic(team);
      if (!cosmeticId) continue;

      // Update cosmetic brightness based on rank
      const brightness = (scores.length - rank + 1) / scores.length;
      await db.$executeRawUnsafe(`
        UPDATE "Cosmetic"
        SET data = jsonb_set(data, '{brightness}', to_jsonb(${brightness}))
        WHERE id = ${cosmeticId}
      `);

      // Refresh cache
      await cosmeticCache.refresh(cosmeticId);
    }
  },
  async onCleanup({ winner, winnerCosmeticId, db }) {
    // Get winners badge
    const badgeId = await holiday2024.getCosmetic(`Holiday 2024: ${winner} Victory`);
    if (!badgeId) return;

    // Get winners
    const winners = (
      await db.userCosmetic.findMany({
        where: { cosmeticId: winnerCosmeticId },
        select: { userId: true },
      })
    ).map((x) => x.userId);

    // Send notification to winner
    await createNotification({
      userIds: winners,
      type: 'system-announcement',
      category: NotificationCategory.System,
      key: `holiday2024:winner`,
      details: {
        message: `Your team won the Holiday 2024 event! Claim your animated victory badge now!`,
        url: `/claim/cosmetic/${badgeId}`,
      },
    });
  },
});
