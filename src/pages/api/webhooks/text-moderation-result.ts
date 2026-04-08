import type { WorkflowEvent, XGuardModerationOutput, XGuardModerationStep } from '@civitai/client';
import { getWorkflow } from '@civitai/client';
import { logToAxiom } from '~/server/logging/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  recordEntityModerationFailure,
  recordEntityModerationSuccess,
} from '~/server/services/entity-moderation.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

type TextModerationResult = {
  entityType: string;
  entityId: number;
  blocked: boolean;
  triggeredLabels: string[];
  output: XGuardModerationOutput;
};

// Entity-specific handlers keyed by entityType
const entityHandlers: Record<string, (result: TextModerationResult) => Promise<void>> = {
  // Article: async ({ entityId, blocked, triggeredLabels, output }) => {
  //   TODO: update article with moderation results
  // },
};

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    const event: WorkflowEvent = req.body;

    const { data } = await getWorkflow({
      client: internalOrchestratorClient,
      path: { workflowId: event.workflowId },
    });
    if (!data) throw new Error(`could not find workflow: ${event.workflowId}`);

    const entityType = data.metadata?.entityType as string | undefined;
    const entityId = data.metadata?.entityId as number | undefined;
    if (!entityType || !entityId)
      throw new Error(`missing workflow metadata.entityType or entityId - ${event.workflowId}`);

    switch (event.status) {
      case 'succeeded': {
        const steps = (data.steps ?? []) as unknown as XGuardModerationStep[];
        const moderationStep = steps.find((x) => x.$type === 'xGuardModeration');
        if (!moderationStep?.output)
          throw new Error(`missing xGuardModeration output - ${event.workflowId}`);

        const { blocked, triggeredLabels } = moderationStep.output;

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
          break;
        }

        const handler = entityHandlers[entityType];
        if (handler) {
          await handler({
            entityType,
            entityId,
            blocked,
            triggeredLabels,
            output: moderationStep.output,
          });
        }
        break;
      }
      case 'failed':
      case 'expired':
      case 'canceled': {
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
          break;
        }
        await logToAxiom({
          name: 'text-moderation-result',
          type: event.status === 'failed' ? 'error' : 'warning',
          message: `Workflow ${event.status}`,
          workflowId: event.workflowId,
          entityType,
          entityId,
        });
        break;
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
