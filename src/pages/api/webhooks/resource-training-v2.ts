import { ImageResourceTrainingStep, Workflow, WorkflowStatus } from '@civitai/client';
import { TrainingStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { SignalMessages } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { trainingCompleteEmail, trainingFailEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { queueNewTrainingModerationWebhook } from '~/server/webhooks/training-moderation.webhooks';

const schema = z.object({
  workflowId: z.string(),
  status: z.nativeEnum(WorkflowStatus),
});

type MetadataType = { modelFileId: number };
export type CustomImageResourceTrainingStep = ImageResourceTrainingStep & {
  metadata: MetadataType;
};

const mapTrainingStatus: { [key in WorkflowStatus]: TrainingStatus } = {
  unassigned: TrainingStatus.Submitted,
  preparing: TrainingStatus.Submitted,
  scheduled: TrainingStatus.Submitted,
  processing: TrainingStatus.Processing,
  failed: TrainingStatus.Failed,
  expired: TrainingStatus.Failed,
  canceled: TrainingStatus.Failed,
  succeeded: TrainingStatus.InReview,
};

const logWebhook = (data: MixedObject) => {
  logToAxiom(
    {
      name: 'resource-training',
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

  const bodyResults = schema.safeParse(req.body);
  if (!bodyResults.success) {
    logWebhook({
      message: 'Could not parse body',
      data: { error: bodyResults.error, body: JSON.stringify(req.body) },
    });
    return res.status(400).json({ ok: false, error: bodyResults.error });
  }

  const { status, workflowId } = bodyResults.data;

  switch (status) {
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
        await updateRecords(workflow);
      } catch (e: unknown) {
        const err = e as Error | undefined;
        logWebhook({
          message: 'Failed to update record',
          data: { error: err?.message, cause: err?.cause, workflowId },
        });
        return res.status(500).json({ ok: false, error: err?.message, workflowId });
      }

      break;
    case 'unassigned':
    case 'preparing':
    case 'scheduled':
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

export async function updateRecords(workflow: Workflow) {
  const { status, transactions, steps } = workflow;
  const workflowStatus = status!;

  const step = steps?.[0] as CustomImageResourceTrainingStep | undefined;
  if (!step) throw new Error('Missing step data');
  if (!step.metadata.modelFileId) throw new Error('Missing modelFileId');

  // console.dir(step);

  const {
    metadata: { modelFileId },
    output,
    startedAt,
    completedAt,
  } = step;
  let trainingStatus = mapTrainingStatus[workflowStatus];

  // TODO is output nullable?
  const epochs = (output ?? {}).epochs ?? [];
  const sampleImagesPrompts = (output ?? {}).sampleImagesPrompts ?? [];
  const moderationStatus = (output ?? {}).moderationStatus;

  if (moderationStatus === 'underReview') trainingStatus = TrainingStatus.Paused;
  else if (moderationStatus === 'rejected') trainingStatus = TrainingStatus.Denied;

  const modelFile = await dbWrite.modelFile.findFirst({
    where: { id: modelFileId },
    select: {
      id: true,
      metadata: true,
      modelVersion: {
        select: {
          id: true,
          name: true,
          model: {
            select: {
              id: true,
              name: true,
              user: {
                select: {
                  id: true,
                  email: true,
                  username: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!modelFile) throw new Error(`ModelFile not found: "${modelFileId}"`);

  const { modelVersion } = modelFile;
  const { model } = modelVersion;

  const thisMetadata = (modelFile.metadata ?? {}) as FileMetadata;
  const trainingResults = (thisMetadata.trainingResults ?? {}) as TrainingResultsV2;
  const history = trainingResults.history ?? [];

  const last = history[history.length - 1];
  if (!last || last.status !== trainingStatus) {
    history.push({
      time: new Date().toISOString(),
      status: trainingStatus,
    });
  }

  // message, // TODO need to separate error type and user error message

  const epochData: TrainingResultsV2['epochs'] = epochs.map((e) => ({
    epochNumber: e.epochNumber ?? -1,
    modelUrl: e.blobUrl,
    modelSize: e.blobSize,
    sampleImages: e.sampleImages ?? [],
  }));

  const newTrainingResults: TrainingResultsV2 = {
    ...trainingResults,
    epochs: epochData,
    history,
    sampleImagesPrompts,
    startedAt: trainingResults.startedAt ?? (startedAt ? new Date(startedAt).toISOString() : null),
    completedAt: completedAt ? new Date(completedAt).toISOString() : null,
    transactionData: transactions?.list ?? trainingResults.transactionData,
  };

  const newMetadata: FileMetadata = {
    ...thisMetadata,
    trainingResults: newTrainingResults,
  };

  await dbWrite.modelFile.update({
    where: { id: modelFile.id },
    data: {
      metadata: newMetadata,
    },
  });

  await dbWrite.modelVersion.update({
    where: { id: modelVersion.id },
    data: {
      trainingStatus,
    },
  });

  // trigger webhook alert
  if (trainingStatus === TrainingStatus.Paused) {
    try {
      await queueNewTrainingModerationWebhook(modelVersion.id);
    } catch {}
  }

  try {
    const bodyData: TrainingUpdateSignalSchema = {
      modelId: model.id,
      modelVersionId: modelVersion.id,
      status: trainingStatus,
      fileMetadata: newMetadata,
    };
    await fetch(
      `${env.SIGNALS_ENDPOINT}/users/${model.user.id}/signals/${SignalMessages.TrainingUpdate}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData),
      }
    );
  } catch (e: unknown) {
    logWebhook({
      message: 'Failed to send signal for update',
      data: { error: (e as Error)?.message, cause: (e as Error)?.cause, workflowId: workflow.id },
    });
  }

  if (trainingStatus === TrainingStatus.InReview) {
    await trainingCompleteEmail.send({
      model,
      mName: modelVersion.name,
      user: model.user,
    });
  } else if (trainingStatus === TrainingStatus.Failed || trainingStatus === TrainingStatus.Denied) {
    await trainingFailEmail.send({
      model,
      mName: modelVersion.name,
      user: model.user,
    });
  }
}
