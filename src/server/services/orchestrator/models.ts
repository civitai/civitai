import { getResource } from '@civitai/client';
import { chunk } from 'lodash-es';
import type * as z from 'zod';
import { env } from '~/env/server';
import { getCurrentLSN } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { getModelByAirSchema } from '~/server/schema/orchestrator/models.schema';
import { resourceDataCache } from '~/server/redis/resource-data.redis';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { stringifyAIR } from '~/shared/utils/air';

export async function getModelClient({
  token,
  air,
}: z.output<typeof getModelByAirSchema> & { token: string }) {
  const client = createOrchestratorClient(token);
  return await getResource({ client, path: { air } });
}

// DELETE /v2/resources/{air} is called with fetch rather than through @civitai/client: the operation
// carries [ApiExplorerSettings(IgnoreApi = true)] (orchestrator c2d2c370), so it is absent from the
// OpenAPI documents the SDK is generated from — the endpoint itself is live.
async function invalidateOrchestratorResource(air: string, etag: string, userId?: number) {
  const query = new URLSearchParams({ etag });
  if (userId != null) query.set('userId', String(userId));

  const response = await fetch(`${env.ORCHESTRATOR_ENDPOINT}/v2/resources/${air}?${query}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}` },
  });
  // 401/403 here means the system token lacks the role the endpoint requires. That must be loud:
  // this function spent ~2.5 months commented out, and a silently-swallowed authz failure is
  // indistinguishable from the no-op it replaced — stale prices in the generator, no signal.
  if (!response.ok)
    throw new Error(`invalidateResource ${air} failed: ${response.status} ${response.statusText}`);
}

/**
 * Drop the orchestrator's cached copy of these versions so generation reprices against current data
 * (licensing fees, paid-access terms, coverage). Never throws — callers are save paths and cron jobs
 * that must not fail because a cache bust did.
 */
export async function bustOrchestratorModelCache(versionIds: number | number[], userId?: number) {
  if (!Array.isArray(versionIds)) versionIds = [versionIds];
  if (!env.ORCHESTRATOR_ENDPOINT || !env.ORCHESTRATOR_ACCESS_TOKEN) return;

  const resources = await resourceDataCache.fetch(versionIds);
  if (!resources.length) return;

  const etag = await getCurrentLSN();
  const failures: string[] = [];

  const tasks = chunk(resources, 100).map((batch) => async () => {
    await Promise.all(
      batch.map(async (resource) => {
        const air = stringifyAIR({
          baseModel: resource.baseModel,
          type: resource.model.type,
          modelId: resource.model.id,
          id: resource.id,
        });

        try {
          await invalidateOrchestratorResource(air, etag, userId);
        } catch (error) {
          failures.push((error as Error).message);
        }
      })
    );
  });

  await limitConcurrency(tasks, 3);

  if (failures.length)
    logToAxiom({
      name: 'bust-orchestrator-model-cache',
      type: 'error',
      message: `${failures.length}/${resources.length} resource invalidations failed`,
      details: failures.slice(0, 10),
    }).catch(() => undefined);
}
