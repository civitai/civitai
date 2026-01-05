import { Upload } from '@aws-sdk/lib-storage';
import type {
  ImageResourceTrainingStep,
  ImageResourceTrainingOutput,
  Workflow,
  TrainingStep,
  TrainingOutput,
} from '@civitai/client';
import { WorkflowStatus } from '@civitai/client';
import { dbWrite } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import type {
  AutoCaptionInput,
  AutoTagInput,
  MoveAssetInput,
  TrainingServiceStatus,
} from '~/server/schema/training.schema';
import { trainingServiceStatusSchema } from '~/server/schema/training.schema';
import {
  throwBadRequestError,
  throwRateLimitError,
  withRetries,
} from '~/server/utils/errorHandling';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { deleteObject, getGetUrl, getPutUrl, getS3Client, parseKey } from '~/utils/s3-utils';
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

const blobUrlRegex = /\/v\d\/consumer\/blobs\/(?<blobId>[A-Z0-9]+)\.(?<extension>\w+)/i;

type MoveAssetRow = {
  metadata: FileMetadata | null;
  updatedAt: Date;
};

async function moveAssetFromBlob({ url, modelVersionId }: { url: string; modelVersionId: number }) {
  console.log('[moveAssetFromBlob] Starting', { url, modelVersionId });

  const urlMatch = url.match(blobUrlRegex);
  if (!urlMatch || !urlMatch.groups) throw throwBadRequestError('Invalid blob URL');
  const { blobId, extension } = urlMatch.groups;
  const assetName = `${blobId}.${extension}`;
  console.log('[moveAssetFromBlob] Parsed blob URL', { blobId, extension, assetName });

  const {
    url: destinationUri,
    bucket,
    key,
  } = await getPutUrl(`modelVersion/${modelVersionId}/${assetName}`);
  console.log('[moveAssetFromBlob] Got put URL', { bucket, key });

  // Download the blob
  console.log('[moveAssetFromBlob] Fetching blob...');
  const response = await fetch(url);
  console.log('[moveAssetFromBlob] Fetch response', {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
  });
  if (!response.ok) {
    throw throwBadRequestError('Failed to download blob. Please try selecting the file again.');
  }

  const contentLength = response.headers.get('content-length');
  const fileSize = contentLength ? parseInt(contentLength, 10) : 0;
  console.log('[moveAssetFromBlob] Content info', { contentLength, fileSize });

  if (!response.body) {
    throw throwBadRequestError('Failed to download blob. No response body.');
  }

  // Upload to S3
  console.log('[moveAssetFromBlob] Starting S3 upload...');
  const s3Client = getS3Client();

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: key,
      // @ts-ignore - Node.js ReadableStream from fetch is compatible
      Body: response.body,
      ContentLength: fileSize || undefined,
    },
    queueSize: 4,
    partSize: 100 * 1024 * 1024, // 100 MB
    leavePartsOnError: false,
  });

  await upload.done();
  console.log('[moveAssetFromBlob] S3 upload complete');

  const newUrl = destinationUri.split('?')[0];
  console.log('[moveAssetFromBlob] Done', { newUrl, fileSize });

  return {
    newUrl,
    fileSize,
  };
}

async function moveAssetFromJob({
  url,
  modelVersionId,
  userId,
}: {
  url: string;
  modelVersionId: number;
  userId: number;
}) {
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
}

