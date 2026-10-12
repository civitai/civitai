/**
 * Text-scan rollout: put a text-scan verdict on the LIVE row of recently-saved entities after the
 * entity goes `active` (shadow verdicts live on a different row key and are never reused).
 * Deleted once every entity is active.
 *
 * POST /api/admin/temp/text-scan-rescan   (moderator session or `Authorization: Bearer <moderator API key>`)
 *   { "entityType": "Post", "entityIds": [...], "concurrency"?: 2, "dryRun"?: true, "force"?: false }
 *     REAL scans (billed, recorded, acted on) for ids whose mode is `active`; the rest are
 *     reported `not-active` and never submitted. Defaults to a dry run reporting each id's mode.
 *     Without `force`, an id whose live row already holds a verdict for the same text, prompts and
 *     model is skipped as `unchanged`, so re-running a chunk costs nothing. `force: true` rescans
 *     those too.
 */
import pLimit from 'p-limit';
import * as z from 'zod';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { getTextScanProfile, isTextScanEntityType } from '~/server/services/text-scan/profiles';
import { scanEntity } from '~/server/services/text-scan/submit';
import type { TextScanEntityType } from '~/server/services/text-scan/types';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const schema = z.object({
  entityType: z
    .string()
    .refine(isTextScanEntityType, 'not a text-scan entity type')
    .transform((value) => value as TextScanEntityType),
  entityIds: z.array(z.number().int().positive()).min(1).max(200),
  concurrency: z.number().int().min(1).max(8).default(2),
  dryRun: z.boolean().default(true),
  force: z.boolean().default(false),
});

export default defineModeratorEndpoint('textScan.rescan', {
  summary: 'Text-scan rollout backfill: scan the live row of entities whose mode is active.',
  returns: '{ entityType, count, dryRun, force, byMode, byStatus, results }',
  notes: [
    'dryRun defaults to true and only evaluates each id’s mode.',
    'Real scans are billed and acted on exactly as on a save; ids not in `active` mode are never submitted.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: schema,
  async handler(input) {
    const { entityType } = input;
    if (!getTextScanProfile(entityType))
      throw throwBadRequestError(`no profile registered for ${entityType}`);

    const limit = pLimit(input.concurrency);
    const results = await Promise.all(
      input.entityIds.map((entityId) =>
        limit(async () => {
          const mode = await getTextScanMode(entityType, entityId);
          if (input.dryRun) return { entityId, mode, status: 'dry-run' };
          if (mode !== 'active') return { entityId, mode, status: 'not-active' };
          const scan = await scanEntity({ entityType, entityId, force: input.force });
          return {
            entityId,
            mode,
            status: scan.status === 'skipped' ? `skipped/${scan.reason}` : scan.status,
          };
        })
      )
    );
    const tally = (key: 'mode' | 'status') =>
      results.reduce<Record<string, number>>((acc, r) => {
        acc[r[key]] = (acc[r[key]] ?? 0) + 1;
        return acc;
      }, {});
    return {
      entityType,
      count: results.length,
      dryRun: input.dryRun,
      force: input.force,
      byMode: tally('mode'),
      byStatus: tally('status'),
      results,
    };
  },
});
