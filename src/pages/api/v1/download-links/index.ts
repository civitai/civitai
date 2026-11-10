import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { resolveDownloadLinkMinter } from '~/server/services/download-link/download-link-minter';
import type { MintItem } from '~/server/services/download-link/download-link.service';
import {
  DEFAULT_LINK_TTL_SECONDS,
  mintDownloadLinks,
} from '~/server/services/download-link/download-link.service';
import { MAX_LINK_TTL_SECONDS } from '~/server/services/download-link/download-link.store';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

export const config = { api: { bodyParser: { sizeLimit: '32kb' } } };

const MAX_ITEMS = 50;
const id = z.number().int().positive();
const ttlSeconds = z
  .number()
  .int()
  .min(300)
  .max(MAX_LINK_TTL_SECONDS)
  .default(DEFAULT_LINK_TTL_SECONDS);

// Strict: a public item may not name a user, and a user item may not claim a mode.
const publicItem = z.strictObject({
  mode: z.literal('public'),
  modelVersionId: id,
  fileId: id.optional(),
  ttlSeconds,
});
const userItem = z.strictObject({
  modelVersionId: id,
  fileId: id.optional(),
  onBehalfOfUserId: id,
  workflowId: z.string().trim().min(1).max(200),
  ttlSeconds,
});
const bodySchema = z.object({
  items: z
    .array(z.union([publicItem, userItem]))
    .min(1)
    .max(MAX_ITEMS),
});

/**
 * Mints download links for generation jobs: `{ items: [...] }` in, `{ items: [...] }` out, one
 * result per item in request order.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const minter = await resolveDownloadLinkMinter(req);
    if (!minter.ok)
      return res
        .status(minter.status)
        .json({ error: minter.status === 401 ? 'Unauthorized' : 'Forbidden' });

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
    const items: MintItem[] = parsed.data.items.map((item) =>
      'mode' in item ? item : { ...item, mode: 'user' }
    );

    const outcome = await mintDownloadLinks(minter.credential, items);
    if (outcome.status === 503)
      return res.status(503).json({ error: 'Download links are disabled' });
    if (outcome.status === 429) {
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many requests' });
    }
    return res.status(200).json({ items: outcome.items });
  } catch (error) {
    logToAxiom({
      ...safeError(error),
      name: 'download-link',
      type: 'error',
      message: 'mint-failed',
    }).catch(() => undefined);
    return handleEndpointError(res, error);
  }
}
