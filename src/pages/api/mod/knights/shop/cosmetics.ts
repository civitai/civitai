import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  equipKnightsShopCosmetic,
  KnightsCosmeticRefused,
  refreshKnightsShopCosmetics,
  unequipKnightsShopCosmetic,
} from '~/server/services/knights/shop.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('refresh'), userId: z.coerce.number().int().positive() }),
  z.object({
    action: z.literal('equip'),
    userId: z.coerce.number().int().positive(),
    cosmeticId: z.coerce.number().int().positive(),
  }),
  z.object({
    action: z.literal('unequip'),
    userId: z.coerce.number().int().positive(),
    cosmeticId: z.coerce.number().int().positive(),
  }),
]);

// Knights inserts UserCosmetic rows itself, then calls `refresh` so the main app's cosmetic caches match, and
// `equip`/`unequip` for the inventory so the main app's own rules run. A refusal is a 409 with the message to show.
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const body = parsed.data;

  try {
    if (body.action === 'refresh') await refreshKnightsShopCosmetics(body.userId);
    else if (body.action === 'equip') await equipKnightsShopCosmetic(body);
    else await unequipKnightsShopCosmetic(body);
  } catch (error) {
    if (error instanceof KnightsCosmeticRefused) {
      return res.status(409).json({ error: error.message, reason: 'refused' });
    }
    throw error;
  }
  return res.status(200).json({ ok: true });
});
