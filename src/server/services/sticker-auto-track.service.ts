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
import { throwRateLimited } from '~/server/utils/rate-limit-error';
import { usageLimitMessage } from '~/shared/constants/usage-limits';
import type { SessionUser } from '~/types/session';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { stickerMaxScale } from '~/shared/utils/sticker-placement';
import type { StickerTrackV1 } from '~/shared/utils/sticker-track';
import type { AutoTrackMetadata, StickerAutoTrackPose } from '~/server/utils/sticker-auto-track';
import {
  buildStickerAutoTrackWorkflow,
  parseStickerAutoTrack,
  readStickerAutoTrackWorkflow,
  stickerAutoTrackDailyLimit,
  takeStickerAutoTrackRun,
  stickerAutoTrackVideoAir,
  stickerAutoTrackWindow,
} from '~/server/utils/sticker-auto-track';

const DAY_SECONDS = 24 * 60 * 60;
const DOWNLOAD_TIMEOUT_MS = 30_000;

async function stickerSpaceFor(imageId: number, userId: number) {
  const space = await resolvePlacementSpaceFor({
    surface: 'sticker',
    targetType: 'image',
    targetId: imageId,
  });
  // Mirrors createStickerPlacement's refusals, so a run is never spent on a sticker that could not be placed.
  if (space.mode === 'off')
    throw throwBadRequestError('placement: this creator is not accepting stickers here');
  if (space.ownerId === userId)
    throw throwBadRequestError('placement: you cannot place a sticker on your own content');
  if (space.mediaType !== 'video')
    throw throwBadRequestError('placement: auto-track only works on a video');
  await assertCanPlace({ ownerId: space.ownerId, placerId: userId });
  return space;
}

async function takeDailyRun(user: SessionUser) {
  const resolved = await resolveUsageLimit('stickers.auto-track-daily', user);
  // Never read `resolved.applies` here; see stickerAutoTrackDailyLimit.
  const limit = stickerAutoTrackDailyLimit(resolved, user.isModerator);
  const now = Date.now();
  const run = await takeStickerAutoTrackRun(redis, { userId: user.id, limit, now });
  if (run.ok) return run.giveBack;
  const resetAt = run.resetAt.toISOString();
  throwRateLimited(
    {
      retryAfterSeconds: Math.max(1, Math.ceil((run.resetAt.getTime() - now) / 1000)),
      retryAt: resetAt,
      id: 'stickers.auto-track-daily',
      kind: 'product',
      limit,
      used: run.used,
      remaining: 0,
      windowSeconds: DAY_SECONDS,
      resetAt,
    },
    usageLimitMessage(resolved.def, resolved) ?? 'Daily auto-track limit reached.'
  );
}

export async function startStickerAutoTrack({
  user,
  imageId,
  pose,
  startMs,
}: {
  user: SessionUser;
  imageId: number;
  pose: StickerAutoTrackPose;
  startMs: number;
}) {
  const userId = user.id;
  await stickerSpaceFor(imageId, userId);
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { url: true, metadata: true },
  });
  if (!image) throw throwNotFoundError('placement: image not found');
  const durationSeconds = (image.metadata as { duration?: number } | null)?.duration;
  const maxMs = stickerAutoTrackWindow(startMs, durationSeconds);
  if (maxMs === null)
    throw throwBadRequestError('placement: auto-track has to start before the video ends');

  const giveBack = await takeDailyRun(user);
  const metadata: AutoTrackMetadata = { stickerAutoTrack: { userId, imageId, startMs } };
  const { data, response } = await submitWorkflowWithRetry({
    client: internalOrchestratorClient,
    body: {
      externalId: randomUUID(),
      metadata,
      tags: ['sticker-track'],
      currencies: [],
      steps: [
        buildStickerAutoTrackWorkflow({
          videoAir: stickerAutoTrackVideoAir(image.url),
          pose,
          startMs,
          maxMs,
        }),
      ],
    },
  });
  if (!data?.id) {
    // The run comes back only when the orchestrator answered and refused it. A thrown submit
    // (a timeout, say) may still have created a job, so it keeps the count.
    if (response && response.status >= 400 && response.status < 500)
      await giveBack?.().catch(() => undefined);
    throw new Error(`sticker auto-track submit failed (${response?.status ?? 'no response'})`);
  }
  return { workflowId: data.id, startMs, maxMs };
}

export type StickerAutoTrackResult =
  | { status: 'running' }
  | { status: 'failed' }
  | { status: 'succeeded'; track: StickerTrackV1; startMs: number };

/** Tick 0 is the placer's pose at `startMs`, not at video time 0. */
export async function getStickerAutoTrack({
  userId,
  workflowId,
}: {
  userId: number;
  workflowId: string;
}): Promise<StickerAutoTrackResult> {
  const { data, error, response: readResponse } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
  });
  // A failed read is not a missing run: the client keeps polling a job it already spent a run on.
  if (!data && error && readResponse?.status !== 404) return { status: 'running' };
  const read = readStickerAutoTrackWorkflow(data, userId);
  if (read.status === 'running' || read.status === 'failed') return { status: read.status };
  if (read.status !== 'download') throw throwNotFoundError('placement: auto-track run not found');

  // The signed URL answers 301 to the file; fetch follows it.
  const response = await outboundFetch(read.url, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (!response.ok) return { status: 'failed' };
  const space = await stickerSpaceFor(read.imageId, userId);
  const track = parseStickerAutoTrack(
    await response.json().catch(() => null),
    stickerMaxScale(space.settings)
  );
  return track ? { status: 'succeeded', track, startMs: read.startMs } : { status: 'failed' };
}
