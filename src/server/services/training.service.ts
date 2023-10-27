import { TrainingStatus } from '@prisma/client';
import { trainingSettings } from '~/components/Resource/Forms/Training/TrainingSubmit';
import { env } from '~/env/server.mjs';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import { TrainingDetailsBaseModel, TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { CreateTrainingRequestInput, MoveAssetInput } from '~/server/schema/training.schema';
import {
  createBuzzTransaction,
  getUserBuzzAccount,
  refundTransaction,
} from '~/server/services/buzz.service';
import {
  throwBadRequestError,
  throwInsufficientFundsError,
  throwRateLimitError,
  withRetries,
} from '~/server/utils/errorHandling';
import { getGetUrl, getPutUrl } from '~/utils/s3-utils';
import { calcBuzzFromEta, calcEta } from '~/utils/training';
import orchestratorCaller from '../http/orchestrator/orchestrator.caller';
import { Orchestrator } from '../http/orchestrator/orchestrator.types';

const modelMap: { [key in TrainingDetailsBaseModel]: string } = {
  sdxl: 'civitai:101055@128078',
  sd_1_5: 'SD_1_5',
  anime: 'anime',
  realistic: 'civitai:81458@132760',
  semi: 'civitai:4384@128713',
};

type TrainingRequest = {
  trainingDetails: TrainingDetailsObj;
  modelName: string;
  trainingUrl: string;
  fileId: number;
  fileMetadata: FileMetadata | null;
};

const assetUrlRegex =
  /\/v\d\/consumer\/jobs\/(?<jobId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/assets\/(?<assetName>\S+)$/i;

export const moveAsset = async ({ url, modelId }: MoveAssetInput) => {
  const urlMatch = url.match(assetUrlRegex);
  if (!urlMatch || !urlMatch.groups) throw throwBadRequestError('Invalid URL');
  const { jobId, assetName } = urlMatch.groups;

  const { url: destinationUri } = await getPutUrl(`model/${modelId}/${assetName}`);

  const reqBody: Orchestrator.Training.CopyAssetJobPayload = {
    jobId,
    assetName,
    destinationUri,
  };

  const response = await orchestratorCaller.copyAsset({ payload: reqBody });
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

export const deleteAssets = async (jobId: string) => {
  const response = await orchestratorCaller.clearAssets({ payload: { jobId } });

  if (response.status === 429) {
    throw throwRateLimitError();
  }

  if (!response.ok) {
    throw throwBadRequestError('Failed to delete assets');
  }

  return response.data?.jobs?.[0]?.result;
};

export const createTrainingRequest = async ({
  userId,
  modelVersionId,
}: CreateTrainingRequestInput & { userId: number }) => {
  const modelVersions = await dbWrite.$queryRaw<TrainingRequest[]>`
    SELECT mv."trainingDetails",
           m.name      "modelName",
           mf.url      "trainingUrl",
           mf.id       "fileId",
           mf.metadata "fileMetadata"
    FROM "ModelVersion" mv
           JOIN "Model" m ON m.id = mv."modelId"
           JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
    WHERE m."userId" = ${userId}
      AND mv.id = ${modelVersionId}
  `;

  if (modelVersions.length === 0) throw throwBadRequestError('Invalid model version');
  const modelVersion = modelVersions[0];

  const trainingParams = modelVersion.trainingDetails.params;
  const baseModel = modelVersion.trainingDetails.baseModel;
  if (!trainingParams) throw throwBadRequestError('Missing training params');
  for (const [key, value] of Object.entries(trainingParams)) {
    const setting = trainingSettings.find((ts) => ts.name === key);
    if (!setting) continue;
    // TODO [bw] we should be doing more checking here (like validating this through zod), but this will handle the bad cases for now
    if (typeof value === 'number') {
      const override = baseModel ? setting.overrides?.[baseModel] : undefined;
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

  const eta = calcEta(
    trainingParams.networkDim,
    trainingParams.networkAlpha,
    trainingParams.targetSteps,
    baseModel
  );
  const price = eta !== undefined ? calcBuzzFromEta(eta) : eta;
  if (price === undefined) {
    throw throwBadRequestError(
      'Could not compute Buzz price for training - please check your parameters.'
    );
  }
  const account = await getUserBuzzAccount({ accountId: userId });
  if ((account.balance ?? 0) < price) {
    throw throwInsufficientFundsError(
      `You don't have enough Buzz to perform this action (required: ${price})`
    );
  }

  const { url: trainingUrl } = await getGetUrl(modelVersion.trainingUrl);

  // nb: going to hold off on externalTransactionId for now
  //     if we fail it, they'll never be able to proceed
  //     if we catch it, we have to match on a very changeable error message rather than code
  //        also, we will not have a transactionId, which means we can't refund them later in the process
  const { transactionId } = await createBuzzTransaction({
    fromAccountId: userId,
    toAccountId: 0,
    amount: price,
    type: TransactionType.Training,
    // externalTransactionId: `training|mvId:${modelVersionId}`,
  });

  const generationRequest = {
    $type: 'imageResourceTraining',
    // priority: 10,
    callbackUrl: `${env.GENERATION_CALLBACK_HOST}/api/webhooks/resource-training?token=${env.WEBHOOK_TOKEN}`,
    properties: { userId, transactionId, modelFileId: modelVersion.fileId },
    model: modelMap[baseModel!],
    trainingData: trainingUrl,
    maxRetryAttempt: constants.maxTrainingRetries,
    params: {
      ...trainingParams,
      modelFileId: modelVersion.fileId,
      loraName: modelVersion.modelName,
    },
  };

  const response = await orchestratorCaller.imageResourceTraining({ payload: generationRequest });

  if (!response.ok) {
    await withRetries(async () =>
      refundTransaction(transactionId, 'Refund due to an error submitting the training job.')
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
