/**
 * Text-moderation result webhook.
 *
 * One handler for every workflow type. Dispatches by `metadata.entityType`
 * stamped on the workflow at submission time:
 *
 *   - Workflow has `entityType` + `entityId` → look up the adapter from the
 *     moderation-adapter registry, record the EM result, then call the
 *     adapter's `applyResult` / `applyFailure` for entity-specific business
 *     logic (Article unpublish, WildcardSetCategory rollup, etc.).
 *   - No entity attached (ad-hoc generator-prompt scans) → just write to the
 *     audit log via `recordXGuardScanFromWorkflow` and exit.
 *
 * Idempotency: orchestrator webhook retries can re-deliver the callback.
 * `recordEntityModerationSuccess` / `recordEntityModerationFailure` gate on
 * `workflowId` match, so stale callbacks no-op. Adapter `applyResult` /
 * `applyFailure` are expected to be idempotent.
 *
 * Non-atomicity note: the EM record and the adapter call run in separate
 * transactions. If the process crashes between them, the orchestrator's
 * webhook retry replays — `recordEntityModerationSuccess` is idempotent
 * (updateMany on a matching workflowId), and adapter `applyResult`
 * implementations derive state from ground truth, so replay is safe. For
 * the rare case where the orchestrator already received a 200 and won't
 * retry, per-entity reconcile crons (e.g. `article-ingestion-reconcile`)
 * pick up the drift.
 */
import type { WorkflowEvent, XGuardModerationStep } from '@civitai/client';
import { getWorkflow } from '@civitai/client';
import { logToAxiom } from '~/server/logging/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  recordEntityModerationFailure,
  recordEntityModerationSuccess,
} from '~/server/services/entity-moderation.service';
import { getModerationAdapter } from '~/server/services/moderation-adapters';
import { recordXGuardScanFromWorkflow } from '~/server/services/scanner-audit.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

async function handleCallback(event: WorkflowEvent): Promise<void> {
  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId: event.workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${event.workflowId}`);

  const entityType = data.metadata?.entityType as string | undefined;
  const entityId = data.metadata?.entityId as number | undefined;
  const hasEntity = !!entityType && entityId !== undefined;

  switch (event.status) {
    case 'succeeded': {
      const steps = (data.steps ?? []) as unknown as XGuardModerationStep[];
      const moderationStep = steps.find((x) => x.$type === 'xGuardModeration');
      if (!moderationStep?.output)
        throw new Error(`missing xGuardModeration output - ${event.workflowId}`);

      const { blocked, triggeredLabels } = moderationStep.output;

      // Audit log write happens before `recordEntityModerationSuccess` so
      // we capture the full results array (with non-triggered scores etc.)
      // before the slimmer trims it for operational storage. Opt-in via
      // metadata.recordForReview — fire-and-forget; failures never throw.
      // Works without entity info (e.g. ad-hoc generator-prompt scans).
      await recordXGuardScanFromWorkflow(data);

      if (!hasEntity) return;

      const recorded = await recordEntityModerationSuccess({
        entityType,
        entityId,
        workflowId: event.workflowId,
        output: moderationStep.output,
      });
      if (!recorded) {
        await logToAxiom({
          name: 'text-moderation-result',
          type: 'warning',
          message: 'Stale workflow callback ignored (workflowId mismatch)',
          workflowId: event.workflowId,
          entityType,
          entityId,
        });
        return;
      }

      const adapter = getModerationAdapter(entityType);
      if (adapter?.applyResult) {
        await adapter.applyResult({
          entityId,
          workflowId: event.workflowId,
          blocked,
          triggeredLabels,
          output: moderationStep.output,
        });
      }
      return;
    }
    case 'failed':
    case 'expired':
    case 'canceled': {
      if (!hasEntity) {
        await logToAxiom({
          name: 'text-moderation-result',
          type: event.status === 'failed' ? 'error' : 'warning',
          message: `Workflow ${event.status} (no entity attached)`,
          workflowId: event.workflowId,
        });
        return;
      }

      const statusMap = {
        failed: EntityModerationStatus.Failed,
        expired: EntityModerationStatus.Expired,
        canceled: EntityModerationStatus.Canceled,
      } as const;
      const recorded = await recordEntityModerationFailure({
        entityType,
        entityId,
        workflowId: event.workflowId,
        status: statusMap[event.status],
      });
      if (!recorded) {
        await logToAxiom({
          name: 'text-moderation-result',
          type: 'warning',
          message: 'Stale workflow callback ignored (workflowId mismatch)',
          workflowId: event.workflowId,
          entityType,
          entityId,
        });
        return;
      }
      await logToAxiom({
        name: 'text-moderation-result',
        type: event.status === 'failed' ? 'error' : 'warning',
        message: `Workflow ${event.status}`,
        workflowId: event.workflowId,
        entityType,
        entityId,
      });

      const adapter = getModerationAdapter(entityType);
      if (adapter?.applyFailure) {
        await adapter.applyFailure({
          entityId,
          workflowId: event.workflowId,
          status: event.status,
        });
      }
      return;
    }
    default: {
      await logToAxiom({
        name: 'text-moderation-result',
        type: 'warning',
        message: `Unexpected workflow status: ${event.status}`,
        workflowId: event.workflowId,
        entityType,
        entityId,
      });
    }
  }
}

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    const event: WorkflowEvent = req.body;
    await handleCallback(event);
    return res.status(200).json({ ok: true });
  } catch (e: unknown) {
    const error = e as Error;
    await logToAxiom({
      name: 'text-moderation-result',
      type: 'error',
      message: error.message,
      stack: error.stack,
    });
    return res.status(400).json({ error: error.message });
  }
});
