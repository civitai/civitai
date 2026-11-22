import { stickerTrackSchema } from '~/server/schema/placement.schema';
import type { WorkflowStepTemplate } from '@civitai/orchestration-client';
import type { redis } from '~/server/redis/client';
import { REDIS_KEYS } from '~/server/redis/client';
import {
  type StickerTrackV1,
  encodeStickerTrack,
  sampleStickerTrack,
  lerpDegrees,
  STICKER_TRACK_MAX_DURATION_MS,
  STICKER_TRACK_MIN_MS,
} from '~/shared/utils/sticker-track';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { throwRateLimited } from '~/server/utils/rate-limit-error';

// The civitai-sticker-track node pack (our fork of rmatif/comfyui-sticker-track) follows the
// subject under a sticker and returns a v1 track.
// Pin every AIR. COMFY_IMAGE and NODE_PACK_LAYER must change together: the layer's AIR embeds
// the image's and only runs on that image.
const COMFY_IMAGE = 'urn:air:oci:image:ghcr:civitai/civitai-spine-comfy@v2.7.60';
const NODE_PACK_LAYER =
  'urn:air:comfy:nodepacklayer:comfyregistry:civitai/civitai-sticker-track@1.2.0+75726e3a6169723a6f63693a696d6167653a676863723a636976697461692f636976697461692d7370696e652d636f6d66794076322e372e3630';
const SAM_CHECKPOINT =
  'urn:air:other:checkpoint:huggingface:Comfy-Org/sam3.1@7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors';
const TAPNEXT_CHECKPOINT =
  'urn:air:other:checkpoint:huggingface:google/tapnet@5d3fb48e76c5422841e38501514121e251beabb7/tapnextpp_ckpt.pt';

/** The worker holds every decoded frame in memory, so one run covers at most this much video. */
export const STICKER_AUTO_TRACK_MAX_MS = 60_000;
const TERMINAL_FAILURES = new Set(['failed', 'expired', 'canceled']);

export type AutoTrackMetadata = {
  stickerAutoTrack: { userId: number; imageId: number; startMs: number };
};

/** Null when `startMs` is at or past the end. */
export function stickerAutoTrackWindow(startMs: number, durationSeconds?: number) {
  if (!durationSeconds) return STICKER_AUTO_TRACK_MAX_MS;
  const remaining = Math.round(durationSeconds * 1000) - startMs;
  return remaining > 0 ? Math.min(STICKER_AUTO_TRACK_MAX_MS, remaining) : null;
}

/** The tracker can size a sticker past the creator's max scale; clamp it. */
export function clampStickerTrackScale(track: StickerTrackV1, maxScale: number): StickerTrackV1 {
  return { ...track, s: track.s.map(([tick, s]) => [tick, Math.min(s, maxScale)]) };
}

type WorkflowRead =
  | { status: 'missing' | 'running' | 'failed' }
  | { status: 'download'; url: string; imageId: number; startMs: number };

type AutoTrackWorkflow = {
  status?: string | null;
  metadata?: unknown;
  steps?: unknown[] | null;
};

export function readStickerAutoTrackWorkflow(
  workflow: AutoTrackWorkflow | undefined,
  userId: number
): WorkflowRead {
  const meta = (workflow?.metadata as Partial<AutoTrackMetadata> | undefined)?.stickerAutoTrack;
  // Every run sits on one system account, so the metadata is what says whose run it is.
  if (!workflow || !meta || meta.userId !== userId) return { status: 'missing' };

  const status = workflow.status ?? 'unassigned';
  if (TERMINAL_FAILURES.has(status)) return { status: 'failed' };
  if (status !== 'succeeded') return { status: 'running' };

  const step = (workflow.steps ?? [])[0] as
    | { output?: { blobs?: { id?: string; url?: string | null; available?: boolean }[] } }
    | undefined;
  const blob = step?.output?.blobs?.find((b) => b.id?.endsWith('.json'));
  // A run can report success with its file missing.
  if (!blob?.url || blob.available === false) return { status: 'failed' };
  return { status: 'download', url: blob.url, imageId: meta.imageId, startMs: meta.startMs };
}

/** Null when the file is not a track the player would accept. */
export function parseStickerAutoTrack(body: unknown, maxScale: number): StickerTrackV1 | null {
  const parsed = stickerTrackSchema.safeParse(body);
  if (!parsed.success || parsed.data.v !== 1) return null;
  return clampStickerTrackScale(despikeStickerTrack(parsed.data), maxScale);
}

