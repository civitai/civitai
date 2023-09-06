import { TrainingStatus } from '@prisma/client';
import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { TrainingDetailsBaseModel, TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { CreateTrainingRequestInput } from '~/server/schema/training.schema';
import { throwBadRequestError, throwRateLimitError } from '~/server/utils/errorHandling';
import { getGetUrl } from '~/utils/s3-utils';

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

export const createTrainingRequest = async ({
  userId,
  modelVersionId,
}: CreateTrainingRequestInput & { userId: number }) => {
  if (!env.GENERATION_ENDPOINT) throw throwBadRequestError('Missing GENERATION_ENDPOINT env');
  if (!env.ORCHESTRATOR_TOKEN) throw throwBadRequestError('Missing ORCHESTRATOR_TOKEN env');

  const modelVersions = await dbWrite.$queryRaw<TrainingRequest[]>`
    SELECT
      mv."trainingDetails",
      m.name "modelName",
      mf.url "trainingUrl",
      mf.id "fileId",
      mf.metadata "fileMetadata"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
    WHERE m."userId" = ${userId} AND mv.id = ${modelVersionId}
  `;

  if (modelVersions.length === 0) throw throwBadRequestError('Invalid model version');
  const modelVersion = modelVersions[0];

  const { url: trainingUrl } = await getGetUrl(modelVersion.trainingUrl);

  const generationRequest = {
    $type: 'imageResourceTraining',
    // priority: 10,
    callbackUrl: `${env.GENERATION_CALLBACK_HOST}/api/webhooks/image-resource-training?token=${env.WEBHOOK_TOKEN}`,
    properties: { userId },
    model: modelMap[modelVersion.trainingDetails.baseModel!],
    trainingData: trainingUrl,
    maxRetryAttempt: 2,
    params: {
      ...modelVersion.trainingDetails.params,
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
          history: [
            {
              // nb: this will overwrite if its ever rerun
              jobId: data.jobId as string,
              jobToken: data.token as string,
              time: new Date().toISOString(),
              status: TrainingStatus.Submitted,
            },
          ],
        },
      },
    },
  });

  // const [formatted] = await formatGenerationRequests([data]);
  return data;
};
