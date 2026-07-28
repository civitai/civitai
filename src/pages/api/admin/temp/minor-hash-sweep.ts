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
 *   limit   - default 100, max 1000. Caps models FLAGGED per call, not the
 *             candidate set — the reported split always covers the full
 *             population, so a dry run at any limit shows the real totals.
 *
 * Only same-uploader matches are ever flagged. Different-uploader matches are
 * reported as a count and reviewed at /moderator/minor-hash-matches.
 *
 * A run that writes is logged to Axiom (`minor-hash-sweep`) before responding,
 * so a gateway timeout still leaves a record of what committed.
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

  // Next leaves req.body as '' when there's no content-type, and '' is not
  // nullish — `?? {}` would hand an empty string to safeParse.
  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const parsed = schema.safeParse(body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const report = await sweepMinorHashMatches(parsed.data);
    return res.status(200).json(report);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