/**
 * The track with size spikes smoothed out. A head mask that briefly takes in the shoulders makes
 * the sticker jump to several times its size for a tick or two. Inside each shown run, such ticks
 * are redrawn from the good ticks either side, in every channel. A real size step at a cut or a
 * fast zoom stays, and so does a spike on a run's first or last tick, which has no line to sit off.
 */
export function despikeStickerTrack(track: StickerTrackV1, ratio = 1.3): StickerTrackV1 {
  const channels = [track.x, track.y, track.s, track.r, ...(track.show ? [track.show] : [])];
  if (channels.some((c) => c.length === 0)) return track;
  const n = Math.max(...channels.map((c) => c[c.length - 1][0])) + 1;
  // A tick past the longest video the player accepts is a broken file, not one to sample tick by tick.
  if (!(n <= STICKER_TRACK_MAX_DURATION_MS / Math.max(track.ms, STICKER_TRACK_MIN_MS) + 1))
    return track;
  const poses = Array.from({ length: n }, (_, k) => sampleStickerTrack(track, k * track.ms));
  const limit = Math.log(ratio);
  let changed = false;
  for (let start = 0; start < n; ) {
    if (!poses[start].show) {
      start++;
      continue;
    }
    let end = start;
    while (end < n && poses[end].show) end++;
    const logs = poses.slice(start, end).map((p) => Math.log(p.scale));
    const spike = new Array<boolean>(end - start).fill(false);
    // Up to three ticks above both neighbours, or below both, by more than `ratio`. A step at a cut
    // or a ramp in a zoom stays: no tick of it clears both sides.
    for (let a = 0; a < logs.length; a++)
      for (let b = a + 2; b <= a + 4 && b < logs.length; b++) {
        const inner = logs.slice(a + 1, b);
        const high = Math.max(logs[a], logs[b]) + limit;
        const low = Math.min(logs[a], logs[b]) - limit;
        if (inner.every((v) => v > high) || inner.every((v) => v < low))
          for (let i = a + 1; i < b; i++) spike[i] = true;
      }
    // Keep a >= 0 and b < logs.length above: the walks below rely on a run's ends never being spikes.
    for (let i = start; i < end; i++) {
      if (!spike[i - start]) continue;
      changed = true;
      let before = i - 1;
      while (spike[before - start]) before--;
      let after = i + 1;
      while (spike[after - start]) after++;
      const from = poses[before];
      const to = poses[after];
      const f = (i - before) / (after - before);
      poses[i] = {
        ...poses[i],
        x: from.x + (to.x - from.x) * f,
        y: from.y + (to.y - from.y) * f,
        scale: from.scale + (to.scale - from.scale) * f,
        rotation: lerpDegrees(from.rotation, to.rotation, f),
      };
    }
    start = end;
  }
  return changed ? encodeStickerTrack(poses, track.ms) : track;
}

export type StickerAutoTrackPose = { x: number; y: number; scale: number; rotation: number };

export function stickerAutoTrackVideoAir(mediaId: string) {
  return `urn:air:other:other:civitai-media-cache:${mediaId}@original=true/${mediaId}.mp4`;
}

