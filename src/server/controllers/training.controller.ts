import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import type { CustomImageResourceTrainingStep } from '~/pages/api/webhooks/resource-training-v2/[modelVersionId]';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import { getModel } from '~/server/services/model.service';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import {
  throwBadRequestError,
  throwDbError,
  throwInternalServerError,
  throwNotFoundError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';

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
        availability: true,
        modelVersions: {
          select: {
            id: true,
            name: true,
            baseModel: true,
            trainingStatus: true,
            trainingDetails: true,
            trainedWords: true,
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

const getJobIdFromVersion = async (modelVersionId: number) => {
  const modelFile = await dbWrite.modelFile.findFirst({
    where: { modelVersionId, type: 'Training Data' },
    select: {
      metadata: true,
      modelVersion: {
        select: {
          trainingStatus: true,
        },
      },
    },
  });
  if (!modelFile || modelFile.modelVersion?.trainingStatus !== TrainingStatus.Paused) {
    logWebhook({
      message: 'Could not find modelVersion of type "Paused"',
      data: { modelVersionId, important: true },
    });
    throw throwNotFoundError('Could not find modelFile');
  }

  const thisMetadata = (modelFile.metadata ?? {}) as FileMetadata;
  const trainingResults = (thisMetadata.trainingResults ?? {}) as TrainingResultsV2;
  const { workflowId } = trainingResults;
  if (!workflowId) {
    logWebhook({
      message: 'Could not find workflowId',
      data: { modelVersionId, important: true },
    });
    throw throwNotFoundError('Could not find workflowId');
  }

  const workflow = await getWorkflow({
    token: env.ORCHESTRATOR_ACCESS_TOKEN,
    path: { workflowId },
  });

  const step = workflow.steps?.[0] as CustomImageResourceTrainingStep | undefined;
  // nb: get exactly the second job
  const gateId = step?.jobs?.[1]?.id;
  if (!gateId) {
    logWebhook({
      message: 'Could not find jobId for gate job',
      data: { modelVersionId, important: true },
    });
    throw throwNotFoundError('Could not find jobId for gate job');
  }

  return gateId;
};

const moderateTrainingData = async ({
  modelVersionId,
  gateJobId,
  approve,
}: {
  modelVersionId: number;
  gateJobId: string;
  approve: boolean;
}) => {
  if (!env.ORCHESTRATOR_ENDPOINT) throw throwInternalServerError('No orchestrator endpoint');

  try {
    const gateResp = await fetch(
      `${env.ORCHESTRATOR_ENDPOINT}/v1/manager/ambientjobs/${gateJobId}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          approved: approve,
          // message: ''
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
        },
      }
    );

    if (!gateResp.ok) {
      logWebhook({
        message: 'Could not connect to orchestrator',
        data: {
          modelVersionId,
          important: true,
          status: gateResp.status,
          gateJobId,
        },
      });

      if (gateResp.status === 429) {
        throw throwRateLimitError('Could not connect to orchestrator');
      } else {
        throw throwBadRequestError('Could not connect to orchestrator');
      }
    }
    logWebhook({
      message: `${approve ? 'Approved' : 'Denied'} training dataset`,
      type: 'info',
      data: { modelVersionId },
    });
    return 'ok';
  } catch (e) {
    logWebhook({
      message: 'Failed to moderate training data',
      data: {
        modelVersionId,
        important: true,
        error: (e as Error)?.message,
        cause: (e as Error)?.cause,
      },
    });
    throw e;
  }
};

export async function handleApproveTrainingData({ input }: { input: GetByIdInput }) {
  const modelVersionId = input.id;
  const gateJobId = await getJobIdFromVersion(modelVersionId);
  return await moderateTrainingData({ modelVersionId, gateJobId, approve: true });
}

export async function handleDenyTrainingData({ input }: { input: GetByIdInput }) {
  const modelVersionId = input.id;
  const gateJobId = await getJobIdFromVersion(modelVersionId);
  return await moderateTrainingData({ modelVersionId, gateJobId, approve: false });
}
