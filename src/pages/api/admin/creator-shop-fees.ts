/**
 * Mod-managed Creator Shop submission fees (KeyValue: creatorShopFees).
 * Per cosmetic type, plus one figure for packs (a pack has no CosmeticType).
 * Defaults live in creator-shop.schema and apply until this row sets a value.
 *
 * Usage: /api/admin/creator-shop-fees?token=$WEBHOOK_TOKEN
 *   GET   return the effective fees { submission: { <CosmeticType>: n }, pack: n }
 *   PUT   set the provided fees; omitted types keep their current value
 *         body: { submission?: { Sticker?: 5000, ... }, pack?: 1000 }
 *
 * GET reads the DB directly (this endpoint isn't edge-cached) so it's always live. A write
 * purges the public procedure's edge cache (tag: creator-shop-fees) so the submit form quotes
 * the new fee immediately; already-loaded clients still refetch on their 3-min staleTime.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { creatorCosmeticTypes } from '~/server/schema/creator-shop.schema';
import {
  getCreatorShopFees,
  setCreatorShopFees,
} from '~/server/services/creator-shop-fees.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const fee = z.number().int().min(0);

const bodySchema = z
  .object({
    submission: z.partialRecord(z.enum(creatorCosmeticTypes), fee).optional(),
    pack: fee.optional(),
  })
  .refine((d) => !!d.submission || d.pack !== undefined, {
    message: 'Provide at least one of submission or pack',
  });

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') {
    return res.status(200).json(await getCreatorShopFees());
  }

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: z.flattenError(parsed.error) });

  return res.status(200).json(await setCreatorShopFees(parsed.data));
});
