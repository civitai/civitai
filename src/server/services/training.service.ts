import { env } from '~/env/server.mjs';
import { TrainingDetailsBaseModel } from '~/server/schema/model-version.schema';
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

export const createTrainingRequest = async ({
  userId,
  model,
  trainingData,
  params,
}: CreateTrainingRequestInput & { userId: number }) => {
  if (!env.GENERATION_ENDPOINT) throw throwBadRequestError('Missing GENERATION_ENDPOINT env');
  if (!env.ORCHESTRATOR_TOKEN) throw throwBadRequestError('Missing ORCHESTRATOR_TOKEN env');

  const { url: trainingUrl } = await getGetUrl(trainingData);

  const generationRequest = {
    $type: 'imageResourceTraining',
    // priority: 10,
    callbackUrl: `${env.GENERATION_CALLBACK_HOST}/api/webhooks/image-resource-training?token=${env.WEBHOOK_TOKEN}`,
    properties: { userId },
    model: modelMap[model],
    trainingData: trainingUrl,
    params: params,
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
  // const [formatted] = await formatGenerationRequests([data]);
  return data;
};
