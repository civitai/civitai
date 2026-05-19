/**
 * Text-moderation result webhook.
 *
 * Dispatches by the `type` query param so multiple subsystems can share the
 * same orchestrator callback URL without bleeding into each other's logic:
 *
 *   - omitted / unknown → entity-moderation flow (Article today). Updates the
 *     `EntityModeration` row + invokes the per-entityType handler.
 *   - `wildcardCategoryValue` → wildcard category audit flow. Reads the
 *     workflow's xGuardModeration step output and writes the rollup onto
 *     the `WildcardSetCategory` row, then recomputes the parent set's
 *     aggregate audit status.
 *
 * Each branch's handler is responsible for its own idempotency. Orchestrator
 * webhook retries can re-deliver the callback; handlers must tolerate that.
 *
 * Non-atomicity note for the entity-moderation branch:
 * `recordEntityModerationSuccess` and the entity handler (which calls
 * `recomputeArticleIngestion`) run in separate transactions. If the process
 * crashes between them, the orchestrator's webhook retry will redeliver the
 * callback — `recordEntityModerationSuccess` is idempotent (updateMany on a
 * matching workflowId) and `recomputeArticleIngestion` derives state from
 * ground truth, so replay is safe. For the rare case where the orchestrator
 * already received a 200 and won't retry, the `article-ingestion-reconcile`
 * cron picks up the drift within 10 minutes.
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
import {
  applyWildcardCategoryAuditFailure,
  applyWildcardCategoryAuditSuccess,
} from '~/server/services/wildcard-category-audit.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

/**
 * Default callback handler — resolves the workflow via `EntityModeration`,
 * persists status/result, and dispatches to the per-entityType handler.
 */
async function handleEntityModerationCallback(event: WorkflowEvent): Promise<void> {
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

      // Entity-bound operational state — only when an entity was attached.
      if (hasEntity) {
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
        break;
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

/**
 * Wildcard category audit callback — looks up the category by the workflow
 * metadata, walks the moderation step's output, and writes the strict
 * rollup onto the category. Set-level rollup is recomputed inside the
 * service helper.
 */
async function handleWildcardCategoryAuditCallback(event: WorkflowEvent): Promise<void> {
  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId: event.workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${event.workflowId}`);

  // `createXGuardModerationRequest` stamps `entityId` on workflow metadata.
  // For the wildcard flow we passed `entityId: categoryId` at submit time, so
  // this is the WildcardSetCategory.id. (`entityType` is also stamped as
  // 'WildcardSetCategory' but we don't need to assert on it — the `?type=`
  // dispatch above already proved we're in the right branch.)
  const categoryId = data.metadata?.entityId as number | undefined;
  if (!categoryId) throw new Error(`missing workflow metadata.entityId - ${event.workflowId}`);

  switch (event.status) {
    case 'succeeded': {
      const steps = (data.steps ?? []) as unknown as XGuardModerationStep[];
      const moderationStep = steps.find((x) => x.$type === 'xGuardModeration');
      if (!moderationStep?.output)
        throw new Error(`missing xGuardModeration output - ${event.workflowId}`);

      await applyWildcardCategoryAuditSuccess({
        categoryId,
        workflowId: event.workflowId,
        output: moderationStep.output,
      });
      return;
    }
    case 'failed':
    case 'expired':
    case 'canceled': {
      await applyWildcardCategoryAuditFailure({
        categoryId,
        workflowId: event.workflowId,
        status: event.status,
      });
      await logToAxiom({
        name: 'text-moderation-result',
        type: event.status === 'failed' ? 'error' : 'warning',
        message: `Wildcard category audit workflow ${event.status}`,
        workflowId: event.workflowId,
        wildcardSetCategoryId: categoryId,
      });
      return;
    }
    default: {
      await logToAxiom({
        name: 'text-moderation-result',
        type: 'warning',
        message: `Unexpected workflow status: ${event.status}`,
        workflowId: event.workflowId,
        wildcardSetCategoryId: categoryId,
      });
    }
  }
}

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    const event: WorkflowEvent = req.body;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;

    switch (type) {
      case 'wildcardCategoryValue':
        await handleWildcardCategoryAuditCallback(event);
        break;
      default:
        await handleEntityModerationCallback(event);
        break;
    }

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
