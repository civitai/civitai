import type { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import * as z from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { events } from '~/server/events';
import dayjs from '~/shared/utils/dayjs';

const schema = z.object({
  eventName: z.string().trim().nonempty(),
});

export default ModEndpoint(
  async function unequipEventCosmetic(req: NextApiRequest, res: NextApiResponse) {
    const { eventName } = schema.parse(req.query);
    const eventDef = events.find((e) => e.name === eventName);

    if (!eventDef) return res.status(400).json({ error: 'Invalid event name' });
    if (dayjs().isBetween(eventDef.startDate, eventDef.endDate))
      return res.status(400).json({ error: 'Event is still active' });

    for (const team of eventDef.teams) {
      const cosmeticId = await eventDef.getTeamCosmetic(team);
      if (!cosmeticId) continue;

      await dbWrite.userCosmetic.updateMany({
        where: { cosmeticId, equippedAt: { not: null } },
        data: { equippedAt: null },
      });
    }

    return res.status(200).json({ ok: true });
  },
  ['GET']
);
