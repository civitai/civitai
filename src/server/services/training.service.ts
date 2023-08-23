import { env } from '~/env/server.mjs';
import { CreateTrainingRequestInput } from '~/server/schema/training.schema';
import { throwBadRequestError, throwRateLimitError } from '~/server/utils/errorHandling';
import { getGetUrl } from '~/utils/s3-utils';

export const createTrainingRequest = async ({
  userId,
  model,
  trainingData,
  params,
}: CreateTrainingRequestInput & { userId: number }) => {
  /*
    "params": {
        "modelFileId": 92083,
        "loraName": "lilith",
        "unetLR": 0.0005,
        "textEncoderLR": 0.0001,
        "optimizerType": "AdamW8bit",
        "networkDim": 16,
        "networkAlpha": 8,
        "lrScheduler": "cosine_with_restarts",
        "lrWarmupSteps": 40,
        "maxTrainSteps": 800,
        "maxTrainEpochs": 10,
        "saveEveryNEpoochs": 1,
        "saveLastNEpochs": 10,
        "sampleEveryNEpochs": 1,
        "trainBatchSize": 2,
        "clipSkip": 2,
        "weightedCaptions": false,
        "seed": null,
        "maxTokenLength": 225,
        "lowram": false,
        "maxDataLoaderNWorkers": 8,
        "persistentDataLoaderWorkers": true,
        "xformers": true,
        "sdpa": false,
        "noHalfVae": false,
        "gradientCheckpointing": false,
        "gradientAccumulationSteps": 1,
        "v2": false,
        "resolution": 512,
        "shuffleCaption": false,
        "keepTokens": 1,
        "targetSteps": 500
    },
   */

  const { url: trainingUrl } = await getGetUrl(trainingData);

  const generationRequest = {
    $type: 'imageResourceTraining',
    // priority: 10,
    callbackUrl:
      'https://c933-135-131-230-67.ngrok-free.app/api/webhooks/image-resource-training?token=mycooltoken',
    properties: { userId },
    model: model,
    trainingData: trainingUrl,
    params: params,
  };

  console.log(JSON.stringify(generationRequest));

  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(generationRequest),
  });

  console.log(response);

  if (response.status === 429) {
    throw throwRateLimitError();
  }

  if (!response.ok) {
    const message = await response.json();
    throw throwBadRequestError(message);
  }
  // const data: Generation.Api.RequestProps = await response.json();
  const data = await response.json();
  // const [formatted] = await formatGenerationRequests([data]);
  return data;
};
