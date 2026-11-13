import type { Workflow } from '@civitai/orchestration-client';
import {
  APP_ACTIVITY_WINDOW_MS,
  mergeAppActivity,
  type AppActivity,
  type CallActivity,
  type GenerationActivity,
  type GenerationStatus,
} from '@civitai/app-assistant';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { readPreviewErrors } from '~/server/services/app-assistant/preview-errors.service';
import { listMyScopeInvocations } from '~/server/services/blocks/user-app-surface.service';
import { appBlockTag, projectAppWorkflow } from '~/server/services/blocks/workflow.service';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';

/**
 * The open app's recent activity for ONE user, owner-only: App Assistant's preview-pane strip
 * (`GET /api/apps/assistant/activity`) and its `app_activity` tool on both runners (the page reads
 * that route; the server runner reads `/api/internal/app-assistant/app-activity`).
 *
 * The app is looked up as the USER'S OWN dev app (`resolveDevPageBlockForAuthor`, the same lookup
 * the live preview uses): an app someone else owns, or has pending, answers `null`, the one answer
 * for "not yours". Each part is then read as that user only:
 *  - calls: their own `block_scope_invocations` rows for the app. A pre-approval dev app's rows have
 *    `appBlockId: null` and carry the app in `syntheticAppId`, so it is filtered on that;
 *  - generations: the orchestrator's list with THEIR orchestrator token, filtered on the app's
 *    `app-block:<appId>` tag (as `blocks.queryAppWorkflows` reads an app's subqueue);
 *  - errors: what their own live preview of the app reported (`preview-errors.service.ts`).
 * A part that cannot be read is named in `unavailable`; the others are still returned.
 */

/** Calls read per request: a poll loop writes one row per poll, so this is a recent slice. */
const CALLS_READ = 100;
const GENERATIONS_READ = 50;

const GENERATION_STATUS: Record<string, GenerationStatus> = {
  unassigned: 'pending',
  preparing: 'pending',
  scheduled: 'pending',
  processing: 'processing',
  succeeded: 'succeeded',
  failed: 'failed',
  expired: 'expired',
  canceled: 'canceled',
};

/**
 * Why a workflow did not succeed, as far as the orchestrator's list answer says. It carries no
 * error text: only each step's status, and a blocked output's reason. So this names the steps that
 * failed (and any blocked output's reason), or null when there is nothing to say.
 */
export function workflowError(workflow: Workflow, status: GenerationStatus): string | null {
  const reasons: string[] = [];
  for (const step of workflow.steps ?? []) {
    if (step.status === 'failed' || step.status === 'expired')
      reasons.push(`step ${step.name} (${step.$type}) ${step.status}`);
    const output = (step as unknown as { output?: { images?: unknown[]; blobs?: unknown[] } })
      .output;
    const blobs = [...(output?.images ?? []), ...(output?.blobs ?? [])] as {
      blockedReason?: string | null;
    }[];
    for (const blob of blobs)
      if (typeof blob?.blockedReason === 'string' && blob.blockedReason)
        reasons.push(`output blocked: ${blob.blockedReason}`);
  }
  if (reasons.length > 0) return [...new Set(reasons)].join('; ');
  return status === 'failed' || status === 'expired' ? `workflow ${status}` : null;
}

/** One orchestrator workflow as an activity item. */
export function generationOf(workflow: Workflow): GenerationActivity {
  const status = GENERATION_STATUS[workflow.status] ?? 'pending';
  const projected = projectAppWorkflow(workflow);
  return {
    kind: 'generation',
    at: workflow.createdAt,
    workflowId: workflow.id ?? '',
    status,
    completedAt: workflow.completedAt ?? null,
    imageCount: projected.images.length,
    cost: projected.cost,
    error: workflowError(workflow, status),
  };
}

export async function readAppActivity({
  userId,
  blockId,
  now = Date.now(),
}: {
  userId: number;
  blockId: string;
  now?: number;
}): Promise<AppActivity | null> {
  const app = await BlockRegistry.resolveDevPageBlockForAuthor(blockId, userId);
  if (!app) return null;

  const calls = listMyScopeInvocations({
    userId,
    // A pre-approval dev app (`ephemeral-<slug>`) has no AppBlock row: its rows carry it in
    // `syntheticAppId`. An app of theirs with a row is filtered on its id.
    ...(app.status === 'ephemeral'
      ? { syntheticAppId: app.appBlockId }
      : { appBlockId: app.appBlockId }),
    limit: CALLS_READ,
  }).then(({ items }) =>
    items.map(
      (item): CallActivity => ({
        kind: 'call',
        at: new Date(item.createdAt).toISOString(),
        endpoint: item.endpoint,
        scope: item.scope,
        statusCode: item.statusCode,
        count: 1,
      })
    )
  );

  const generations = (async () => {
    const token = await getOrchestratorToken(userId);
    const { items } = await queryWorkflows({
      token,
      tags: [appBlockTag(app.appId)],
      take: GENERATIONS_READ,
      fromDate: new Date(now - APP_ACTIVITY_WINDOW_MS),
      hideMatureContent: false,
    });
    return items.map(generationOf);
  })();

  const errors = readPreviewErrors({ userId, blockId: app.blockId });

  const [callsRead, generationsRead, errorsRead] = await Promise.all([
    calls.catch(() => null),
    generations.catch(() => null),
    errors.catch(() => null),
  ]);
  return mergeAppActivity(
    app.blockId,
    { calls: callsRead, generations: generationsRead, errors: errorsRead },
    now
  );
}
