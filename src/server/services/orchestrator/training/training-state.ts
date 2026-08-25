import type { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import { pickBestTrainingFile } from '~/server/schema/model-file.schema';
import type {
  DerivedTrainingWorkflowState,
  TrainingWorkflowOverlay,
} from '~/server/services/orchestrator/training/workflow-state';
import type { TrainingWorkflowRef } from '~/server/services/orchestrator/training/workflow-state';
import {
  applyTrainingWorkflowOverlay,
  deriveTrainingWorkflowState,
  emptyTrainingOverlay,
  TRAINING_WORKFLOW_RETENTION_DAYS,
  TRAINING_WORKFLOW_TAG,
} from '~/server/services/orchestrator/training/workflow-state';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { getWorkflow, queryWorkflows } from '~/server/services/orchestrator/workflows';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import type { TrainingStatus } from '~/shared/utils/prisma/enums';

/**
 * Ceiling on workflows pulled per overlay. A row whose workflow falls outside this many
 * most-recent runs keeps its stored state rather than being dropped, so the cap costs
 * freshness, never rows — see `truncated` on the result.
 */
const OVERLAY_TAKE = 100;

/**
 * How many rows the bulk query missed we are willing to fetch one at a time. Only reachable when a
 * user has more runs in the window than `OVERLAY_TAKE`, so in practice this is zero calls; the cap
 * stops a deep page of a very heavy account from turning into 200 round-trips.
 */
const OVERLAY_BACKFILL_LIMIT = 25;

/**
 * Live state for the caller's training runs, straight from the orchestrator.
 *
 * Fails soft: the training list is a page users open to find out what happened, so an
 * orchestrator blip must degrade it to the stored copy rather than blank it. Every failure
 * returns an empty overlay.
 */
export async function getTrainingWorkflowOverlay({
  userId,
  ctx,
  refs = [],
}: {
  userId: number;
  ctx: { req: NextApiRequest; res: NextApiResponse };
  /** Rows on the page being rendered; any the bulk query misses are fetched individually. */
  refs?: TrainingWorkflowRef[];
}): Promise<TrainingWorkflowOverlay> {
  try {
    const token = await getOrchestratorToken(userId, ctx);
    const fromDate = new Date(Date.now() - TRAINING_WORKFLOW_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const { items } = await queryWorkflows({
      token,
      tags: [TRAINING_WORKFLOW_TAG],
      take: OVERLAY_TAKE,
      fromDate,
      // Parity with the stored copy this replaces: the write path records the workflow's blob
      // URLs unfiltered, so filtering here would blank sample images that the flag-off page
      // shows. Changing that is a browsing-level decision, not a state-freshness one.
      hideMatureContent: false,
    });

    const byModelFileId = new Map<number, DerivedTrainingWorkflowState>();
    for (const workflow of items) {
      if (!workflow.status) continue;
      try {
        const derived = deriveTrainingWorkflowState(workflow, workflow.status);
        byModelFileId.set(derived.modelFileId, derived);
      } catch {
        // A malformed or unsupported workflow is exactly the case the stored copy covers.
      }
    }

    // The bulk query returns the newest workflows, not the ones on this page, so a user with more
    // runs in the window than the cap can have page rows it never covered. Fetch those by id
    // rather than leaving their status on the stored copy — the point of the overlay is that the
    // status a user sees is the orchestrator's.
    const missed = refs.filter((ref) => !byModelFileId.has(ref.modelFileId));
    const backfill = missed.slice(0, OVERLAY_BACKFILL_LIMIT);
    if (backfill.length)
      await limitConcurrency(
        backfill.map((ref) => async () => {
          const derived = await deriveWorkflowById({ ...ref, token });
          if (derived) byModelFileId.set(derived.modelFileId, derived);
        }),
        5
      );

    const truncated = missed.length > backfill.length;
    if (truncated)
      logToAxiom(
        {
          name: 'training-overlay',
          type: 'warning',
          message: 'Overlay backfill capped; some rows kept stored state',
          data: { userId, missed: missed.length, backfilled: backfill.length },
        },
        'webhooks'
      ).catch();

    return { byModelFileId, truncated };
  } catch (error) {
    logToAxiom(
      {
        name: 'training-overlay',
        type: 'warning',
        message: 'Falling back to stored training state',
        data: { userId, error: (error as Error)?.message },
      },
      'webhooks'
    ).catch();
    return emptyTrainingOverlay();
  }
}

export type TrainingRunState = {
  /** Whether the returned state came from the live workflow or the stored copy. */
  source: 'orchestrator' | 'stored';
  trainingStatus: TrainingStatus | null;
  trainingResults: TrainingResultsV2 | null;
};

/**
 * Live state for ONE training run, for the epoch-selection screen.
 *
 * Fetched by workflow id rather than through the list query so it is exact — the list's cap and
 * page bounds do not apply, and a run the user opens is the one that gets read.
 */
export async function getTrainingRunState({
  modelVersionId,
  userId,
  isModerator,
  ctx,
}: {
  modelVersionId: number;
  userId: number;
  isModerator: boolean;
  ctx: { req: NextApiRequest; res: NextApiResponse };
}): Promise<TrainingRunState> {
  // Read through the WRITE connection: `ModelFile.metadata` is TOASTed jsonb, which the logical
  // subscriber drops on UPDATE, so on the replica `trainingResults` comes back empty and this
  // screen would show a finished run as having no epochs. Same reason as
  // `training.controller.getModelData`'s overlay.
  const version = await dbWrite.modelVersion.findFirst({
    where: { id: modelVersionId },
    select: {
      trainingStatus: true,
      meta: true,
      model: { select: { userId: true } },
      files: {
        where: { type: 'Training Data' },
        select: { id: true, type: true, metadata: true, sizeKB: true },
      },
    },
  });
  if (!version) throw throwNotFoundError(`No model version with id ${modelVersionId}`);
  if (version.model.userId !== userId && !isModerator) throw throwAuthorizationError();

  const file = pickBestTrainingFile(version.files);
  const stored = ((file?.metadata as FileMetadata | null)?.trainingResults ??
    null) as TrainingResultsV2 | null;

  const workflowId =
    stored?.workflowId ??
    // Written alongside the training results at submit. It lives on a small json column the
    // TOAST-dropping replication bug cannot reach, so it is the one handle that survives a run
    // whose stored results came back empty — which is exactly when this screen needs the
    // orchestrator most.
    ((version.meta as { trainingWorkflowId?: string } | null)?.trainingWorkflowId || undefined);

  if (!file || !workflowId)
    return { source: 'stored', trainingStatus: version.trainingStatus, trainingResults: stored };

  const overlay = await getTrainingWorkflowOverlayById({ workflowId, userId, ctx });
  if (overlay.byModelFileId.size === 0)
    return { source: 'stored', trainingStatus: version.trainingStatus, trainingResults: stored };

  const merged = applyTrainingWorkflowOverlay(
    { trainingStatus: version.trainingStatus, files: [{ id: file.id, metadata: file.metadata }] },
    overlay
  );

  return {
    source: 'orchestrator',
    trainingStatus: merged.trainingStatus,
    trainingResults:
      ((merged.files[0].metadata as FileMetadata | null)?.trainingResults as TrainingResultsV2) ??
      stored,
  };
}

/** One workflow, derived, or null if it cannot be read — past retention, malformed, or upstream down. */
async function deriveWorkflowById({
  workflowId,
  token,
}: {
  workflowId: string;
  token: string;
}): Promise<DerivedTrainingWorkflowState | null> {
  try {
    const workflow = await getWorkflow({ token, path: { workflowId } });
    if (!workflow.status) return null;
    return deriveTrainingWorkflowState(workflow, workflow.status);
  } catch {
    return null;
  }
}

/** Single-workflow sibling of `getTrainingWorkflowOverlay`, with the same fail-soft contract. */
async function getTrainingWorkflowOverlayById({
  workflowId,
  userId,
  ctx,
}: {
  workflowId: string;
  userId: number;
  ctx: { req: NextApiRequest; res: NextApiResponse };
}): Promise<TrainingWorkflowOverlay> {
  try {
    const token = await getOrchestratorToken(userId, ctx);
    const workflow = await getWorkflow({ token, path: { workflowId } });
    if (!workflow.status) return emptyTrainingOverlay();

    const derived = deriveTrainingWorkflowState(workflow, workflow.status);
    return { byModelFileId: new Map([[derived.modelFileId, derived]]), truncated: false };
  } catch (error) {
    // Past retention this is a 404 and the stored copy is all that is left of the run, so a
    // failure here is an expected outcome rather than an error.
    logToAxiom(
      {
        name: 'training-overlay',
        type: 'warning',
        message: 'Falling back to stored training state for a single run',
        data: { userId, workflowId, error: (error as Error)?.message },
      },
      'webhooks'
    ).catch();
    return emptyTrainingOverlay();
  }
}
