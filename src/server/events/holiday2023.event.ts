import { createNotification } from '~/server/services/notification.service';
import { BuzzEventContext, createEvent, DonationCosmeticData } from './base.event';

type CosmeticData = {
  lights: number;
  upgradedLights: number;
  earned: [number, number][];
  milestonesEarned: number[];
} & DonationCosmeticData;

const lightMilestones = [5, 15, 25];
const donationRewards = {
  Donor: 5000,
  'Golden Donor': 25000,
};
export const holiday2023 = createEvent('holiday2023', {
  title: 'Get Lit & Give Back',
  startDate: new Date('2023-12-01T08:00:00.000Z'),
  endDate: new Date('2024-01-01T08:00:00.000Z'),
  teams: ['Yellow', 'Red', 'Green', 'Blue'],
  bankIndex: -100,
  cosmeticName: 'Holiday Garland 2023',
  badgePrefix: 'Holiday 2023',
  coverImageCollection: 'Holiday 2023: Banners',
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

    // Update cache
    await holiday2023.clearUserCosmeticCache(userId);

    // Check for milestone
    const milestone = lightMilestones.find((m) => data.lights == m);
    if (!milestone) return;

    // Send notification about available award
    const milestoneCosmeticId = await holiday2023.getCosmetic(`Holiday 2023: ${milestone} lights`);
    if (!milestoneCosmeticId) return;
    await createNotification({
      userId,
      id: `holiday2023:${userId}:${milestone}lights`,
      type: 'system-announcement',
      category: 'System',
      details: {
        message: `You've earned the ${milestone} lights badge! Claim it now.`,
        url: `/claim/cosmetic/${milestoneCosmeticId}`,
      },
    });
  },
  async onPurchase(buzzEvent) {
    await handleDonationMilestones(buzzEvent);
  },
  async onDonate(buzzEvent) {
    await handleDonationMilestones(buzzEvent);
  },
  async onDailyReset({ scores, db }) {
    for (const { team, rank } of scores) {
      const cosmeticId = await holiday2023.getTeamCosmetic(team);
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
    const badgeId = await holiday2023.getCosmetic(`Holiday 2023: ${winner} Victory`);
    if (!badgeId) return;

    // Send notification to winner
    const details = {
      message: `Your team won the Holiday 2023 event! Claim your animated victory badge now!`,
      url: `/claim/cosmetic/${badgeId}`,
    };

    await db.$executeRaw`
      INSERT INTO "Notification" ("id", "userId", "type", "details")
      SELECT
        CONCAT('holiday2023:', "userId", ':winner'),
        "userId",
        'system-announcement',
        ${JSON.stringify(details)}::jsonb
      FROM "UserCosmetic"
      WHERE "cosmeticId" = ${winnerCosmeticId}
    `;
  },
});

async function handleDonationMilestones(buzzEvent: BuzzEventContext) {
  const data = (buzzEvent.userCosmeticData ?? {}) as CosmeticData;
  data.purchased ??= 0;
  data.donated ??= 0;
  data.milestonesEarned ??= [];

  // Check for milestone
  for (const [key, milestone] of Object.entries(donationRewards)) {
    if (data.milestonesEarned.includes(milestone)) continue;
    if (data.purchased < milestone || data.donated < milestone) continue;

    // Send notification about available award
    const milestoneCosmeticId = await holiday2023.getCosmetic(`Holiday 2023: ${key}`);
    if (!milestoneCosmeticId) return;
    await createNotification({
      userId: buzzEvent.userId,
      id: `holiday2023:${buzzEvent.userId}:${milestone}donated`,
      type: 'system-announcement',
      category: 'System',
      details: {
        message: `You've earned the ${key} badge! Claim it now.`,
        url: `/claim/cosmetic/${milestoneCosmeticId}`,
      },
    });

    // Update userCosmetic
    data.milestonesEarned.push(milestone);
    const cosmeticId = await holiday2023.getUserCosmeticId(buzzEvent.userId);
    await buzzEvent.db.userCosmetic.updateMany({
      where: { cosmeticId, userId: buzzEvent.userId },
      data: { data },
    });
  }
}
