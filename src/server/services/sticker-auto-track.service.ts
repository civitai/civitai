import { getWorkflow } from '@civitai/orchestration-client';
import { randomUUID } from 'crypto';
import { dbRead } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { submitWorkflowWithRetry } from '~/server/services/orchestrator/workflows';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import { resolveUsageLimit } from '~/server/services/usage-limit-config.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { usageLimitMessage } from '~/shared/constants/usage-limits';
import type { SessionUser } from '~/types/session';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { logToAxiom } from '~/server/logging/client';
import { stickerMaxScale } from '~/shared/utils/sticker-placement';
import type {
  StickerAutoTrackPose,
  StickerAutoTrackResult,
} from '~/server/utils/sticker-auto-track';
import { pollAutoTrack, startAutoTrack } from '~/server/utils/sticker-auto-track';

const DOWNLOAD_TIMEOUT_MS = 30_000;

/** The refusals createStickerPlacement makes up front, checked before a run is counted. */
async function assertAutoTrackPlaceable(imageId: number, userId: number) {
  const space = await resolvePlacementSpaceFor({
    surface: 'sticker',
    targetType: 'image',
    targetId: imageId,
  });
  if (space.mode === 'off')
    throw throwBadRequestError('placement: this creator is not accepting stickers here');
  if (space.ownerId === userId)
    throw throwBadRequestError('placement: you cannot place a sticker on your own content');
  if (space.mediaType !== 'video')
    throw throwBadRequestError('placement: auto-track only works on a video');
  await assertCanPlace({ ownerId: space.ownerId, placerId: userId });
}

export async function startStickerAutoTrack(input: {
  user: SessionUser;
  imageId: number;
  pose: StickerAutoTrackPose;
  startMs: number;
}) {
  const { user, imageId } = input;
  const resolveLimit = () => resolveUsageLimit('stickers.auto-track-daily', user);
  let resolved: Awaited<ReturnType<typeof resolveLimit>> | undefined;
  return startAutoTrack(
    {
      checkSpace: () => assertAutoTrackPlaceable(imageId, user.id),
      loadVideo: async () => {
        const image = await dbRead.image.findUnique({
          where: { id: imageId },
          select: { url: true, metadata: true, width: true, height: true },
        });
        if (!image) return null;
        const durationSeconds = (image.metadata as { duration?: number } | null)?.duration;
        return { url: image.url, durationSeconds, width: image.width, height: image.height };
      },
      resolveLimit: async () => (resolved = await resolveLimit()),
      limitMessage: (limit) =>
        resolved ? usageLimitMessage(resolved.def, { ...resolved, limit }) : undefined,
      store: redis,
      submit: async ({ metadata, steps }) => {
        const { data, response } = await submitWorkflowWithRetry({
          client: internalOrchestratorClient,
          body: {
            externalId: randomUUID(),
            metadata,
            tags: ['sticker-track'],
            currencies: [],
            // System-account workflows default to the Normal download lane, slow for the tracker's
            // models. The orchestrator doesn't charge the boost to user 0. `tier: 'free'` would force Low.
            downloadPriority: 'high',
            steps,
          },
        });
        return { id: data?.id, status: response?.status };
      },
      now: Date.now,
    },
    input
  );
}

export type StickerAutoTrackPoll =
  | Exclude<StickerAutoTrackResult, { status: 'failed' | 'missing' }>
  | { status: 'failed' };

export async function getStickerAutoTrack({
  userId,
  workflowId,
}: {
  userId: number;
  workflowId: string;
}): Promise<StickerAutoTrackPoll> {
  const result = await pollAutoTrack(
    {
      read: async () => {
        const { data, error, response } = await getWorkflow({
          client: internalOrchestratorClient,
          path: { workflowId },
        });
        return { data, error, status: response?.status };
      },
      // The signed URL answers 301 to the file; fetch follows it.
      download: (url) => outboundFetch(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS }),
      // Only the creator's size limit: a space turned off after submit fails at placing, not here.
      maxScale: async (imageId) =>
        stickerMaxScale(
          (
            await resolvePlacementSpaceFor({
              surface: 'sticker',
              targetType: 'image',
              targetId: imageId,
            })
          ).settings
        ),
    },
    userId
  );
  if (result.status === 'missing') throw throwNotFoundError('placement: auto-track run not found');
  if (result.status === 'failed') {
    // The client gets no detail, so this log is where the run and its failure reason live.
    logToAxiom({
      name: 'sticker-auto-track',
      type: 'warning',
      message: 'auto-track run gave no track',
      workflowId,
      userId,
      reason: result.reason,
      payload: { runStatus: result.reason === 'run' ? result.runStatus : undefined },
    });
    return { status: 'failed' };
  }
  return result;
}
