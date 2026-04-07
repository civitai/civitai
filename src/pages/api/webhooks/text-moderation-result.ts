import type { WorkflowEvent, XGuardModerationOutput, XGuardModerationStep } from '@civitai/client';
import { getWorkflow } from '@civitai/client';
import { logToAxiom } from '~/server/logging/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  mapTriggeredLabelsToNsfwLevel,
  recordEntityModerationFailure,
  recordEntityModerationSuccess,
} from '~/server/services/entity-moderation.service';
import { dbWrite } from '~/server/db/client';
import { NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { createNotification } from '~/server/services/notification.service';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { ArticleStatus, EntityModerationStatus } from '~/shared/utils/prisma/enums';

type TextModerationResult = {
  entityType: string;
  entityId: number;
  blocked: boolean;
  triggeredLabels: string[];
  output: XGuardModerationOutput;
};

// Entity-specific handlers keyed by entityType
const entityHandlers: Record<string, (result: TextModerationResult) => Promise<void>> = {
  Article: async ({ entityId, blocked, triggeredLabels }) => {
    const textNsfwLevel = mapTriggeredLabelsToNsfwLevel(triggeredLabels, blocked);

    // Elevate userNsfwLevel if text moderation suggests higher (never lower)
    if (textNsfwLevel > 0) {
      await dbWrite.$executeRaw`
        UPDATE "Article"
        SET "userNsfwLevel" = GREATEST("userNsfwLevel", ${textNsfwLevel}),
            "nsfw" = CASE WHEN ${textNsfwLevel} >= ${NsfwLevel.R} THEN true ELSE "nsfw" END,
            "lockedProperties" = CASE
              WHEN NOT ('userNsfwLevel' = ANY("lockedProperties"))
              THEN array_append("lockedProperties", 'userNsfwLevel')
              ELSE "lockedProperties"
            END
        WHERE id = ${entityId}
      `;
      await updateArticleNsfwLevels([entityId]);
    }

    // If blocked, auto-unpublish and notify
    if (blocked) {
      const article = await dbWrite.article.findUnique({
        where: { id: entityId },
        select: { status: true, userId: true },
      });
      if (article && article.status !== ArticleStatus.UnpublishedViolation) {
        await dbWrite.article.update({
          where: { id: entityId },
          data: { status: ArticleStatus.UnpublishedViolation },
        });
        await createNotification({
          userId: article.userId,
          category: NotificationCategory.System,
          type: 'system-message',
          key: `article-text-blocked-${entityId}`,
          details: {
            message:
              'Your article was unpublished because its content violates our Terms of Service.',
            url: `/articles/${entityId}`,
          },
        });
      }
    }
  },
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

        await recordEntityModerationSuccess({
          entityType,
          entityId,
          workflowId: event.workflowId,
          output: moderationStep.output,
        });

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
        await recordEntityModerationFailure({
          entityType,
          entityId,
          workflowId: event.workflowId,
          status: statusMap[event.status],
        });
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
