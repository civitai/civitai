import { WorkflowStatus } from '@civitai/client';
import * as z from 'zod';
import { env } from '~/env/server';
import { SignalMessages } from '~/server/common/enums';
import { trainingCompleteEmail, trainingFailEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import type { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import {
  updateTrainingWorkflowRecords,
  type CustomImageResourceTrainingStep,
  type CustomTrainingStep,
} from '~/server/services/training.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { queueNewTrainingModerationWebhook } from '~/server/webhooks/training-moderation.webhooks';
import { TrainingStatus } from '~/shared/utils/prisma/enums';

const workflowSchema = z.object({
  workflowId: z.string(),
  status: z.enum(WorkflowStatus),
  // $type
  // timestamp
});

// Re-export for backward compatibility
export type { CustomImageResourceTrainingStep, CustomTrainingStep };

const logWebhook = (data: MixedObject) => {
  logToAxiom(
    {
      name: 'resource-training-v2-webhook',
      type: 'error',
      ...data,
    },
    'webhooks'
  ).catch();
};

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') {
    logWebhook({ message: 'Wrong method', data: { method: req.method } });
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const bodyResults = workflowSchema.safeParse(req.body);
  if (!bodyResults.success) {
    logWebhook({
      message: 'Could not parse body',
      data: { error: bodyResults.error, body: JSON.stringify(req.body) },
    });
    return res.status(400).json({ ok: false, error: bodyResults.error });
  }

  const { status, workflowId } = bodyResults.data;

  switch (status) {
    case 'unassigned':
    case 'preparing':
    case 'scheduled':
    case 'processing':
    case 'failed':
    case 'expired':
    case 'canceled':
    case 'succeeded':
      try {
        const workflow = await getWorkflow({
          token: env.ORCHESTRATOR_ACCESS_TOKEN,
          path: { workflowId },
        });
        console.log(workflow);

        const result = await updateTrainingWorkflowRecords(workflow, status);

        // Handle notifications only on status change
        if (result.statusChanged) {
          // Trigger moderation webhook if paused
          if (result.trainingStatus === TrainingStatus.Paused) {
            try {
              await queueNewTrainingModerationWebhook(result.modelVersionId);
            } catch {}
          }

          // Send signal to user
          try {
            const bodyData: TrainingUpdateSignalSchema = {
              modelId: result.modelId,
              modelVersionId: result.modelVersionId,
              status: result.trainingStatus,
              fileMetadata: result.fileMetadata,
            };
            await fetch(
              `${env.SIGNALS_ENDPOINT}/users/${result.userId}/signals/${SignalMessages.TrainingUpdate}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyData),
              }
            );
          } catch (e: unknown) {
            logWebhook({
              message: 'Failed to send signal for update',
              data: { error: (e as Error)?.message, cause: (e as Error)?.cause, workflowId },
            });
          }

          // Send email notifications
          const emailData = {
            model: { id: result.modelId, name: result.modelName },
            mName: result.modelVersionName,
            user: { id: result.userId, email: result.userEmail, username: result.username },
          };

          if (result.trainingStatus === TrainingStatus.InReview) {
            trainingCompleteEmail
              .send(emailData)
              .catch((error) =>
                logWebhook({ message: 'Failed to send training complete email', error })
              );
          } else if (
            result.trainingStatus === TrainingStatus.Failed ||
            result.trainingStatus === TrainingStatus.Denied
          ) {
            trainingFailEmail
              .send(emailData)
              .catch((error) =>
                logWebhook({ message: 'Failed to send training fail email', error })
              );
          }
        }
      } catch (e: unknown) {
        const err = e as Error | undefined;
        logWebhook({
          message: 'Failed to update record',
          data: { error: err?.message, cause: err?.cause, stack: err?.stack, status, workflowId },
        });
        return res.status(500).json({ ok: false, error: err?.message, workflowId });
      }

      break;
    default:
      logWebhook({
        message: 'Status type not supported',
        data: { type: status, workflowId },
      });
      return res.status(400).json({ ok: false, error: 'Status type not supported' });
  }

  return res.status(200).json({ ok: true });
});
