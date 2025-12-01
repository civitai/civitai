import { dbWrite } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import type {
  AutoCaptionInput,
  AutoTagInput,
  MoveAssetInput,
  TrainingServiceStatus,
} from '~/server/schema/training.schema';
import { trainingServiceStatusSchema } from '~/server/schema/training.schema';
import { throwBadRequestError, throwRateLimitError } from '~/server/utils/errorHandling';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { deleteObject, getGetUrl, getPutUrl, parseKey } from '~/utils/s3-utils';
import { getOrchestratorCaller } from '../http/orchestrator/orchestrator.caller';
import type { Orchestrator } from '../http/orchestrator/orchestrator.types';

export type TrainingRequest = {
  trainingDetails: TrainingDetailsObj;
  modelName: string;
  trainingUrl: string;
  fileId: number;
  userId: number;
  fileMetadata: FileMetadata | null;
  modelVersionId: number;
  modelVersionMetadata?: MixedObject | null;
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

const assetUrlRegex =
  /\/v\d\/consumer\/jobs\/(?<jobId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/assets\/(?<assetName>\S+)$/i;

type MoveAssetRow = {
  metadata: FileMetadata | null;
  updatedAt: Date;
};
export const moveAsset = async ({
  url,
  modelVersionId,
  userId,
}: MoveAssetInput & { userId: number }) => {
  const urlMatch = url.match(assetUrlRegex);
  if (!urlMatch || !urlMatch.groups) throw throwBadRequestError('Invalid URL');
  const { jobId, assetName } = urlMatch.groups;

  const { url: destinationUri } = await getPutUrl(`modelVersion/${modelVersionId}/${assetName}`);

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

  const thisJob = response.data?.jobs?.[0];

  if (!thisJob || thisJob.lastEvent?.type !== 'Succeeded') {
    throw throwBadRequestError('Failed to move asset. Please try selecting the file again.');
  }

  const result = thisJob.result;
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
    JSON.parse(
      (await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.TRAINING.STATUS)) ?? '{}'
    )
  );
  if (!result.success) return trainingServiceStatusSchema.parse({});

  return result.data as TrainingServiceStatus;
}

/**
 * @deprecated for orchestrator v2
 */
export const createTrainingRequest = async ({}) => {
  throw throwBadRequestError('This function has been deprecated - please refresh your browser.');
};

/**
 * @deprecated for orchestrator v2
 */
export const createTrainingRequestDryRun = async ({}) => {
  return null;
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
export type CaptionDataResponse = {
  [key: string]: {
    joyCaption: {
      caption: string;
    };
  };
};
export type AutoCaptionResponse = {
  [key: string]: string;
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
  if (!bucket) throw throwBadRequestError('Invalid URL');

  // todo check if this property comes through

  const payload: Orchestrator.Training.ImageAutoTagJobPayload = {
    mediaUrl: getUrl,
    modelId,
    properties: { userId, modelId, mediaType: 'video' },
    retries: 0,
  };

  const response = await getOrchestratorCaller(new Date()).imageAutoTag({
    payload,
  });

  console.log(response, payload);

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

export const autoCaptionHandler = async ({
  url,
  modelId,
  userId,
  temperature,
  maxNewTokens,
}: AutoCaptionInput & {
  userId: number;
}) => {
  const { url: getUrl } = await getGetUrl(url);
  const { key, bucket } = parseKey(url);
  if (!bucket) throw throwBadRequestError('Invalid URL');

  const payload: Orchestrator.Training.ImageAutoCaptionJobPayload = {
    mediaUrl: getUrl,
    modelId,
    properties: { userId, modelId, mediaType: 'video' },
    retries: 0,
    model: 'joy-caption-pre-alpha',
    temperature,
    maxNewTokens,
  };

  const response = await getOrchestratorCaller(new Date()).imageAutoCaption({
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

/**
 * @deprecated for orchestrator v2
 */
export const getJobEstStartsHandler = async ({ userId }: { userId: number }) => {
  throw throwBadRequestError('This function has been deprecated - please refresh your browser.');
};
