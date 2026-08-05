/**
 * Backfill + rollback for hash-based repeat-uploader detection (ClickUp 868kfvpjc).
 * =============================================================================
 *
 * Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Usage:
 *   GET /api/admin/temp/minor-hash-sweep?token=$WEBHOOK_TOKEN&dryRun=true&limit=1000
 *   GET /api/admin/temp/minor-hash-sweep?token=$WEBHOOK_TOKEN&action=rollback&dryRun=true
 *
 * Params:
 *   action  - default 'sweep'.
 *             'sweep'    flags same-uploader hash matches (see sweepMinorHashMatches).
 *             'rollback' undoes prior flags using the snapshot setModelMinor records,
 *                        restoring nsfw/sfwOnly/gallery level/lockedProperties and
 *                        previously-minor images. Without `modelIds` it covers only
 *                        AUTOMATED flags, and skips any a moderator has since
 *                        confirmed by hand (see rollbackMinorHashAutoFlags).
 *   modelIds - rollback only. Comma-separated model ids for a targeted undo, e.g.
 *              `&modelIds=123,456`. Rolls back exactly those models whatever the
 *              flag source (including a moderator's manual "Set as Minor") and
 *              without the human-confirmation skip — naming the model is itself the
 *              deliberate decision. This is the escape hatch for a mis-click; a
 *              blanket rollback will never touch a manual flag.
 *   dryRun  - default true for BOTH actions. When true, nothing is written; the
 *             report shows the candidate split and a sample of up to 20 rows.
 *   limit   - default 100, max 1000. Caps models WRITTEN per call (sweep: flagged;
 *             rollback: processed) — for 'sweep' the reported candidate split
 *             always covers the full population regardless of limit, so a dry run
 *             at any limit shows the real totals.
 *   concurrency - default 5, max 10. Models written in parallel.
 *
 * Both actions are resumable and idempotent: a flagged model leaves the sweep's
 * candidate set, and a rolled-back model loses its meta key. Draining prod in
 * repeated small calls (e.g. limit=50) is therefore safe and is preferable to one
 * large run, which risks a gateway timeout mid-batch.
 *
 * 'sweep' only ever flags same-uploader matches. Different-uploader matches are
 * reported as a count and reviewed at /moderator/minor-hash-matches.
 *
 * A run that writes is logged to Axiom (`minor-hash-sweep` / `minor-hash-rollback`)
 * before responding, so a gateway timeout still leaves a record of what committed.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  rollbackMinorHashAutoFlags,
  sweepMinorHashMatches,
} from '~/server/services/minor-hash.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

const schema = z.object({
  action: z.enum(['sweep', 'rollback']).default('sweep'),
  dryRun: booleanString().default(true),
  limit: z.coerce.number().min(1).max(1000).default(100),
  concurrency: z.coerce.number().min(1).max(10).default(5),
  modelIds: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((id) => Number(id.trim()))
            .filter((id) => Number.isInteger(id) && id > 0)
        : undefined
    ),
});

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { action, dryRun, limit, concurrency, modelIds } = parsed.data;

  if (modelIds && action !== 'rollback')
    return res.status(400).json({ error: 'modelIds is only valid with action=rollback' });

  try {
    const report =
      action === 'rollback'
        ? await rollbackMinorHashAutoFlags({ dryRun, limit, concurrency, modelIds })
        : await sweepMinorHashMatches({ dryRun, limit, concurrency });
    return res.status(200).json(report);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
