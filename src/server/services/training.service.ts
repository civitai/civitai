import { Upload } from '@aws-sdk/lib-storage';
import type {
  AudioCaptioningStepTemplate,
  MediaCaptioningStepTemplate,
  WdTaggingStepTemplate,
  Workflow,
  WorkflowStepTemplate,
} from '@civitai/client';
import type { WorkflowStatus } from '@civitai/client';
import {
  getConsumerBlobUploadUrl,
  getWorkflow as clientGetWorkflow,
  handleError,
  submitWorkflow as clientSubmitWorkflow,
} from '@civitai/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { preventModelVersionLag } from '~/server/db/db-lag-helpers';
import { logToAxiom } from '~/server/logging/client';
import { dataForModelsCache } from '~/server/redis/caches';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import type {
  AutoCaptionInput,
  AutoTagInput,
  GetAutoLabelUploadUrlInput,
  GetAutoLabelWorkflowInput,
  SubmitAutoLabelWorkflowInput,
  TrainingServiceStatus,
} from '~/server/schema/training.schema';
import { trainingServiceStatusSchema } from '~/server/schema/training.schema';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { isTrustedOrchestratorUrl } from '~/server/services/orchestrator/trusted-blob-url';
import {
  deriveTrainingWorkflowState,
  offsetEpochNumbers,
  TrainingRecordNotFoundError,
} from '~/server/services/orchestrator/training/workflow-state';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
  throwRateLimitError,
  throwServiceUnavailableError,
  withRetries,
} from '~/server/utils/errorHandling';
import { isPublicHttpsUrl } from '~/server/utils/ssrf-hostname';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import {
  deleteObject,
  getB2S3Client,
  getGetUrl,
  getPutUrl,
  getS3Client,
  isB2Url,
  parseKey,
} from '~/utils/s3-utils';
import { getOrchestratorCaller } from '../http/orchestrator/orchestrator.caller';
import type { Orchestrator } from '../http/orchestrator/orchestrator.types';

export type TrainingRequest = {
  trainingDetails: TrainingDetailsObj;
  modelName: string;
  trainedWords: string[] | null;
  trainingUrl: string;
  fileId: number;
  userId: number;
  fileMetadata: FileMetadata | null;
  modelVersionId: number;
  modelVersionMetadata?: MixedObject | null;
};

const blobUrlRegex = /\/v\d\/consumer\/blobs\/(?<blobId>[A-Z0-9]+)\.(?<extension>\w+)/i;

export const isBlobAssetUrl = (url: string) => blobUrlRegex.test(url);

export async function moveAssetFromBlob({
  url,
  modelVersionId,
}: {
  url: string;
  modelVersionId: number;
}) {
  // blobUrlRegex matches a path, so it says nothing about which host answers. This URL is
  // fetched and its body stored under our own bucket — see isTrustedOrchestratorUrl.
  if (!isTrustedOrchestratorUrl(url)) throw throwBadRequestError('Invalid asset URL');
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
  // Fail open: symmetric with the three getGenerationStatus fixes in this
  // PR. A sysRedis outage shouldn't crash the training status endpoint or
  // training submission. Falls back to the schema's '{}' default.
  // Note on Buffer-vs-string asymmetry (see PR #2697): sysRedis.hGet is typed
  // `string | null` but the HA/Sentinel client returns a Buffer for
  // BLOB_STRING replies. `JSON.parse` accepts a Buffer in Node ≥18 (we run
  // Node 20 — see Dockerfile), and the `?? '{}'` fallback only fires when
  // `raw` is null/undefined (Buffer is truthy), so this site is correct
  // under both client modes. The fix sweep that accompanies this comment
  // touched the sites that did string-typed ops (=== 'true', .split, etc.).
  let raw: string | null | undefined;
  try {
    // Wall-clock deadline: symmetric with the getGenerationStatus wrap in STEP 6.
    // The try/catch only covers a fast DOWN reject — a silent sysRedis half-open
    // would park this awaited hGet ~11min on the training status/submit path.
    raw = await withSysReadDeadline(
      sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.TRAINING.STATUS)
    );
  } catch (err) {
    logSysRedisFailOpen('defaults-firing', 'getTrainingServiceStatus', err);
    raw = undefined;
  }
  const result = trainingServiceStatusSchema.safeParse(JSON.parse(raw ?? '{}'));
  if (!result.success) return trainingServiceStatusSchema.parse({});

  return result.data as TrainingServiceStatus;
}

