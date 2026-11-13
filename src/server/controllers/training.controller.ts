import type { WorkflowStatus } from '@civitai/orchestration-client';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import type { Context } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import { getModel } from '~/server/services/model.service';
import {
  trainingDataOwnerView,
  withoutEpochUrls,
} from '~/server/services/training-data-restricted.service';
import { isModelDeletedOrTakenDown } from '~/server/utils/model-withheld';
import { trackModActivity } from '~/server/services/moderator.service';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import {
  throwBadRequestError,
  throwDbError,
  throwInternalServerError,
  throwNotFoundError,
  throwRateLimitError,
} from '~/server/utils/errorHandling';
import { outboundFetch } from '~/server/utils/fetch-timeout';

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

export const getModelData = async ({ input, ctx }: { input: GetByIdInput; ctx: Context }) => {
  try {
    const model = await getModel({
      id: input.id,
      select: {
        id: true,
        userId: true,
        name: true,
        status: true,
        mode: true,
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
    // The training wizard is the owner's; its dataset files carry their storage urls, so only the
    // owner and moderators may read it. `userId` is used for that check and dropped from the
    // response — adding it to the returned shape would change the public query type.
    if (!model || (!ctx.user?.isModerator && ctx.user?.id !== model.userId))
      throw throwNotFoundError(`No model with id ${input.id}`);
    const { userId: _ownerId, mode: _mode, ...modelData } = model;

    // TODO(replica-toast): overlay is a workaround — the data-packet logical subscriber drops
    // TOASTed jsonb on UPDATE, leaving trainingResults empty. Remove once replication is fixed.
    const fileIds = modelData.modelVersions.flatMap((v) => v.files.map((f) => f.id));
    if (fileIds.length) {
      const fresh = await dbWrite.modelFile.findMany({
        where: { id: { in: fileIds } },
        select: { id: true, metadata: true },
      });
      const metaById = new Map(fresh.map((f) => [f.id, f.metadata]));
      for (const version of modelData.modelVersions) {
        for (const file of version.files) {
          const m = metaById.get(file.id);
          if (m !== undefined) file.metadata = m;
        }
      }
    }

    if (ctx.user?.isModerator) return modelData;
    const withheld = isModelDeletedOrTakenDown(model);
    return {
      ...modelData,
      modelVersions: modelData.modelVersions.map((v) => ({
        ...v,
        files: withheld
          ? withoutEpochUrls(trainingDataOwnerView(v.files))
          : trainingDataOwnerView(v.files),
      })),
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/**
 * The training file whose run is still AWAITING a gate.
 *
 * Deliberately not `pickBestTrainingFile`: that scores a run UP for completion markers (+2 epochs,
 * +1 `completedAt`), which is right for "show me this version's dataset" and exactly backwards here —
 * a run waiting on a gate is by construction the least complete one. On a version carrying two runs it
 * would hand back the finished one and gate the wrong workflow.
 */
function pickGatedTrainingFile<T extends { metadata: unknown }>(files: T[]): T | undefined {
  const pending = files.filter((file) => {
    const tr = ((file.metadata ?? {}) as FileMetadata).trainingResults as
      | TrainingResultsV2
      | undefined;
    return !!tr?.workflowId && !tr?.completedAt;
  });
  // Oldest-first among the pending ones, and the plain first row when nothing looks pending.
  return pending[0] ?? files[0];
}

const getWorkflowFromVersion = async (modelVersionId: number) => {
  const modelFiles = await dbWrite.modelFile.findMany({
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
  const modelFile = pickGatedTrainingFile(modelFiles);
  if (!modelFile) {
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

  if (!workflow) throw new Error(`Could not find workflow with id: ${workflowId}`);

  // `workflowId` comes out of ModelFile.metadata, which the model's OWNER can write
  // (modelFile.update -> modelFileMetadataSchema.trainingResults). Left unchecked it is the whole of
  // the addressing for a privileged gate release, so an owner could point the file a moderator is
  // reviewing at a different run and have the ruling land there. The tag is written by us at submit
  // time (training.orch.ts) and the reviewed user cannot set it, so it — not the metadata — is what
  // says which version this workflow belongs to. Keep it even though modelFile writes now drop
  // client trainingResults: files saved before that still carry whatever metadata they were given.
  if (!workflow.tags?.includes(`modelVersion:${modelVersionId}`)) {
    logWebhook({
      message: 'Workflow does not belong to this model version; refusing to touch its gate',
      data: { modelVersionId, workflowId, important: true },
    });
    throw throwBadRequestError('Workflow does not belong to this model version');
  }

  return { workflowId, status: workflow.status };
};

const moderateTrainingData = async ({
  modelVersionId,
  approve,
  workflowId,
  status,
  moderatorId,
}: {
  modelVersionId: number;
  approve: boolean;
  workflowId: string;
  status?: WorkflowStatus;
  moderatorId: number;
}) => {
  if (!env.ORCHESTRATOR_ENDPOINT) throw throwInternalServerError('No orchestrator endpoint');

  try {
    const response = await outboundFetch(
      `${env.ORCHESTRATOR_ENDPOINT}/v1/manager/workflows/${encodeURIComponent(
        workflowId
      )}/moderation-gate`,
      {
        timeoutMs: 30_000,
        method: 'POST',
        body: JSON.stringify({ approved: approve }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
        },
      }
    );

    if (response.ok) {
      // Past this point the gate is released, so nothing below may throw: throwing would report a
      // resolved gate as a failed deny and invite the caller to repeat it. The callback out of our
      // own database is the half that can still fail, and `webhookFailed` is how the caller hears.
      let webhookFailed = false;

      // Same row the moderator app writes for a ruling there.
      try {
        await trackModActivity(moderatorId, {
          entityType: 'modelVersion',
          entityId: modelVersionId,
          activity: approve ? 'trainingData:approve' : 'trainingData:deny',
        });
      } catch (e) {
        logWebhook({
          message: 'Gate released but the moderator activity was not recorded',
          data: { modelVersionId, workflowId, important: true, error: (e as Error)?.message },
        });
      }

      if (!status) {
        webhookFailed = true;
        logWebhook({
          message: 'Gate released but the workflow reported no status; version is still Paused',
          data: { modelVersionId, workflowId, important: true },
        });
      } else {
        // The orchestrator does not reliably fire this itself, and without it an approved or denied
        // run stays Paused in our database. A thrown fetch is the same half-done state as a refusal.
        const hook = await outboundFetch(
          `https://api.civitai.com/webhooks/resource-training-v2/${modelVersionId}?token=${env.WEBHOOK_TOKEN}`,
          {
            // Our own webhook handler; generous so a slow but successful run is not reported failed.
            timeoutMs: 120_000,
            method: 'POST',
            body: JSON.stringify({ workflowId, status }),
            headers: {
              'Content-Type': 'application/json',
            },
          }
        ).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
        if (hook instanceof Error || !hook.ok) {
          webhookFailed = true;
          logWebhook({
            message: 'Gate released but the training webhook was refused; version is still Paused',
            data: {
              modelVersionId,
              workflowId,
              important: true,
              ...(hook instanceof Error ? { error: hook.message } : { status: hook.status }),
            },
          });
        }
      }

      logWebhook({
        message: `${approve ? 'Approved' : 'Denied'} training dataset`,
        type: 'info',
        data: { modelVersionId },
      });
      return { ok: true as const, webhookFailed };
    } else {
      logWebhook({
        message: 'Could not connect to orchestrator',
        data: {
          modelVersionId,
          important: true,
          status: response.status,
          workflowId,
        },
      });

      if (response.status === 429) {
        throw throwRateLimitError('Could not connect to orchestrator');
      } else {
        throw throwBadRequestError('Could not connect to orchestrator');
      }
    }
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

export async function handleDenyTrainingData({
  input,
  moderatorId,
}: {
  input: GetByIdInput;
  moderatorId: number;
}) {
  const modelVersionId = input.id;
  const { workflowId, status } = await getWorkflowFromVersion(modelVersionId);
  return await moderateTrainingData({
    modelVersionId,
    workflowId,
    status,
    approve: false,
    moderatorId,
  });
}
