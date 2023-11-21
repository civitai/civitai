import { dbWrite } from '~/server/db/client';
import { EngagementEvent } from '~/server/events/base.event';
import { holiday2023 } from '~/server/events/holiday2023.event';

const events = [holiday2023].filter((x) => x.endDate >= new Date());

export const eventEngine = {
  async processEngagement(event: EngagementEvent) {
    const ctx = { ...event, db: dbWrite };
    for (const eventDef of events) {
      if (eventDef.startDate <= new Date() && eventDef.endDate >= new Date()) {
        await eventDef.onEngagement?.(ctx);
      }
    }
  },
  async cleanUp() {
    for (const eventDef of events) {
      await eventDef.clearKeys();

      // If the event is over, unequip the event cosmetic from all users
      if (eventDef.endDate < new Date()) {
        const cosmeticId = await eventDef.getCosmetic();
        if (!cosmeticId) continue;

        await dbWrite.userCosmetic.updateMany({
          where: { cosmeticId },
          data: { equippedAt: null },
        });
      }
    }
  },
};