export async function setTrainingServiceStatus(input: {
  available: boolean;
  message?: string | null;
}) {
  // Read raw and throw on sysRedis error. We MUST NOT use the fail-open
  // getTrainingServiceStatus() here: if its read failed open and the
  // hSet succeeded, ops-configured blockedModels / blockedCustomModels
  // would be wiped back to schema defaults. Fail-loud is the right
  // behavior for admin writes.
  const raw = await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.TRAINING.STATUS);
  const parsed = trainingServiceStatusSchema.safeParse(JSON.parse(raw ?? '{}'));
  const current = parsed.success ? parsed.data : trainingServiceStatusSchema.parse({});
  const next: TrainingServiceStatus = {
    ...current,
    available: input.available,
    message: input.message ?? null,
  };
  await sysRedis.hSet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    REDIS_SYS_KEYS.TRAINING.STATUS,
    JSON.stringify(next)
  );
  return next;
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
  const { url: getUrl } = isB2Url(url)
    ? await getGetUrl(url, { s3: getB2S3Client() })
    : await getGetUrl(url);
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
  const { url: getUrl } = isB2Url(url)
    ? await getGetUrl(url, { s3: getB2S3Client() })
    : await getGetUrl(url);
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
//
// The workflow→state mapping itself lives in `orchestrator/training/workflow-state`, which the
// read overlay shares. Re-exported here because the webhook imports these from this module.
export type {
  CustomImageResourceTrainingStep,
  CustomTrainingStep,
  DerivedTrainingWorkflowState,
} from '~/server/services/orchestrator/training/workflow-state';
export {
  deriveTrainingWorkflowState,
  mapWorkflowStatusToTrainingStatus,
  PermanentTrainingWebhookError,
  TrainingRecordNotFoundError,
} from '~/server/services/orchestrator/training/workflow-state';

