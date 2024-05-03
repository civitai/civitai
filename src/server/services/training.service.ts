import { TrainingStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { isTrainingCustomModel } from '~/components/Training/Form/TrainingCommon';
import { trainingSettings } from '~/components/Training/Form/TrainingSubmit';
import { env } from '~/env/server.mjs';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import { TrainingDetailsBaseModel, TrainingDetailsObj } from '~/server/schema/model-version.schema';
import {
  AutoTagInput,
  CreateTrainingRequestDryRunInput,
  CreateTrainingRequestInput,
  MoveAssetInput,
  TrainingServiceStatus,
  trainingServiceStatusSchema,
} from '~/server/schema/training.schema';
import {
  createBuzzTransaction,
  getUserBuzzAccount,
  refundTransaction,
} from '~/server/services/buzz.service';
import {
  throwBadRequestError,
  throwDbError,
  throwInsufficientFundsError,
  throwRateLimitError,
  withRetries,
} from '~/server/utils/errorHandling';
import { deleteObject, getGetUrl, getPutUrl, parseKey } from '~/utils/s3-utils';
import { calcBuzzFromEta, calcEta } from '~/utils/training';
import { getOrchestratorCaller } from '../http/orchestrator/orchestrator.caller';
import { Orchestrator } from '../http/orchestrator/orchestrator.types';

const modelMap: { [key in TrainingDetailsBaseModel]: string } = {
  sdxl: 'civitai:101055@128078',
  sd_1_5: 'SD_1_5',
  anime: 'civitai:84586@89927',
  realistic: 'civitai:81458@132760',
  semi: 'civitai:4384@128713',
  pony: 'civitai:257749@290640',
};

type TrainingRequest = {
  trainingDetails: TrainingDetailsObj;
  modelName: string;
  trainingUrl: string;
  fileId: number;
  userId: number;
  fileMetadata: FileMetadata | null;
};

async function getSubmittedAt(modelVersionId: number, userId: number) {
  const [modelFile] = await dbWrite.$queryRaw<MoveAssetRow[]>`
    SELECT mf.metadata, mv."updatedAt"
    FROM "ModelVersion" mv
           JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
           JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv.id = ${modelVersionId}
      AND m."userId" = ${userId}
  `;

  if (!modelFile) throw throwBadRequestError('Invalid model version');
  if (modelFile.metadata?.trainingResults?.submittedAt) {
    return new Date(modelFile.metadata.trainingResults.submittedAt);
  } else if (modelFile.metadata?.trainingResults?.history) {
    for (const { status, time } of modelFile.metadata.trainingResults.history) {
      if (status === TrainingStatus.Submitted) {
        return new Date(time);
      }
    }
  }

  return modelFile.updatedAt;
}

async function isSafeTensor(modelVersionId: number) {
  // it's possible we need to modify this if a model somehow has pickle and safetensor
  const [data] = await dbWrite.$queryRaw<{ fmt: string }[]>`
    SELECT mf.metadata ->> 'format' as fmt
    FROM "ModelVersion" mv
           JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Model'
           JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv.id = ${modelVersionId}
    LIMIT 1
  `;

  return data?.fmt === 'SafeTensor';
}

const assetUrlRegex =
  /\/v\d\/consumer\/jobs\/(?<jobId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/assets\/(?<assetName>\S+)$/i;
const modelAIRRegex = /^civitai:(?<custModelId>\d+)@(?<custModelVersionId>\d+)$/i;

type MoveAssetRow = {
  metadata: FileMetadata | null;
  updatedAt: Date;
};
export const moveAsset = async ({
  url,
  modelVersionId,
  modelId,
  userId,
}: MoveAssetInput & { userId: number }) => {
  const urlMatch = url.match(assetUrlRegex);
  if (!urlMatch || !urlMatch.groups) throw throwBadRequestError('Invalid URL');
  const { jobId, assetName } = urlMatch.groups;

  const { url: destinationUri } = await getPutUrl(`model/${modelId}/${assetName}`);

  const reqBody: Orchestrator.Training.CopyAssetJobPayload = {
    jobId,
    assetName,
    destinationUri,
  };

  const submittedAt = await getSubmittedAt(modelVersionId, userId);
  const response = await getOrchestratorCaller(submittedAt).copyAsset({
    payload: reqBody,
    queryParams: { wait: true },
  });
  if (response.status === 429) {
    throw throwRateLimitError();
  }

  if (!response.ok) {
    throw throwBadRequestError('Failed to move asset. Please try selecting the file again.');
  }

  const result = response.data?.jobs?.[0]?.result;
  if (!result || !result.found) {
    throw throwBadRequestError('Failed to move asset. Please try selecting the file again.');
  }

  const newUrl = destinationUri.split('?')[0];

  return {
    newUrl,
    fileSize: result.fileSize,
  };
};

export const deleteAssets = async (jobId: string, submittedAt?: Date) => {
  const response = await getOrchestratorCaller(submittedAt).clearAssets({
    payload: { jobId },
    queryParams: { wait: true },
  });

  if (response.status === 429) {
    throw throwRateLimitError();
  }

  if (!response.ok) {
    throw throwBadRequestError('Failed to delete assets');
  }

  return response.data?.jobs?.[0]?.result;
};

export async function getTrainingServiceStatus() {
  const result = trainingServiceStatusSchema.safeParse(
    JSON.parse((await redis.hGet(REDIS_KEYS.SYSTEM.FEATURES, REDIS_KEYS.TRAINING.STATUS)) ?? '{}')
  );
  if (!result.success) return trainingServiceStatusSchema.parse({});

  return result.data as TrainingServiceStatus;
}

export const createTrainingRequest = async ({
  userId,
  modelVersionId,
  isModerator,
}: CreateTrainingRequestInput & {
  userId?: number;
  isModerator?: boolean;
}) => {
  const status = await getTrainingServiceStatus();
  if (!status.available && !isModerator)
    throw throwBadRequestError(status.message ?? 'Training is currently disabled');

  const modelVersions = await dbWrite.$queryRaw<TrainingRequest[]>`
    SELECT mv."trainingDetails",
           m.name      "modelName",
           m."userId",
           mf.url      "trainingUrl",
           mf.id       "fileId",
           mf.metadata "fileMetadata"
    FROM "ModelVersion" mv
           JOIN "Model" m ON m.id = mv."modelId"
           JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
    WHERE mv.id = ${modelVersionId}
  `;

  if (modelVersions.length === 0) throw throwBadRequestError('Invalid model version');
  const modelVersion = modelVersions[0];

  // Don't allow a user to queue anything but their own training
  if (userId && userId != modelVersion.userId) throw throwBadRequestError('Invalid user');

  const trainingParams = modelVersion.trainingDetails.params;
  if (!trainingParams) throw throwBadRequestError('Missing training params');
  const baseModel = modelVersion.trainingDetails.baseModel;
  if (!baseModel) throw throwBadRequestError('Missing base model');
  if ((status.blockedModels ?? []).includes(baseModel))
    throw throwBadRequestError(
      'This model has been blocked from training - please try another one.'
    );

  const samplePrompts = modelVersion.trainingDetails.samplePrompts;
  const baseModelType = modelVersion.trainingDetails.baseModelType ?? 'sd15';

  for (const [key, value] of Object.entries(trainingParams)) {
    const setting = trainingSettings.find((ts) => ts.name === key);
    if (!setting) continue;
    // TODO [bw] we should be doing more checking here (like validating this through zod), but this will handle the bad cases for now
    if (setting.type === 'int' || setting.type === 'number') {
      const override = setting.overrides?.[baseModel];
      const overrideSetting = override ?? setting;
      if (
        (overrideSetting.min && value < overrideSetting.min) ||
        (overrideSetting.max && value > overrideSetting.max)
      ) {
        throw throwBadRequestError(
          `Invalid settings for training: "${key}" is outside allowed min/max.`
        );
      }
    }
  }

  const eta = calcEta({
    cost: status.cost,
    baseModel: baseModelType,
    targetSteps: trainingParams.targetSteps,
  });

  // Determine if we still need to charge them for this training
  let transactionId = modelVersion.fileMetadata?.trainingResults?.transactionId;
  if (!transactionId) {
    // And if so, charge them
    if (eta === undefined) {
      throw throwBadRequestError(
        'Could not compute Buzz price for training - please check your parameters.'
      );
    }

    const isCustom = isTrainingCustomModel(baseModel);
    const price = calcBuzzFromEta({
      cost: status.cost,
      eta,
      isCustom,
    });

    if (!price || price < status.cost.baseBuzz) {
      throw throwBadRequestError(
        'Could not compute Buzz price for training - please check your parameters.'
      );
    }

    const account = await getUserBuzzAccount({ accountId: modelVersion.userId });
    if ((account.balance ?? 0) < price) {
      throw throwInsufficientFundsError(
        `You don't have enough Buzz to perform this action (required: ${price})`
      );
    }

    if (!(baseModel in modelMap)) {
      const mMatch = baseModel.match(modelAIRRegex);
      if (!mMatch || !mMatch.groups)
        throw throwBadRequestError('Invalid structure for custom model');
      const { custModelVersionId } = mMatch.groups;
      const isST = await isSafeTensor(Number(custModelVersionId));
      if (!isST) {
        throw throwBadRequestError(
          'Custom model does not have a SafeTensor file. Please choose another model.'
        );
      }
    }

    // nb: going to hold off on externalTransactionId for now
    //     if we fail it, they'll never be able to proceed
    //     if we catch it, we have to match on a very changeable error message rather than code
    //        also, we will not have a transactionId, which means we can't refund them later in the process
    const { transactionId: newTransactionId } = await createBuzzTransaction({
      fromAccountId: modelVersion.userId,
      toAccountId: 0,
      amount: price,
      type: TransactionType.Training,
      // externalTransactionId: `training|mvId:${modelVersionId}`,
    });
    transactionId = newTransactionId;
  }

  const { url: trainingUrl } = await getGetUrl(modelVersion.trainingUrl);
  const generationRequest: Orchestrator.Training.ImageResourceTrainingJobPayload = {
    // priority: 10,
    callbackUrl: `${env.WEBHOOK_URL}/resource-training?token=${env.WEBHOOK_TOKEN}`,
    properties: { userId, transactionId, modelFileId: modelVersion.fileId },
    model: baseModel in modelMap ? modelMap[baseModel] : baseModel,
    trainingData: trainingUrl,
    cost: Math.round((eta ?? 0) * 100) / 100,
    retries: constants.maxTrainingRetries,
    params: {
      ...trainingParams,
      samplePrompts: samplePrompts ?? ['', '', ''],
      modelFileId: modelVersion.fileId,
      loraName: modelVersion.modelName,
    },
  };

  const orchCaller = getOrchestratorCaller(
    new Date(),
    modelVersion.trainingDetails.staging === true
  );

  const response = await orchCaller.imageResourceTraining({
    payload: generationRequest,
  });
  if (!response.ok && transactionId) {
    await withRetries(async () =>
      refundTransaction(
        transactionId as string,
        'Refund due to an error submitting the training job.'
      )
    );
  }

  if (response.status === 429) {
    throw throwRateLimitError();
  }

  if (!response.ok) {
    throw throwBadRequestError(
      'We are not able to process your request at this time. Please try again later'
    );
  }

  const data = response.data;
  const fileMetadata = modelVersion.fileMetadata || {};

  await dbWrite.modelFile.update({
    where: { id: modelVersion.fileId },
    data: {
      metadata: {
        ...fileMetadata,
        trainingResults: {
          ...(fileMetadata.trainingResults || {}),
          submittedAt: new Date().toISOString(),
          jobId: data?.jobs?.[0]?.jobId,
          transactionId,
          history: (fileMetadata.trainingResults?.history || []).concat([
            {
              time: new Date().toISOString(),
              status: TrainingStatus.Submitted,
            },
          ]),
        },
      },
    },
  });

  // const [formatted] = await formatGenerationRequests([data]);
  return data;
};

export const createTrainingRequestDryRun = async ({
  baseModel,
}: CreateTrainingRequestDryRunInput) => {
  if (!baseModel) return null;

  const generationRequest: Orchestrator.Training.ImageResourceTrainingJobDryRunPayload = {
    model: baseModel in modelMap ? modelMap[baseModel] : baseModel,
    // cost: Math.round((cost ?? 0) * 100) / 100,
    cost: 0,
    trainingData: '',
    params: {},
  };

  const response = await getOrchestratorCaller(new Date()).imageResourceTrainingDryRun({
    payload: generationRequest,
  });

  if (!response.ok) {
    return null;
  }

  return (
    response.data?.jobs?.[0]?.serviceProviders?.['RunPods']?.queuePosition?.estimatedStartDate ??
    null
  );
};

export type TagDataResponse = {
  [key: string]: {
    wdTagger: {
      tags: {
        [key: string]: number;
      };
    };
  };
};
export type AutoTagResponse = {
  [key: string]: {
    [key: string]: number;
  };
};

export const autoTagHandler = async ({
  url,
  modelId,
  userId,
}: AutoTagInput & {
  userId: number;
}) => {
  const { url: getUrl } = await getGetUrl(url);
  const { key, bucket } = parseKey(url);

  const payload: Orchestrator.Training.ImageAutoTagJobPayload = {
    mediaUrl: getUrl,
    modelId,
    properties: { userId, modelId },
    retries: 0,
  };

  const response = await getOrchestratorCaller(new Date()).imageAutoTag({
    payload,
  });

  if (response.status === 429) {
    deleteObject(bucket, key).catch();
    throw throwRateLimitError();
  }

  if (!response.ok) {
    deleteObject(bucket, key).catch();
    throw throwBadRequestError(
      'We are not able to process your request at this time. Please try again later.'
    );
  }

  return response.data;
};

export const getJobEstStartsHandler = async ({ userId }: { userId: number }) => {
  try {
    const modelData = await dbWrite.$queryRaw<{ id: number; job_id: string | null }[]>`
      SELECT m.id,
             mf.metadata -> 'trainingResults' ->> 'jobId' as job_id
      FROM "ModelVersion" mv
             JOIN "Model" m ON m.id = mv."modelId"
             JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
      WHERE m."userId" = ${userId}
        AND m."uploadType" = 'Trained'
        AND m.status not in ('Published', 'Deleted')
        AND mv."trainingStatus" = 'Submitted'
    `;

    const returnData: { [key: number]: Date | undefined } = {};
    for (const md of modelData) {
      const { id: mId, job_id: jobId } = md;
      if (!jobId) continue;

      const res = await getOrchestratorCaller(new Date()).getJobById({ id: jobId });
      if (!res.ok) continue;
      const { data } = res;

      returnData[mId] = data?.serviceProviders?.['RunPods']?.queuePosition?.estimatedStartDate;
    }

    return returnData;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
