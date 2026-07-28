/**
 * One-off backfill for hash-based repeat-uploader detection (ClickUp 868kfvpjc).
 * =============================================================================
 *
 * Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Usage:
 *   POST /api/admin/temp/minor-hash-sweep?token=$WEBHOOK_TOKEN
 *   Body: { "dryRun": true, "limit": 100 }
 *
 * Params:
 *   dryRun  - default true. When true, nothing is written; the report shows
 *             the candidate split and a 20-row sample.
 *   limit   - default 100, max 1000. Caps candidates examined per call.
 *
 * Only same-uploader matches are ever flagged. Different-uploader matches are
 * reported as a count and reviewed at /moderator/minor-hash-matches.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { sweepMinorHashMatches } from '~/server/services/minor-hash.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  dryRun: z.boolean().default(true),
  limit: z.number().min(1).max(1000).default(100),
});

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const report = await sweepMinorHashMatches(parsed.data);

  return res.status(200).json(report);
});