export type TrainingWorkflowUpdateResult = {
  trainingStatus: TrainingStatus;
  previousStatus: TrainingStatus | undefined;
  statusChanged: boolean;
  hasOutput: boolean;
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
  const derived = deriveTrainingWorkflowState(workflow, status);
  const { modelFileId, trainingStatus, epochs: derivedEpochs } = derived;

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
  if (!modelFile) throw new TrainingRecordNotFoundError(`ModelFile not found: "${modelFileId}"`);

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

  // Read, never derived: createTrainingWorkflow stamps this at submit, and this runs again on any
  // re-sync of a finished run. Deriving it here would renumber one — and generation binds an epoch
  // by value, where getTrainingFileEpochNumberDetails answers a miss with the newest epoch rather
  // than an error, so those bindings would silently move to other weights. Not enforced, though:
  // `modelFileMetadataSchema` takes `trainingResults` from the client, so an owner can seed any
  // offset on their own run.
  const epochData = offsetEpochNumbers(derivedEpochs, trainingResults.epochOffset);

  const resolvedStartedAt = trainingResults.startedAt ?? derived.startedAt;

  // Flag anomalous completion: workflow succeeded but never had a start time or produced no epochs
  if (
    trainingStatus === TrainingStatus.InReview &&
    (!resolvedStartedAt || epochData.length === 0)
  ) {
    logToAxiom(
      {
        name: 'training-anomaly',
        type: 'warning',
        message: 'Training completed without starting or producing output',
        data: {
          workflowId: derived.workflowId,
          modelFileId,
          startedAt: resolvedStartedAt,
          epochCount: epochData.length,
          status,
          userId: model.user.id,
        },
      },
      'webhooks'
    ).catch();
  }

  const newTrainingResults: TrainingResultsV2 = {
    ...trainingResults,
    version: 2,
    workflowId: trainingResults.workflowId ?? derived.workflowId ?? 'unk',
    submittedAt: derived.submittedAt ?? new Date().toISOString(),
    startedAt: resolvedStartedAt,
    completedAt: derived.completedAt,
    epochs: epochData,
    // Preserved, not defaulted: writing 0 onto a run that predates the offset would mark it as
    // deliberately unshifted, so a later resubmit could no longer stamp one.
    epochOffset: trainingResults.epochOffset,
    history,
    sampleImagesPrompts: derived.sampleImagesPrompts,
    transactionData: derived.transactionData ?? trainingResults.transactionData ?? [],
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
  await preventModelVersionLag(model.id, modelVersion.id);
  await dataForModelsCache.refresh(model.id);

  return {
    trainingStatus,
    previousStatus,
    statusChanged,
    hasOutput: epochData.length > 0,
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

// =============================================================================
// Auto-label v2 (orchestrator workflows)
//
// These three functions replace the legacy zip → S3 → legacy job API pipeline.
// Everything runs through the v2 consumer endpoints with the system token — the
// work is billed to the system account so users pay nothing for tag/caption
// runs, and the workflow isn't visible under the user's own token.
// =============================================================================

type AutoLabelWorkflowMetadata = {
  kind: 'auto-label';
  userId: number;
  modelId: number;
  mediaType: 'image' | 'video' | 'audio';
  type: 'tag' | 'caption';
};

type AutoLabelStepMetadata = {
  filename: string;
};

// Block obvious SSRF without restricting which public host hosts the image.
// Captioning/tagging is supposed to work with any user-supplied image URL, so
// we don't gate on a host allowlist — but we DO want to refuse hostnames that
// resolve to private/loopback/link-local space, since the orchestrator runs
// inside our network and would happily fetch internal services if asked.
//
// 🔴 This used to carry its OWN `PRIVATE_HOST_PATTERNS` array, which had DRIFTED from the
// canonical list in `~/server/utils/ssrf-hostname` and was weaker than it. MEASURED against
// the old array — NINE shapes it ADMITTED that reach private/internal space and
// `isPublicHttpsUrl` refuses:
//   `https://[::ffff:127.0.0.1]/x`         IPv4-mapped IPv6 loopback
//   `https://[0:0:0:0:0:ffff:7f00:1]/x`    the same, spelled out uncompressed
//   `https://[::ffff:169.254.169.254]/x`   mapped cloud metadata
//   `https://[64:ff9b::a9fe:a9fe]/x`       NAT64 well-known prefix embedding 169.254.169.254
//   `https://[2002:7f00:1::]/x`            6to4 embedding 127.0.0.1
//   `https://[::]/x`                       unspecified address
//   `https://foo.internal/x`               internal TLD
//   `https://foo.local/x`                  mDNS TLD
//   `https://metadata.google.internal/x`   cloud metadata (subsumed by `.internal`)
// ⚠ AN EARLIER VERSION OF THIS COMMENT SAID "exactly FOUR", and the test pinned
// `toHaveLength(4)`. That was an incomplete enumeration presented as exhaustive: the first
// probe only tested the shapes its author thought of, so the five IPv6-embedding spellings
// were never fed to it. A count is a claim — if you extend this list, feed the candidate set
// to the differential rather than reasoning about it.
// ⚠ Precision about WHY the IPv6 ones are refused, because it is not the obvious reason:
// `[64:ff9b::…]`, `[2002:…]` and `[::]` fail `isPublicHttpsUrl`'s "hostname must be a public
// dotted name" test, NOT its NAT64/6to4 logic — that logic lives in `isPrivateIp`, the
// FETCH-TIME guard, which this lexical path never calls.
// ⚠ And the three shapes it is TEMPTING to list here — integer (`https://2130706433/x`),
// hex (`https://0x7f000001/x`) and octal (`https://0177.0.0.1/x`) IPv4 literals — were
// ALREADY refused, so do not "re-close" them or cite them as a reason for this change:
// WHATWG `new URL()` normalizes all three to hostname `127.0.0.1` BEFORE any denylist runs,
// so `/^127\./` matched them. A `%`-zone id (`https://[fe80::1%eth0]/x`) never parses at all.
// This is a reconciliation onto the existing source of truth, not a new guard — see
// `training-assert-safe-media-urls.test.ts`, which pins each of the NINE and was watched red
// against the old array — all nine rows plus the count row, re-measured after the correction
// rather than inherited from the first, wrong, four-row run.
//
// ⚠ Deliberate NARROWING that comes with it: `isPublicHttpsUrl` also refuses *public* bare
// IPv4/IPv6 literals and dot-less hostnames. A legitimate media URL is a DNS name, and the
// canonical helper makes the same call for App Blocks manifests, so the two now agree.
function assertSafeMediaUrls(urls: string[]) {
  for (const raw of urls) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw throwBadRequestError(`Invalid mediaUrl: ${raw.slice(0, 64)}`);
    }
    // 🔴 Userinfo is checked HERE, not inside `isPublicHttpsUrl`, and that is not an
    // oversight to "fix" by deleting this line: the canonical helper deliberately judges
    // host SHAPE only, and `safe-fetch.ts` likewise rejects userinfo as its own separate
    // control (control 1). `user:pass@` before a host is the openly-spelled version of the
    // WHATWG-vs-RFC3986 authority differential that `image-scan-url.ts` refuses.
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw throwBadRequestError('mediaUrl must be a plain HTTPS URL');
    }
    const lexical = isPublicHttpsUrl(raw);
    if (!lexical.ok) {
      throw throwBadRequestError('mediaUrl host is not reachable');
    }
  }
}