export function buildStickerAutoTrackWorkflow({
  videoAir,
  pose,
  startMs,
  maxMs,
  frame,
}: {
  videoAir: string;
  pose: StickerAutoTrackPose;
  startMs: number;
  maxMs: number;
  /** The video's own size. Without it a sticker on something other than a head cannot track. */
  frame?: { width: number; height: number };
}) {
  // A JSON string inside the graph, not a nested object: the node parses it.
  const placement = JSON.stringify(pose);
  // The point under the sticker, in pixels of the frame StickerLoadVideo returns (max_side 1024).
  const fit = frame ? Math.min(1, 1024 / Math.max(frame.width, frame.height)) : 0;
  // A sticker on the right or bottom edge still lands on the last pixel, not one past it.
  const pixel = (fraction: number, side: number) => {
    const size = Math.round(side * fit);
    return Math.min(size - 1, Math.round(fraction * size));
  };
  const underSticker = frame
    ? JSON.stringify([{ x: pixel(pose.x, frame.width), y: pixel(pose.y, frame.height) }])
    : null;
  const fallback = underSticker
    ? {
        '12': {
          class_type: 'SAM3_Detect',
          inputs: {
            model: ['2', 0],
            image: ['4', 0],
            positive_coords: underSticker,
            threshold: 0.4,
            refine_iterations: 2,
            individual_masks: true,
          },
        },
      }
    : {};
  return {
    $type: 'customComfy',
    input: {
      comfyImage: COMFY_IMAGE,
      resources: [NODE_PACK_LAYER, videoAir, SAM_CHECKPOINT, TAPNEXT_CHECKPOINT],
      workflow: {
        '1': {
          class_type: 'StickerLoadVideo',
          inputs: { video: videoAir, fps: 8.0, max_side: 1024, start_ms: startMs, max_ms: maxMs },
        },
        '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: SAM_CHECKPOINT } },
        // "head:16" lets SAM return up to 16 heads on the first frame, so the one under the
        // sticker can be picked on a clip with several characters.
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'head:16', clip: ['2', 1] } },
        '4': {
          class_type: 'ImageFromBatch',
          inputs: { image: ['1', 0], batch_index: 0, length: 1 },
        },
        '5': {
          class_type: 'SAM3_Detect',
          inputs: {
            model: ['2', 0],
            image: ['4', 0],
            conditioning: ['3', 0],
            threshold: 0.4,
            refine_iterations: 2,
            individual_masks: true,
          },
        },
        '6': {
          class_type: 'StickerAnchorPick',
          inputs: {
            masks: ['5', 0],
            ...(underSticker ? { fallback_masks: ['12', 0] } : {}),
            placement,
          },
        },
        '7': {
          class_type: 'SAM3_VideoTrack',
          inputs: {
            images: ['1', 0],
            model: ['2', 0],
            initial_mask: ['6', 0],
            conditioning: ['3', 0],
            detection_threshold: 0.5,
            // 16 slots fill with every head seen across a few cuts, and then nothing is left to
            // find the subject again.
            max_objects: 64,
            detect_interval: 2,
          },
        },
        '8': {
          class_type: 'TAPNextLoader',
          inputs: { ckpt_name: TAPNEXT_CHECKPOINT, resolution: 256 },
        },
        '9': {
          class_type: 'StickerTrack',
          inputs: {
            images: ['1', 0],
            track_data: ['7', 0],
            sam3: ['2', 0],
            tapnext: ['8', 0],
            placement,
            fps: ['1', 1],
            tick_ms: 250,
            points_per_side: 16,
            cut_threshold: 30.0,
            reid_threshold: 0.4,
            // Off when no head holds the sticker, so after a cut it hides instead of jumping onto a person.
            reid: ['6', 1],
            // A sticker placed on an eye hides while that eye is turned away, not on the cheek.
            hide_when_eye_lost: true,
            eyes: ['11', 0],
          },
        },
        '10': {
          class_type: 'SaveText',
          inputs: { text: ['9', 0], filename_prefix: 'sticker_track', format: 'json' },
        },
        '11': { class_type: 'CLIPTextEncode', inputs: { text: 'eye:4', clip: ['2', 1] } },
        ...fallback,
      },
    },
  } as unknown as WorkflowStepTemplate;
}

/** One counter per placer per UTC day, read back by the account Limits page. */
export function stickerAutoTrackRunsKey(userId: number, dayStart: Date) {
  return `${REDIS_KEYS.STICKER_AUTO_TRACK.DAILY_RUNS}:${userId}:${dayStart
    .toISOString()
    .slice(0, 10)}` as const;
}

type RunCounter = Pick<typeof redis, 'incrBy' | 'decrBy' | 'expire'>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Not claimRateLimitAttempt: that is a rolling window, and the Limits page reads this UTC-day count
 * by key. A store error throws, so nothing is submitted.
 */
export async function takeStickerAutoTrackRun(
  store: RunCounter,
  { userId, limit, now }: { userId: number; limit: number; now: number }
) {
  const start = new Date(Math.floor(now / DAY_MS) * DAY_MS);
  const resetAt = new Date(start.getTime() + DAY_MS);
  const key = stickerAutoTrackRunsKey(userId, start);
  const used = await store.incrBy(key, 1);
  if (used === 1) await store.expire(key, 2 * (DAY_MS / 1000));
  if (used > limit) {
    await store.decrBy(key, 1);
    return { ok: false as const, used: used - 1, resetAt };
  }
  return { ok: true as const, giveBack: () => store.decrBy(key, 1) };
}

/**
 * Only an answered refusal hands the run back: a thrown or 5xx submit may still have created a job.
 */
export function autoTrackSubmitGivesBack(status: number | undefined) {
  return status !== undefined && status >= 400 && status < 500;
}

/** Only a 404 means no such run: any other failed read keeps polling a job a run was spent on. */
export function autoTrackReadIsMissing(status: number | undefined) {
  return status === 404;
}

type GiveBack = () => Promise<unknown>;

/**
 * Submit can only run after a run is counted, so no order of the callers' checks spends system
 * Buzz uncounted. The run comes back only on an answered refusal.
 */
