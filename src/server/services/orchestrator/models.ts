import { getResource, queryResources } from '@civitai/orchestration-client';
import { chunk } from 'lodash-es';
import type * as z from 'zod';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { getCurrentLSN } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { getModelByAirSchema } from '~/server/schema/orchestrator/models.schema';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  modelVersionAirSelect,
  modelVersionToAir,
  type ModelVersionAirInput,
} from '~/server/utils/resource-air';
import { modelFileScanAir, type ModelFileScanAirInput } from '~/shared/utils/model-file-scan-air';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { Prisma } from '@prisma/client';
import { isTargetedBy, type GateRule } from '~/shared/generation/gates';

export async function getModelClient({
  token,
  air,
}: z.output<typeof getModelByAirSchema> & { token: string }) {
  const client = createOrchestratorClient(token);
  return await getResource({ client, path: { air } });
}

export async function queryResourcesClient({
  token,
  query,
}: {
  token: string;
  query: { view: 'queue'; cursor?: string; take?: number };
}) {
  const client = createOrchestratorClient(token);
  return await queryResources({ client, query });
}

// DELETE /v2/resources/{air} is called with fetch rather than through @civitai/orchestration-client: the operation
// carries [ApiExplorerSettings(IgnoreApi = true)] (orchestrator c2d2c370), so it is absent from the
// OpenAPI documents the SDK is generated from — the endpoint itself is live.
async function invalidateOrchestratorResource(air: string, etag: string, userId?: number) {
  const query = new URLSearchParams({ etag });
  if (userId != null) query.set('userId', String(userId));

  const response = await outboundFetch(
    `${env.ORCHESTRATOR_ENDPOINT}/v2/resources/${air}?${query}`,
    {
      timeoutMs: 30_000,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}` },
    }
  );
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

  try {
    await invalidateVersions(versionIds, userId);
  } catch (error) {
    logToAxiom({
      name: 'bust-orchestrator-model-cache',
      type: 'error',
      message: `bust failed before invalidating: ${(error as Error).message}`,
      versionIds: versionIds.slice(0, 10),
    }).catch(() => undefined);
  }
}

async function invalidateVersions(versionIds: number[], userId?: number) {
  const airs = await versionAirs(versionIds);
  if (airs.length) await invalidateAirs(airs, userId);
}

async function versionAirs(versionIds: number[]) {
  const versions = (await dbWrite.modelVersion.findMany({
    where: { id: { in: versionIds } },
    select: modelVersionAirSelect,
  })) as ModelVersionAirInput[];

  // The orchestrator caches per AIR string, and a Checkpoint whose generation file is a diffusion
  // model or UNet is reachable under both its file-kind AIR and the plain `checkpoint` one.
  return [
    ...new Set(
      versions.flatMap((version) => [
        modelVersionToAir(version),
        modelVersionToAir({ ...version, files: undefined }),
      ])
    ),
  ];
}

/**
 * `bustOrchestratorModelCache` for a caller that must stop on failure (a backfill): throws when the
 * orchestrator is not configured or any invalidation fails, instead of logging. Returns the AIR count.
 */
export async function invalidateOrchestratorVersionsOrThrow(versionIds: number[]) {
  if (!env.ORCHESTRATOR_ENDPOINT || !env.ORCHESTRATOR_ACCESS_TOKEN)
    throw new Error('orchestrator is not configured');
  const airs = await versionAirs(versionIds);
  if (!airs.length) return 0;
  const etag = await getCurrentLSN();
  // Paced like `invalidateAirs`; every AIR is attempted before a failure is thrown.
  const failures: string[] = [];
  const tasks = chunk(airs, 100).map((batch) => async () => {
    await Promise.all(
      batch.map((air) =>
        invalidateOrchestratorResource(air, etag).catch((error: Error) => {
          failures.push(error.message);
        })
      )
    );
  });
  await limitConcurrency(tasks, 3);
  if (failures.length)
    throw new Error(
      `${failures.length}/${airs.length} resource invalidations failed: ${failures[0]}`
    );
  return airs.length;
}

/**
 * The versions whose cached orchestrator answer a gate rule change makes stale: the versions the
 * rules name, and alias versions whose target the rules name by id or by ecosystem (an alias's own
 * AIR carries its own ecosystem, so an ecosystem clear never reaches it).
 */
export async function gateChangeVersionIds(rules: (GateRule | undefined)[]): Promise<number[]> {
  const targets = { ecosystems: new Set<string>(), versionIds: new Set<number>() };
  for (const rule of rules) {
    if (!rule) continue;
    rule.ecosystems.forEach((e) => targets.ecosystems.add(e));
    rule.modelVersionIds.forEach((id) => targets.versionIds.add(id));
  }
  if (!targets.ecosystems.size && !targets.versionIds.size) return [];
  const aliases = await dbRead.$queryRaw<
    { id: number; targetId: number; targetBaseModel: string }[]
  >(
    Prisma.sql`
      SELECT mv.id, t.id AS "targetId", t."baseModel" AS "targetBaseModel"
      FROM "ModelVersion" mv
      JOIN "ModelVersion" t ON t.id = (mv.meta->'generationAlias'->>'versionId')::int
      WHERE mv.meta->'generationAlias'->>'versionId' IS NOT NULL
    `
  );
  const ids = new Set(targets.versionIds);
  for (const alias of aliases)
    if (isTargetedBy({ id: alias.targetId, baseModel: alias.targetBaseModel }, targets))
      ids.add(alias.id);
  return [...ids];
}

/**
 * Clears the orchestrator's cached answers a gate rule change makes stale, so the change reaches
 * the API at once. `cleared` is false when the clear failed (logged): the moderator is told, and
 * saving the rule again retries it. Every version of a named ecosystem can't be cleared until the
 * orchestrator supports it, so those ecosystems come back for the moderator to see.
 */
export async function clearOrchestratorForGateChange(
  rules: (GateRule | undefined)[]
): Promise<{ cleared: boolean; ecosystemsNotCleared: string[] }> {
  const ecosystemsNotCleared = [...new Set(rules.flatMap((rule) => rule?.ecosystems ?? []))];
  if (!env.ORCHESTRATOR_ENDPOINT || !env.ORCHESTRATOR_ACCESS_TOKEN)
    return { cleared: true, ecosystemsNotCleared: [] };
  try {
    await invalidateOrchestratorVersionsOrThrow(await gateChangeVersionIds(rules));
    return { cleared: true, ecosystemsNotCleared };
  } catch (error) {
    logToAxiom({
      name: 'gate-rule-orchestrator-clear',
      type: 'error',
      message: (error as Error).message,
      ruleIds: rules.flatMap((r) => (r ? [r.id] : [])),
    });
    return { cleared: false, ecosystemsNotCleared };
  }
}

/**
 * The versions' AIRs as derived now. Read them before a write that deletes a version or changes its
 * AIR kind, and pass them to `bustOrchestratorAirs` after the commit: a bust after the write derives
 * only the new AIRs, and one before it can be refilled while the write runs. Never throws.
 */
export async function getOrchestratorVersionAirs(versionIds: number[]): Promise<string[]> {
  if (!env.ORCHESTRATOR_ENDPOINT || !env.ORCHESTRATOR_ACCESS_TOKEN) return [];
  return versionAirs(versionIds).catch((error) => {
    logToAxiom({
      name: 'bust-orchestrator-model-cache',
      type: 'error',
      message: `reading version AIRs failed: ${(error as Error).message}`,
      versionIds: versionIds.slice(0, 10),
    }).catch(() => undefined);
    return [];
  });
}

/** Evicts AIRs read earlier with `getOrchestratorVersionAirs`. Never throws. */
export async function bustOrchestratorAirs(airs: string[]) {
  if (!airs.length || !env.ORCHESTRATOR_ENDPOINT || !env.ORCHESTRATOR_ACCESS_TOKEN) return;
  try {
    await invalidateAirs(airs);
  } catch (error) {
    logToAxiom({
      name: 'bust-orchestrator-model-cache',
      type: 'error',
      message: `bust failed before invalidating: ${(error as Error).message}`,
    }).catch(() => undefined);
  }
}

/** Evicts the file-pinned AIR a scan resolves; the version busts above never reach it. Never throws. */
export async function bustOrchestratorScannedFileCache(file: ModelFileScanAirInput) {
  if (!env.ORCHESTRATOR_ENDPOINT || !env.ORCHESTRATOR_ACCESS_TOKEN) return;

  try {
    await invalidateAirs([modelFileScanAir(file)]);
  } catch (error) {
    logToAxiom({
      name: 'bust-orchestrator-model-cache',
      type: 'error',
      message: `bust failed before invalidating: ${(error as Error).message}`,
      fileId: file.fileId,
    }).catch(() => undefined);
  }
}

async function invalidateAirs(airs: string[], userId?: number) {
  const etag = await getCurrentLSN();
  const failures: string[] = [];

  const tasks = chunk(airs, 100).map((batch) => async () => {
    await Promise.all(
      batch.map(async (air) => {
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
      message: `${failures.length}/${airs.length} resource invalidations failed`,
      details: failures.slice(0, 10),
    }).catch(() => undefined);
}