async function assertModelOwnership(modelId: number, userId: number) {
  const model = await dbRead.model.findUnique({
    where: { id: modelId },
    select: { id: true, userId: true, deletedAt: true, uploadType: true },
  });
  if (!model || model.deletedAt) throw throwNotFoundError('Model not found');
  if (model.userId !== userId) throw throwAuthorizationError('You do not own this model');
  // Auto-label is a training-only feature. Reject ownership of non-training models so a
  // logged-in user can't burn the system's orchestrator budget against any random model
  // they happen to own (an old checkpoint, etc.).
  if (model.uploadType !== 'Trained') {
    throw throwBadRequestError('Auto-labeling is only available for trained models');
  }
}

export function toOrchestratorError(error: unknown): never {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;
  const messages = handleError(error as Parameters<typeof handleError>[0]);
  switch (status) {
    case 400:
      throw throwBadRequestError(messages);
    case 401:
    case 403:
      throw throwAuthorizationError(messages);
    case 429:
      throw throwRateLimitError(messages);
    default:
      // A genuine upstream 5xx (orchestrator HTTP 500/502/503/504) OR a status-less
      // network/timeout failure (no HTTP status — the TCP/DNS/TLS layer failed
      // before any response) is a TRANSIENT dependency outage, NOT this app's own
      // fault. Mirror #2978's orchestrator submit-path fix: surface it as a
      // retry-able 503 SERVICE_UNAVAILABLE with the ORIGINAL error preserved as
      // `cause`, instead of a plain `Error` that tRPC wraps into a generic
      // INTERNAL_SERVER_ERROR (500) with an EMPTY cause chain. That masked-cause 500
      // is exactly what surfaced ~11×/2h on training.submitAutoLabelWorkflow: a
      // transient orchestrator brownout mis-counted against our 500 SLO AND
      // non-retryable to the client. `toOrchestratorError` is only reached on a
      // `!data` result from an orchestrator round-trip (getConsumerBlobUploadUrl /
      // clientSubmitWorkflow / clientGetWorkflow), so a local/logic bug thrown
      // BEFORE the call never reaches here — only real upstream failures do.
      if (status === undefined || status >= 500)
        throw throwServiceUnavailableError(messages ?? null, error);
      // Any OTHER unexpected non-5xx status is a real, non-transient anomaly — keep
      // it a hard error so a genuine bug is NOT silently masked as a retry-able 503.
      throw new Error(messages || 'Orchestrator request failed');
  }
}

export async function getAutoLabelUploadUrl({
  userId,
  modelId,
}: GetAutoLabelUploadUrlInput & { userId: number }) {
  await assertModelOwnership(modelId, userId);
  const { data, error } = await getConsumerBlobUploadUrl({
    client: internalOrchestratorClient,
  });
  if (!data) toOrchestratorError(error);
  return { uploadUrl: data.uploadUrl, expiresAt: data.expiresAt };
}

