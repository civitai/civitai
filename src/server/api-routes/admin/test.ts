/**
 * Local-dev / debug endpoint. Action-routed.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query
 * param (see WebhookEndpoint). Not reachable without the secret; no public UI.
 *
 * Usage:
 *   GET or POST /api/admin/test?token=$WEBHOOK_TOKEN&action=<action>&...params
 *
 * Actions:
 *   refresh-content-cache              — refresh userContentOverviewCache for `theally`
 *                                        (the original behavior of this endpoint).
 *   import-wildcard-set                — {modelVersionId} download a single Wildcards-type
 *                                        ModelVersion's primary file (.zip, .txt, .yaml,
 *                                        or .yml), extract category entries (zip walks
 *                                        .txt + .yaml entries; yaml is parsed as a tree
 *                                        with leaf arrays becoming categories named by
 *                                        their key path), normalize __name__ → #name,
 *                                        and create the WildcardSet + WildcardSetCategory
 *                                        rows. Idempotent — second call returns already_exists.
 *   reconcile-wildcard-sets            — {limit?} scan Published Wildcards-type
 *                                        ModelVersions that don't yet have a WildcardSet and
 *                                        provision them. Capped per call (default 100, max 500).
 *                                        Re-run until `scanned` is 0 to drain the backlog.
 *   list-pending-wildcard-models       — {limit?} read-only — list the next N Wildcards-type
 *                                        Published ModelVersions still missing a WildcardSet.
 *                                        Useful for previewing what reconcile would do.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import {
  importWildcardModelVersion,
  reconcileWildcardSets,
} from '~/server/services/wildcard-set-provisioning.service';
import { userContentOverviewCache } from '~/server/redis/caches';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const actionSchema = z.enum([
  'refresh-content-cache',
  'import-wildcard-set',
  'reconcile-wildcard-sets',
  'list-pending-wildcard-models',
]);

const schema = z
  .object({
    action: actionSchema,
    modelVersionId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === 'import-wildcard-set' && !data.modelVersionId) {
      ctx.addIssue({
        code: 'custom',
        message: 'import-wildcard-set requires modelVersionId',
        path: ['modelVersionId'],
      });
    }
  });

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.safeParse({ ...req.query, ...(req.body ?? {}) });
  if (!payload.success) {
    return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
  }
  const input = payload.data;

  try {
    switch (input.action) {
      case 'refresh-content-cache': {
        const user = await dbRead.user.findUnique({
          where: { username: 'theally' },
          select: { id: true },
        });
        if (!user) return res.status(404).json({ error: 'User not found' });
        await userContentOverviewCache.refresh(user.id);
        return res.status(200).json({
          action: input.action,
          message: `Refreshed content overview cache for user ${user.id}`,
        });
      }

      case 'import-wildcard-set': {
        const result = await importWildcardModelVersion(input.modelVersionId!);
        const status = result.status === 'failed' ? 400 : 200;
        return res.status(status).json({ action: input.action, ...result });
      }

      case 'reconcile-wildcard-sets': {
        const result = await reconcileWildcardSets({ limit: input.limit });
        return res.status(200).json({ action: input.action, ...result });
      }

      case 'list-pending-wildcard-models': {
        const limit = input.limit ?? 25;
        const pending = await dbRead.modelVersion.findMany({
          where: {
            status: 'Published',
            model: { type: 'Wildcards' },
            wildcardSet: null,
          },
          select: {
            id: true,
            name: true,
            model: { select: { id: true, name: true } },
            files: { select: { id: true, name: true, sizeKB: true } },
          },
          take: limit,
          orderBy: { id: 'asc' },
        });
        return res.status(200).json({ action: input.action, count: pending.length, pending });
      }
    }
  } catch (e) {
    console.log(e);
    return res.status(500).json({ error: (e as Error).message, stack: (e as Error).stack });
  }
});
