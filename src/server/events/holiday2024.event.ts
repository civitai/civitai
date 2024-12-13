import dayjs from 'dayjs';
import { NotificationCategory } from '~/server/common/enums';
import { redis } from '~/server/redis/client';
import { createNotification } from '~/server/services/notification.service';
import { createEvent, DonationCosmeticData } from './base.event';

type CosmeticData = {
  lights: number;
  upgradedLights: number;
  earned: [number, number][];
  milestonesEarned: number[];
} & DonationCosmeticData;

const lightMilestones = [1, 12];
const donationRewards = {
  Donor: 5000,
  'Golden Donor': 25000,
};
export const holiday2024 = createEvent('holiday2024', {
  title: 'Getting Buzzed for the Holidays',
  startDate: new Date('2024-12-12T08:00:00.000Z'),
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
    const dayKey = `packed:holiday2024:${dayStr}`;
    const alreadyEngaged = await redis.packed.hGet<true>(dayKey, `${userId}`);
    if (alreadyEngaged) return;

    // Get User Cosmetic Data
    const cosmeticId = await holiday2024.getUserCosmeticId(userId);
    if (!cosmeticId) return;
    const userCosmetic = await db.userCosmetic.findFirst({
      where: { cosmeticId, userId },
      select: { data: true },
    });
    if (!userCosmetic) return;
    const data = (userCosmetic.data ?? {}) as CosmeticData;
    if (!data.lights) data.lights = 0;
    if (!data.earned) data.earned = [];

    // Check for duplicate engagement
    const alreadyEarned = data.earned.some(([id]) => id === entityId);
    if (alreadyEarned) return;

    // Increment lights
    data.lights += 1;
    if (data.lights > 12) data.lights = 12; // Cap at 12
    data.earned.push([entityId, Date.now()]);

    // Set redis key for day
    await redis.packed.hSet(dayKey, `${userId}`, true);

    // Update userCosmetic
    await db.userCosmetic.updateMany({
      where: { cosmeticId, userId },
      data: { data },
    });

    // Update cache
    await holiday2024.clearUserCosmeticCache(userId);

    // Check for milestone
    const milestone = lightMilestones.find((m) => data.lights == m);
    if (!milestone) return;

    // Send notification about available award
    const milestoneCosmeticId = await holiday2024.getCosmetic(`Holiday 2024: ${milestone} lights`);
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
      await buzzEvent.db.$executeRaw`
        UPDATE "UserCosmetic"
        SET data = jsonb_set(
          COALESCE(data, '{}'::jsonb),
          '{milestonesEarned}',
          COALESCE(
              (data->'milestonesEarned')::jsonb || to_jsonb(${json}::jsonb),
              to_jsonb(${json}::jsonb)
          ),
          true
        )
        WHERE "cosmeticId" = ${cosmeticId} AND "userId" = ${buzzEvent.userId}
      `;
    }
  },
  async onDailyReset({ scores, db }) {
    const yesterdayStr = dayjs().utc().subtract(1, 'day').format('YYYY-MM-DD');
    const yesterdayKey = `packed:holiday2024:${yesterdayStr}`;
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
