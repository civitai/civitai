import { TrainingStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { updateRecords } from '~/pages/api/webhooks/resource-training';
import { Context } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { refundTransaction } from '~/server/services/buzz.service';
import { getModel } from '~/server/services/model.service';
import { createTrainingRequest } from '~/server/services/training.service';
import { throwDbError, throwNotFoundError, withRetries } from '~/server/utils/errorHandling';

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

export const getModelData = async ({ input }: { input: GetByIdInput }) => {
  try {
    const model = await getModel({
      id: input.id,
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        uploadType: true,
        modelVersions: {
          select: {
            id: true,
            name: true,
            baseModel: true,
            trainingStatus: true,
            trainingDetails: true,
            files: {
              select: {
                id: true,
                name: true,
                url: true,
                type: true,
                metadata: true,
                sizeKB: true,
                visibility: true,
              },
              where: { type: { equals: 'Training Data' } },
            },
          },
        },
      },
    });
    if (!model) throw throwNotFoundError(`No model with id ${input.id}`);

    return model;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export async function handleApproveTrainingData({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) {
  const modelVersionId = input.id;
  logWebhook({ message: 'Approved training dataset', type: 'info', data: { modelVersionId } });

  try {
    await createTrainingRequest({ modelVersionId, skipModeration: true });
  } catch (e) {
    logWebhook({
      message: 'Failed to resubmit training request',
      data: {
        modelVersionId,
        important: true,
        error: (e as Error)?.message,
        cause: (e as Error)?.cause,
      },
    });
    throw e;
  }
}

export async function handleDenyTrainingData({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) {
  const modelVersionId = input.id;
  logWebhook({
    message: 'Denied training dataset',
    type: 'info',
    data: { modelVersionId, important: true },
  });

  // TODO - get this via a service method
  const modelFile = await dbWrite.modelFile.findFirst({
    where: { modelVersionId },
    select: {
      id: true,
      metadata: true,
    },
  });

  if (!modelFile) {
    logWebhook({
      message: 'Could not find modelFile',
      data: { modelVersionId, important: true },
    });
    throw throwNotFoundError('Could not find modelFile');
  }

  const metadata = modelFile.metadata as FileMetadata;
  const jobId = metadata.trainingResults?.jobId ?? '(unk jobId)';
  const transactionId = metadata.trainingResults?.transactionId;

  if (!transactionId)
    logWebhook({
      message: 'Could not refund user, missing transaction ID',
      data: {
        important: true,
        modelVersionId,
        jobId,
      },
    });
  else {
    logWebhook({
      type: 'info',
      message: `Attempting to refund user`,
      data: { modelVersionId, jobId },
    });

    try {
      await withRetries(() => refundTransaction(transactionId, 'Refund for denied training job.'));
    } catch (e: unknown) {
      logWebhook({
        message: 'Could not refund user',
        data: {
          error: (e as Error)?.message,
          cause: (e as Error)?.cause,
          jobId,
          transactionId,
          important: true,
        },
      });
    }
  }

  try {
    await updateRecords({ modelFileId: modelFile.id }, TrainingStatus.Denied, 'Failed', jobId);
  } catch (e: unknown) {
    logWebhook({
      message: 'Failed to update record',
      data: { error: (e as Error)?.message, cause: (e as Error)?.cause, modelVersionId, jobId },
    });
    throw e;
  }
}
