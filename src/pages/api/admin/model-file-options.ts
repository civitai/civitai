/**
 * Mod-managed model file precision + quant-type lists (KeyValue: modelFileOptions).
 * Backs the model file editor dropdowns + download metadata; defaults live in
 * constants.modelFileFp / modelFileQuantTypes and are used until this row is set.
 *
 * Usage: /api/admin/model-file-options?token=$WEBHOOK_TOKEN   (body: { precisions?, quantTypes? })
 *   GET      return current { precisions, quantTypes }
 *   PUT      replace the provided list(s) wholesale
 *   POST     add the provided value(s) to the existing list(s)
 *   DELETE   remove the provided value(s) from the existing list(s)
 *
 * GET reads the DB directly (this endpoint isn't edge-cached) so it's always live. A write
 * purges the public procedure's edge cache (tag: model-file-options) so new requests fetch fresh
 * immediately; already-loaded clients still refetch on their 3-min React Query staleTime.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  addModelFileOptions,
  getModelFileOptions,
  removeModelFileOptions,
  setModelFileOptions,
} from '~/server/services/model-file.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const bodySchema = z
  .object({
    precisions: z.array(z.string().trim().min(1)).min(1).optional(),
    quantTypes: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .refine((d) => !!d.precisions || !!d.quantTypes, {
    message: 'Provide at least one of precisions or quantTypes',
  });

const writers = {
  PUT: setModelFileOptions,
  POST: addModelFileOptions,
  DELETE: removeModelFileOptions,
} as const;

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') {
    return res.status(200).json(await getModelFileOptions());
  }

  const writer = writers[req.method as keyof typeof writers];
  if (!writer) {
    res.setHeader('Allow', 'GET, PUT, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  return res.status(200).json(await writer(parsed.data));
});
