import { TrainingStatus } from '@prisma/client';
import { trainingSettings } from '~/components/Resource/Forms/Training/TrainingSubmit';
import { env } from '~/env/server.mjs';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { TrainingDetailsBaseModel, TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { CreateTrainingRequestInput, MoveAssetInput } from '~/server/schema/training.schema';
import { throwBadRequestError, throwRateLimitError } from '~/server/utils/errorHandling';
import { getGetUrl, getPutUrl } from '~/utils/s3-utils';

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

type moveAssetResponse = {
  found?: boolean;
  fileSize?: number;
};

const assetUrlRegex =
  /\/v\d\/consumer\/jobs\/(?<jobId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/assets\/(?<assetName>\S+)$/i;

export const moveAsset = async ({ url, modelId }: MoveAssetInput) => {
  const urlMatch = url.match(assetUrlRegex);
  if (!urlMatch || !urlMatch.groups) throw throwBadRequestError('Invalid URL');
  const { jobId, assetName } = urlMatch.groups;

  const { url: destinationUri } = await getPutUrl(`model/${modelId}/${assetName}`);

  const reqBody = {
    $type: 'copyAsset',
    jobId,
    assetName,
    destinationUri,
  };

  const response = await fetch(`${env.GENERATION_ENDPOINT}/v1/consumer/jobs?wait=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ORCHESTRATOR_TOKEN}`,
    },
    body: JSON.stringify(reqBody),
  });

  if (response.status === 429) {
    throw throwRateLimitError();
  }

  if (!response.ok) {
    throw throwBadRequestError('Failed to move asset');
  }
  const data = await response.json();
  const result: moveAssetResponse | undefined = data.result;

  if (!result || !result.found) {
    throw throwBadRequestError('Failed to move asset');
  }

  const newUrl = destinationUri.split('?')[0];

  return {
    newUrl,
    fileSize: result.fileSize,
  };
};

export const createTrainingRequest = async ({
  userId,
  modelVersionId,
}: CreateTrainingRequestInput & { userId: number }) => {
  if (!env.GENERATION_ENDPOINT) throw throwBadRequestError('Missing GENERATION_ENDPOINT env');
  if (!env.ORCHESTRATOR_TOKEN) throw throwBadRequestError('Missing ORCHESTRATOR_TOKEN env');

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
  if (!trainingParams) throw throwBadRequestError('Missing training params');
  for (const [key, value] of Object.entries(trainingParams)) {
    const setting = trainingSettings.find((ts) => ts.name === key);
    if (!setting) continue;
    // TODO [bw] we should be doing more checking here (like validating this through zod), but this will handle the bad cases for now
    if (typeof value === 'number') {
      if ((setting.min && value < setting.min) || (setting.max && value > setting.max)) {
        throw throwBadRequestError(
          `Invalid settings for training: "${key}" is outside allowed min/max.`
        );
      }
    }
  }

  const { url: trainingUrl } = await getGetUrl(modelVersion.trainingUrl);

  const generationRequest = {
    $type: 'imageResourceTraining',
    // priority: 10,
    callbackUrl: `${env.GENERATION_CALLBACK_HOST}/api/webhooks/image-resource-training?token=${env.WEBHOOK_TOKEN}`,
    properties: { userId },
    model: modelMap[modelVersion.trainingDetails.baseModel!],
    trainingData: trainingUrl,
    maxRetryAttempt: constants.maxTrainingRetries,
    params: {
      ...trainingParams,
      modelFileId: modelVersion.fileId,
      loraName: modelVersion.modelName,
    },
  };

  // console.log(JSON.stringify(generationRequest));

  const response = await fetch(`${env.GENERATION_ENDPOINT}/v1/consumer/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ORCHESTRATOR_TOKEN}`,
    },
    body: JSON.stringify(generationRequest),
  });

  // console.log(response);

  if (response.status === 429) {
    throw throwRateLimitError();
  }

  if (!response.ok) {
    const message = await response.json();
    throw throwBadRequestError(message);
  }
  // const data: Generation.Api.RequestProps = await response.json();
  const data = await response.json();
  const fileMetadata = modelVersion.fileMetadata || {};

  await dbWrite.modelFile.update({
    where: { id: modelVersion.fileId },
    data: {
      metadata: {
        ...fileMetadata,
        trainingResults: {
          ...(fileMetadata.trainingResults || {}),
          history: (fileMetadata.trainingResults?.history || []).concat([
            {
              jobId: data.jobId as string,
              jobToken: data.token as string,
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