export const moveAsset = async ({
  url,
  modelVersionId,
  userId,
}: MoveAssetInput & { userId: number }) => {
  // Check if it's a blob URL (new format)
  if (blobUrlRegex.test(url)) {
    return moveAssetFromBlob({ url, modelVersionId });
  }

  // Otherwise, use the job asset flow (legacy format)
  return moveAssetFromJob({ url, modelVersionId, userId });
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

// ----- Training workflow status update logic -----

type WorkflowStepMetadata = { modelFileId: number };
export type CustomImageResourceTrainingStep = ImageResourceTrainingStep & {
  metadata: WorkflowStepMetadata;
};
export type CustomTrainingStep = TrainingStep & {
  metadata: WorkflowStepMetadata;
};

export const mapWorkflowStatusToTrainingStatus: { [key in WorkflowStatus]: TrainingStatus } = {
  unassigned: TrainingStatus.Submitted,
  preparing: TrainingStatus.Submitted,
  scheduled: TrainingStatus.Submitted,
  processing: TrainingStatus.Processing,
  failed: TrainingStatus.Failed,
  expired: TrainingStatus.Failed,
  canceled: TrainingStatus.Failed,
  succeeded: TrainingStatus.InReview,
};

export type TrainingWorkflowUpdateResult = {
  trainingStatus: TrainingStatus;
  previousStatus: TrainingStatus | undefined;
  statusChanged: boolean;
  modelVersionId: number;
  modelVersionName: string;
  modelId: number;
  modelName: string;
  userId: number;
  userEmail: string | null;
  username: string | null;
  fileMetadata: FileMetadata;
};

/**
 * Updates the model file metadata and model version training status based on workflow data.
 * Returns data needed for notifications (signals, emails, webhooks) which should be handled by the caller.
 */
export async function updateTrainingWorkflowRecords(
  workflow: Workflow,
  status: WorkflowStatus
): Promise<TrainingWorkflowUpdateResult> {
  const { transactions, steps, id: workflowId, createdAt, status: workflowStatus } = workflow;

  const step = steps?.[0] as (CustomImageResourceTrainingStep | CustomTrainingStep) | undefined;
  if (!step) throw new Error('Missing step data');
  if (!step.metadata.modelFileId) throw new Error('Missing modelFileId');

  const {
    metadata: { modelFileId },
    output,
    startedAt,
    completedAt,
  } = step;

  let trainingStatus = mapWorkflowStatusToTrainingStatus[workflowStatus ?? status];

  // Determine step type and extract data accordingly
  const stepType = step.$type;
  let epochs: Array<{
    epochNumber?: number;
    blobUrl?: string;
    blobSize?: number | null;
    sampleImages?: string[];
  }> = [];
  let sampleImagesPrompts: string[] = [];
  let moderationStatus: string | undefined;

  if (stepType === 'training') {
    // TrainingStep: new AI Toolkit format
    const trainingStep = step as CustomTrainingStep;
    moderationStatus = output?.moderationStatus;
    sampleImagesPrompts = trainingStep.input?.samples?.prompts ?? [];

    // Map TrainingEpochResult to our internal format
    const trainingOutput = output as TrainingOutput | undefined;
    epochs = (trainingOutput?.epochs ?? []).map((epoch) => ({
      epochNumber: epoch.epochNumber ?? -1,
      blobUrl: epoch.model?.url ?? '',
      blobSize: 0, // Not provided in TrainingStep
      sampleImages: (epoch.samples ?? []).map((s) => s.url ?? ''),
    }));
  } else if (stepType === 'imageResourceTraining') {
    // ImageResourceTrainingStep: legacy format
    const imageOutput = output as ImageResourceTrainingOutput | undefined;
    epochs = (imageOutput?.epochs ?? []).map((e) => ({
      epochNumber: e.epochNumber ?? -1,
      blobUrl: e.blobUrl,
      blobSize: e.blobSize ?? null,
      sampleImages: e.sampleImages ?? [],
    }));
    sampleImagesPrompts = imageOutput?.sampleImagesPrompts ?? [];
    moderationStatus = imageOutput?.moderationStatus;
  } else {
    throw new Error(`Unsupported step type: ${stepType}`);
  }

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

  const previousStatus = history[history.length - 1]?.status as TrainingStatus | undefined;
  const statusChanged = previousStatus !== trainingStatus;

  if (statusChanged) {
    history.push({
      time: new Date().toISOString(),
      status: trainingStatus,
    });
  }

  const epochData: TrainingResultsV2['epochs'] = epochs.map((e) => ({
    epochNumber: e.epochNumber ?? -1,
    modelUrl: e.blobUrl ?? '',
    modelSize: e.blobSize ?? 0,
    sampleImages: e.sampleImages ?? [],
  }));

  const newTrainingResults: TrainingResultsV2 = {
    ...trainingResults,
    version: 2,
    workflowId: trainingResults.workflowId ?? workflowId ?? 'unk',
    submittedAt: (createdAt ? new Date(createdAt) : new Date()).toISOString(),
    startedAt: trainingResults.startedAt ?? (startedAt ? new Date(startedAt).toISOString() : null),
    completedAt: completedAt ? new Date(completedAt).toISOString() : null,
    epochs: epochData,
    history,
    sampleImagesPrompts,
    transactionData: transactions?.list ?? trainingResults.transactionData ?? [],
  };

  const newMetadata: FileMetadata = {
    ...thisMetadata,
    trainingResults: newTrainingResults,
  };

  await withRetries(() =>
    dbWrite.modelFile.update({
      where: { id: modelFile.id },
      data: {
        metadata: newMetadata,
      },
    })
  );

  await withRetries(() =>
    dbWrite.modelVersion.update({
      where: { id: modelVersion.id },
      data: {
        trainingStatus,
      },
    })
  );

  return {
    trainingStatus,
    previousStatus,
    statusChanged,
    modelVersionId: modelVersion.id,
    modelVersionName: modelVersion.name,
    modelId: model.id,
    modelName: model.name,
    userId: model.user.id,
    userEmail: model.user.email,
    username: model.user.username,
    fileMetadata: newMetadata,
  };
}