export async function submitCountedAutoTrack({
  takeRun,
  submit,
}: {
  takeRun: () => Promise<GiveBack | undefined>;
  submit: () => Promise<{ id?: string | null; status?: number }>;
}) {
  const giveBack = await takeRun();
  const { id, status } = await submit();
  if (id) return id;
  if (autoTrackSubmitGivesBack(status)) await giveBack?.().catch(() => undefined);
  throw new Error(`sticker auto-track submit failed (${status ?? 'no response'})`);
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * The start path end to end, with its I/O passed in. Every refusal runs before the run is counted,
 * and submit only through submitCountedAutoTrack.
 */
export async function startAutoTrack(
  deps: {
    checkSpace: () => Promise<unknown>;
    loadVideo: () => Promise<{
      url: string;
      durationSeconds?: number;
      width?: number | null;
      height?: number | null;
    } | null>;
    resolveLimit: () => Promise<{ limit: number; applies: boolean }>;
    limitMessage: (limit: number) => string | undefined;
    store: RunCounter;
    submit: (job: {
      metadata: AutoTrackMetadata;
      step: ReturnType<typeof buildStickerAutoTrackWorkflow>;
    }) => Promise<{ id?: string | null; status?: number }>;
    now: () => number;
  },
  {
    user,
    imageId,
    pose,
    startMs,
  }: {
    user: { id: number; isModerator?: boolean };
    imageId: number;
    pose: StickerAutoTrackPose;
    startMs: number;
  }
) {
  await deps.checkSpace();
  const video = await deps.loadVideo();
  if (!video) throw throwNotFoundError('placement: image not found');
  const maxMs = stickerAutoTrackWindow(startMs, video.durationSeconds);
  if (maxMs === null)
    throw throwBadRequestError('placement: auto-track has to start before the video ends');

  const takeRun = async () => {
    // Never read `applies` here; see stickerAutoTrackDailyLimit.
    const limit = stickerAutoTrackDailyLimit(await deps.resolveLimit(), user.isModerator);
    const now = deps.now();
    const run = await takeStickerAutoTrackRun(deps.store, { userId: user.id, limit, now });
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
      deps.limitMessage(limit) ?? 'Daily auto-track limit reached.'
    );
  };

  const workflowId = await submitCountedAutoTrack({
    takeRun,
    submit: () =>
      deps.submit({
        metadata: { stickerAutoTrack: { userId: user.id, imageId, startMs } },
        step: buildStickerAutoTrackWorkflow({
          videoAir: stickerAutoTrackVideoAir(video.url),
          pose,
          startMs,
          maxMs,
          frame:
            video.width && video.height ? { width: video.width, height: video.height } : undefined,
        }),
      }),
  });
  return { workflowId, startMs, maxMs };
}

export type StickerAutoTrackResult =
  | { status: 'running' }
  | { status: 'failed' }
  | { status: 'missing' }
  | { status: 'succeeded'; track: StickerTrackV1; startMs: number };

/** Tick 0 is the placer's pose at `startMs`, not at video time 0. */
export async function pollAutoTrack(
  {
    read,
    download,
    maxScale,
  }: {
    read: () => Promise<{
      data?: Parameters<typeof readStickerAutoTrackWorkflow>[0];
      error?: unknown;
      status?: number;
    }>;
    download: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    maxScale: (imageId: number) => Promise<number>;
  },
  userId: number
): Promise<StickerAutoTrackResult> {
  const { data, error, status } = await read();
  if (!data && error && !autoTrackReadIsMissing(status)) return { status: 'running' };
  const run = readStickerAutoTrackWorkflow(data, userId);
  if (run.status === 'running' || run.status === 'failed') return { status: run.status };
  if (run.status !== 'download') return { status: 'missing' };

  const response = await download(run.url);
  if (!response.ok) return { status: 'failed' };
  const track = parseStickerAutoTrack(
    await response.json().catch(() => null),
    await maxScale(run.imageId)
  );
  return track ? { status: 'succeeded', track, startMs: run.startMs } : { status: 'failed' };
}

export const STICKER_AUTO_TRACK_MODERATOR_DAILY_RUNS = 25;

// `applies` is deliberately not read: a disabled entry must not lift this limit, because it is the
// only bound on what the system account spends. Moderators get their own number.
export function stickerAutoTrackDailyLimit(
  resolved: { limit: number; applies: boolean },
  isModerator?: boolean
) {
  return isModerator ? STICKER_AUTO_TRACK_MODERATOR_DAILY_RUNS : resolved.limit;
}
