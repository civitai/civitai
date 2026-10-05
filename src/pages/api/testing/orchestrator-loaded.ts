/**
 * Debug endpoint: what the orchestrator currently holds resident.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query param
 * (not Bearer header — see TokenSecuredEndpoint). Not reachable without the
 * secret; no public UI.
 *
 * Read-only: it calls the orchestrator and reads ModelVersion, and writes nothing.
 *
 * Usage:
 *   GET /api/testing/orchestrator-loaded?token=$WEBHOOK_TOKEN
 *
 * Params:
 *   minSizeBytes  Size floor sent to the orchestrator. Omit for everything, as the sync job does.
 *   source        Sent to the orchestrator, which filters on it (civitai, huggingface, orchestrator, …).
 *   resolved      `true` to join civitai AIRs to their model/version names.
 *   take          Cap the listed rows. Everything by default.
 *   airs          `true` to return raw AIR strings instead of rows.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { chunk, uniq } from 'lodash-es';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { getLoadedResourceAirs } from '~/server/http/orchestrator/loaded-resources';
import { versionIdFromAir } from '~/shared/utils/air';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

const schema = z.object({
  minSizeBytes: z.coerce.number().int().positive().optional(),
  source: z.string().optional(),
  resolved: booleanString().optional(),
  take: z.coerce.number().int().positive().optional(),
  airs: booleanString().optional(),
});

/** The `<source>` segment of an AIR, read positionally so a malformed one is counted, not thrown. */
function airSource(air: string) {
  return air.split(':')[4] ?? 'unparsed';
}

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
  }

  const { minSizeBytes, source, resolved, take, airs: rawAirs } = parsed.data;
  const all = await getLoadedResourceAirs({ source, minSizeBytes });
  if (!all) return res.status(503).json({ error: 'Orchestrator is restarting; no reliable list' });

  const bySource = all.reduce<Record<string, number>>((acc, air) => {
    const key = airSource(air);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  if (rawAirs) {
    return res.status(200).json({ minSizeBytes, total: all.length, bySource, airs: all });
  }

  const rows = all.map((air) => ({ air, modelVersionId: versionIdFromAir(air) }));
  const resolvable = rows.filter((r) => r.modelVersionId != null).length;

  const page = take != null ? rows.slice(0, take) : rows;
  let named: Record<number, { model: string; version: string; generatorLoaded: boolean }> = {};
  if (resolved) {
    const ids = uniq(page.map((r) => r.modelVersionId).filter((id): id is number => id != null));
    // Unfiltered, this is ~78k ids; one `IN` of that size is a very wide statement on a hot table.
    const versions = [];
    for (const batch of chunk(ids, 5000))
      versions.push(
        ...(await dbRead.modelVersion.findMany({
          where: { id: { in: batch } },
          select: {
            id: true,
            name: true,
            generatorLoaded: true,
            model: { select: { name: true } },
          },
        }))
      );
    named = Object.fromEntries(
      versions.map((v) => [
        v.id,
        { model: v.model.name, version: v.name, generatorLoaded: v.generatorLoaded },
      ])
    );
  }

  return res.status(200).json({
    minSizeBytes,
    total: all.length,
    bySource,
    filteredBy: source ?? null,
    resolvableToVersionId: resolvable,
    // Below resolvableToVersionId because a version listed with and without `+fileId` is two AIRs,
    // one version. Equals the sync job's `listed`.
    distinctVersionIds: new Set(rows.map((r) => r.modelVersionId).filter(Boolean)).size,
    showing: page.length,
    rows: page.map((r) => ({
      ...r,
      source: airSource(r.air),
      ...(resolved && r.modelVersionId != null ? named[r.modelVersionId] ?? {} : {}),
    })),
  });
});