export async function submitAutoLabelWorkflow({
  userId,
  modelId,
  mediaType,
  images,
  params,
}: SubmitAutoLabelWorkflowInput & { userId: number }) {
  await assertModelOwnership(modelId, userId);
  assertSafeMediaUrls(images.map((i) => i.mediaUrl));

  const steps: WorkflowStepTemplate[] = images.map((img, index) => {
    const stepMetadata: AutoLabelStepMetadata = { filename: img.filename };

    if (params.type === 'caption') {
      // Audio captioning uses a dedicated orchestrator step type. Tag-style
      // labels aren't available for audio yet, so the upstream router only
      // forwards `caption` jobs when mediaType is 'audio'.
      if (mediaType === 'audio') {
        const step: AudioCaptioningStepTemplate = {
          $type: 'audioCaptioning',
          name: `${index}`,
          input: {
            mediaUrl: img.mediaUrl,
            temperature: params.temperature,
            maxNewTokens: params.maxNewTokens,
          },
          metadata: stepMetadata,
        };
        return step;
      }
      const step: MediaCaptioningStepTemplate = {
        $type: 'mediaCaptioning',
        name: `${index}`,
        input: {
          mediaUrl: img.mediaUrl,
          temperature: params.temperature,
          maxNewTokens: params.maxNewTokens,
        },
        metadata: stepMetadata,
      };
      return step;
    }

    const step: WdTaggingStepTemplate = {
      $type: 'wdTagging',
      name: `${index}`,
      input: {
        mediaUrl: img.mediaUrl,
        threshold: params.threshold,
      },
      metadata: stepMetadata,
    };
    return step;
  });

  const workflowMetadata: AutoLabelWorkflowMetadata = {
    kind: 'auto-label',
    userId,
    modelId,
    mediaType,
    type: params.type,
  };

  const { data, error } = await clientSubmitWorkflow({
    client: internalOrchestratorClient,
    body: {
      tags: ['civitai', 'training', 'auto-label'],
      metadata: workflowMetadata,
      steps,
      // System-paid: no user buzz currency required.
      currencies: [],
    },
    query: { wait: 0 },
  });

  if (!data) toOrchestratorError(error);
  if (!data.id) throw throwBadRequestError('Workflow submission returned no ID');

  return { workflowId: data.id, stepCount: steps.length };
}

export async function getAutoLabelWorkflow({
  userId,
  workflowId,
}: GetAutoLabelWorkflowInput & { userId: number }) {
  const { data, error } = await clientGetWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
  });
  if (!data) toOrchestratorError(error);

  const metadata = data.metadata as Partial<AutoLabelWorkflowMetadata> | undefined;
  if (!metadata || metadata.kind !== 'auto-label') {
    throw throwNotFoundError('Workflow not found');
  }
  if (metadata.userId !== userId) {
    // Don't leak existence — reuse the same error surface as missing.
    throw throwNotFoundError('Workflow not found');
  }

  return {
    workflowId: data.id ?? workflowId,
    status: data.status,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
    cost: data.cost,
    type: metadata.type,
    mediaType: metadata.mediaType,
    modelId: metadata.modelId,
    steps: (data.steps ?? []).map((step) => {
      const stepMeta = (step.metadata ?? {}) as Partial<AutoLabelStepMetadata>;
      // The base WorkflowStep type doesn't expose `output`, but each discriminated
      // step type (mediaCaptioning, wdTagging, audioCaptioning) does. Audio steps
      // nest the captioner output under `results.<filename>` (the key has varied
      // across service versions, so we just take the first entry) and use `text`
      // (full XML-tagged: CAPTION/LYRICS/DURATION/LANGUAGE) rather than `caption`.
      // Normalize so the client always sees `caption` in the output payload — for
      // audio, the full tagged `text` is what training expects.
      const stepWithOutput = step as typeof step & {
        $type?: string;
        output?: {
          caption?: string;
          tags?: { [tag: string]: number };
          text?: string | null;
          results?: Record<string, { text?: string | null; caption?: string | null } | undefined>;
        };
      };
      const rawOutput = stepWithOutput.output ?? null;
      let output: { caption?: string; tags?: { [tag: string]: number } } | null = rawOutput
        ? { caption: rawOutput.caption ?? undefined, tags: rawOutput.tags }
        : null;
      if (rawOutput && stepWithOutput.$type === 'audioCaptioning') {
        const firstResult = Object.values(rawOutput.results ?? {})[0];
        const text = firstResult?.text ?? rawOutput.text ?? null;
        output = { ...output, caption: text ?? undefined };
      }
      return {
        name: step.name,
        status: step.status,
        filename: stepMeta.filename ?? null,
        output,
      };
    }),
  };
}
