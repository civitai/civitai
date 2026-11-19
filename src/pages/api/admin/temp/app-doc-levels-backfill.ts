/**
 * Content levels, build 3: the BACKFILL. Rates the existing shared documents of ONE app, so they
 * are rated before its `app-blocks-shared-doc-levels` flag is turned on. The same pass the
 * `app-doc-rater` job runs (`rateUnratedDocs`), for this app only and whatever its flag says.
 *
 * POST /api/admin/temp/app-doc-levels-backfill?token=$WEBHOOK_TOKEN
 * Body:
 *   appBlockId: string   // REQUIRED, the one app to rate.
 *   perPass?: number     // documents acted on per call, 1-500, default 200.
 *   dryRun?: boolean     // count the unrated documents without rating any. Default true.
 *
 * Re-run until a dry run reports `unrated: 0`. Each call submits text scans; their verdicts arrive
 * by callback, so a document is rated a few seconds to minutes after the call that submitted it,
 * and a later call rates the ones whose verdict was already stored. It needs the rating-id
 * migration applied (`ready: false` otherwise, and nothing is done) and the text scan's `AppDoc`
 * rollout set to active (otherwise every document is `skipped`).
 *
 * A non-dry run is logged to Axiom (`app-doc-rater`) before responding.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import {
  countUnratedDocs,
  RATER_PER_PASS,
  rateUnratedDocs,
} from '~/server/services/apps/doc-rater.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  appBlockId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  perPass: z.number().int().min(1).max(RATER_PER_PASS).default(200),
  dryRun: z.boolean().default(true),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success)
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  const { appBlockId, perPass, dryRun } = parsed.data;

  if (dryRun) {
    return res
      .status(200)
      .json({ dryRun: true, appBlockId, ...(await countUnratedDocs(appBlockId)) });
  }
  const result = await rateUnratedDocs([appBlockId], { perPass });
  logToAxiom({
    name: 'app-doc-rater',
    type: 'info',
    message: 'backfill pass',
    appBlockId,
    payload: {
      ready: result.ready,
      read: result.read,
      submitted: result.submitted,
      rated: result.rated,
      waiting: result.waiting,
      skipped: result.skipped,
      failed: result.failed,
    },
  });
  return res.status(200).json({ dryRun: false, appBlockId, ...result });
});
