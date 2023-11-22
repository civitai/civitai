import { createNotification } from '~/server/services/notification.service';
import { createEvent } from './base.event';
import Rand, { PRNG } from 'rand-seed';

type CosmeticData = {
  lights: number;
  upgradedLights: number;
  earned: [number, number][];
};

const milestones = [5, 10, 15, 20, 25, 30, 31];
export const holiday2023 = createEvent('holiday2023', {
  title: 'Holiday 2023',
  startDate: new Date('2023-11-01T00:00:00.000Z'),
  endDate: new Date('2024-01-01T07:00:00.000Z'),
  teams: ['Yellow', 'Red', 'Green', 'Blue'],
  bankIndex: -100,
  cosmeticName: 'Holiday Garland 2023',
  async onEngagement({ entityType, entityId, userId, db }) {
    // Determine bulb type (post = standard, model = upgraded, article = upgraded)
    const bulbType = entityType === 'post' ? 'standard' : 'upgraded';

    // Check to see if they've already engaged for the day
    const engagedActivity = await holiday2023.getKey<Record<typeof bulbType, boolean>>(`${userId}`);
    if (engagedActivity[bulbType]) return;

    // Get User Cosmetic Data
    const cosmeticId = await holiday2023.getUserCosmeticId(userId);
    if (!cosmeticId) return;
    const userCosmetic = await db.userCosmetic.findFirst({
      where: { cosmeticId, userId },
      select: { data: true },
    });
    if (!userCosmetic) return;
    const data = (userCosmetic.data ?? {}) as CosmeticData;
    if (!data.lights) data.lights = 0;
    if (!data.upgradedLights) data.upgradedLights = 0;
    if (!data.earned) data.earned = [];

    // Check for duplicate engagement
    const alreadyEarned = data.earned.some(([id]) => id === entityId);
    if (alreadyEarned) return;

    // Increment lights
    if (bulbType === 'standard' || !engagedActivity.standard) {
      data.lights += 1;
      data.earned.push([entityId, Date.now()]);
    }
    if (bulbType === 'upgraded') data.upgradedLights += 1;

    // Set redis key for day
    engagedActivity[bulbType] = true;
    if (bulbType === 'upgraded') engagedActivity.standard = true;
    await holiday2023.setKey(`${userId}`, engagedActivity);

    // Update userCosmetic
    await db.userCosmetic.updateMany({
      where: { cosmeticId, userId },
      data: { data },
    });

    // Check for milestone
    const milestone = milestones.find((m) => data.lights == m);
    if (!milestone) return;

    // Send notification about available award
    const milestoneCosmeticId = await holiday2023.getCosmetic(`Holiday 2023: ${milestone} lights`);
    if (!milestoneCosmeticId) return;
    await createNotification({
      userId,
      id: `holiday2023:${userId}:${milestone}lights`,
      type: 'system-announcement',
      details: {
        message: `You've earned the ${milestone} lights badge for the Holiday 2023 event!`,
        url: `/claim/cosmetic/${milestoneCosmeticId}`,
      },
    });
  },
  async onDailyReset({ scores, db }) {
    for (const { team, rank } of scores) {
      const cosmeticId = await holiday2023.getTeamCosmetic(team);
      if (!cosmeticId) continue;

      // Update cosmetic brightness based on rank
      const brightness = (scores.length - rank + 1) / scores.length;
      await db.$executeRaw`
        UPDATE "Cosmetic"
        SET data = jsonb_set(data, '{brightness}', ${brightness})
        WHERE id = ${cosmeticId}
      `;
    }
  },
});
