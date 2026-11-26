import { buildFliptContext } from '@civitai/flipt/context';
import type { Model3dBlob, NsfwLevel, WorkflowStepTemplate } from '@civitai/orchestration-client';
import { getWorkflow, submitWorkflow } from '@civitai/orchestration-client';
import type { NextApiRequest } from 'next';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { getPolyGenPostBlock } from '~/server/orchestrator/polygen/polygen-output';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { isCivitaiMediaUrl } from '~/server/services/orchestrator/trusted-blob-url';
import {
  isRateableMediaUrl,
  matureLevelOf,
  rateImagesV2,
} from '~/server/services/rating-v2.service';
import { toOrchestratorError } from '~/server/services/training.service';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
import { TRPCError } from '@trpc/server';
import { isMature } from '~/shared/constants/orchestrator.constants';
import { usageLimits } from '~/shared/constants/usage-limits';
import type { SessionUser } from '~/types/session';

/** Per user, one unit per 3D result rated (all its preview angles in one request). */
export const MODEL3D_RATING_V2_RATE_LIMIT = {
  key: 'generation:model3dRatingV2',
  rules: usageLimits('model3d-rating.submit', 'model3d-rating.daily'),
};
/** Across all users, per fixed 24h window: bounds the system-paid GPU spend apart from the Training
 *  Studio's own budget. */
export const MODEL3D_RATING_V2_GLOBAL_LIMIT = {
  key: 'model3d:rating-v2:global',
  max: 20_000,
  windowSeconds: 24 * 60 * 60,
};
/** Per user, one unit per four-angle render asked for. */
export const MODEL3D_PREVIEW_V2_RATE_LIMIT = {
  key: 'generation:model3dPreviewV2',
  rules: usageLimits('model3d-preview.submit', 'model3d-preview.daily'),
};
/** Across all users, per fixed 24h window: bounds the system-paid preview renders of GLB and PLY
 *  results. */
export const MODEL3D_PREVIEW_V2_GLOBAL_LIMIT = {
  key: 'model3d:preview-v2:global',
  max: 500,
  windowSeconds: 24 * 60 * 60,
};
/** Cap on preview angles sent to the rater in one call. */
export const MAX_ANGLES = 4;
/** The angles a GLB or PLY result is rendered from for the rater: the queue card's front view, then a
 *  quarter turn each. Sent explicitly, since an empty list renders the orchestrator's default set. */
export const PREVIEW_POSES = [0, 90, 180, 270].map((yaw) => ({
  name: `yaw-${yaw}`,
  yaw,
  pitch: 8,
  distance: 2.8,
  fov: 45,
}));
const PREVIEW_SIZE = 1024;
const PREVIEW_WAIT_SECONDS = 8;
/** A preview still running this long after it was asked for counts as none came back. */
export const PREVIEW_EXPIRY_SECONDS = 10 * 60;
const RATEABLE_MESH_FORMATS = new Set(['glb', 'ply']);
const FINISHED = new Set(['succeeded', 'failed', 'expired', 'canceled']);
const clearKey = (userId: number, workflowId: string) =>
  `${REDIS_KEYS.GENERATION.MODEL3D_RATING_V2_CLEAR}:${userId}:${workflowId}` as const;
/** The images a verdict was given for, by stored path: their signed query strings change per read. */
export const ratedSet = (urls: string[]) =>
  urls
    .map((u) => new URL(u).pathname)
    .sort()
    .join('\n');
/** A clear verdict holds only for the same level and the same images: a tightened level rates again. */
export const clearStamp = (matureLevel: number, urls: string[]) =>
  `${matureLevel}\n${ratedSet(urls)}`;
const retryKey = (userId: number, workflowId: string) =>
  `${REDIS_KEYS.GENERATION.MODEL3D_PREVIEW_V2_RETRY}:${userId}:${workflowId}` as const;
const WINDOW_GRACE_SECONDS = 60 * 60;
/** The global preview window a moment falls in: one key per window, so each window counts apart. */
export const previewWindowKey = (now: number) =>
  `${MODEL3D_PREVIEW_V2_GLOBAL_LIMIT.key}:${Math.floor(
    now / 1000 / MODEL3D_PREVIEW_V2_GLOBAL_LIMIT.windowSeconds
  )}`;
const pendingPreviewKey = (userId: number, workflowId: string) =>
  `${REDIS_KEYS.GENERATION.MODEL3D_PREVIEW_V2_PENDING}:${userId}:${workflowId}` as const;
/** How long a mature v2 verdict holds the gate for that workflow without asking again. */
const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
const rememberedKey = (workflowId: string) =>
  `${REDIS_KEYS.GENERATION.MODEL3D_RATING_V2_MATURE}:${workflowId}` as const;

/** Mature when any angle has a mature v2 verdict; angles with no verdict add nothing. */
export function anglesMature(verdicts: (boolean | null)[]): boolean {
  return verdicts.some((v) => v === true);
}

/** A preview render: still running, or finished with the image urls it returned (none on failure). */
export type PreviewState = { status: 'running' } | { status: 'done'; urls: string[] };
export type PendingPreview = { workflowId: string; at: number };

export type Model3dRatingV2Deps = {
  matureLevel: (user: SessionUser) => Promise<number | null>;
  /** False when the global window refuses; throws the rate-limit error when the user's own limit
   *  refuses. */
  claim: (user: SessionUser, req: NextApiRequest) => Promise<boolean>;
  rate: typeof rateImagesV2;
  /** A mature verdict already given for this workflow. */
  remembered: (workflowId: string) => Promise<boolean>;
  remember: (workflowId: string) => Promise<void>;
  /** What this user's result was last rated clear on: the level and the images, as `clearStamp` gives
   *  them. */
  rememberedClear: (userId: number, workflowId: string) => Promise<string | null>;
  rememberClear: (userId: number, workflowId: string, rated: string) => Promise<void>;
  /** The preview this user already asked for on this result. */
  pendingPreview: (userId: number, workflowId: string) => Promise<PendingPreview | null>;
  setPendingPreview: (userId: number, workflowId: string, value: PendingPreview) => Promise<void>;
  /** Runs `op` while no other click asks for this user's result; null when another one is. */
  exclusive: <T>(userId: number, workflowId: string, op: () => Promise<T>) => Promise<T | null>;
  clearPendingPreview: (userId: number, workflowId: string) => Promise<void>;
  /** The one re-render a result with an empty render gets per user; false once it is spent. */
  takeRetry: (userId: number, workflowId: string) => Promise<boolean>;
  /** Spends one of the user's own renders; throws the rate-limit error when that limit refuses. */
  claimPreviewUser: (
    user: SessionUser,
    req: NextApiRequest
  ) => Promise<{ refund: () => Promise<void> }>;
  /** The window key the slot was counted in, or null when the global window refuses. */
  claimPreview: () => Promise<string | null>;
  /** Gives back a slot, in the window it was counted in. */
  releasePreview: (windowKey: string) => Promise<void>;
  submitPreview: (
    mesh: { url: string; format: string },
    metadata: Record<string, unknown>
  ) => Promise<{ workflowId: string; state: PreviewState }>;
  readPreview: (workflowId: string) => Promise<PreviewState>;
  now: () => number;
};

function previewState(workflow: {
  status?: string | null;
  steps?: unknown[] | null;
}): PreviewState {
  if (!workflow.status || !FINISHED.has(workflow.status)) return { status: 'running' };
  const step = workflow.steps?.find(
    (s) => (s as { $type?: string } | null)?.$type === 'model3DPreview'
  ) as { output?: { images?: ({ url?: string | null } | null)[] } } | undefined;
  const urls = (step?.output?.images ?? []).flatMap((img) => (img?.url ? [img.url] : []));
  return { status: 'done', urls };
}

/** The orchestrator refused the submit with a 4xx: nothing was created, so the slot can be given back. */
export class Model3dPreviewRejectedError extends Error {
  constructor(readonly answer: unknown) {
    super('model3DPreview submit rejected');
  }
}

/** Asks the orchestrator, on the system token, for the four-angle render of a mesh. */
export async function submitModel3DPreview(
  mesh: { url: string; format: string },
  metadata: Record<string, unknown>
): Promise<{ workflowId: string; state: PreviewState }> {
  const step = {
    $type: 'model3DPreview',
    name: 'preview',
    input: {
      model: mesh.url,
      format: mesh.format,
      width: PREVIEW_SIZE,
      height: PREVIEW_SIZE,
      outputFormat: 'png',
      cameraPoses: PREVIEW_POSES,
    },
  } as unknown as WorkflowStepTemplate;
  // On the system token: a render submitted with the user's own token is charged to them.
  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: PREVIEW_WAIT_SECONDS },
    body: { tags: ['civitai', 'model3d', 'post-rating'], metadata, steps: [step], currencies: [] },
  });
  if (!data?.id) {
    // Only a 4xx says nothing was created; a 5xx may come after the workflow already was.
    const status = response?.status ?? 0;
    if (status >= 400 && status < 500) throw new Model3dPreviewRejectedError(error);
    throw new Error(`model3DPreview submit failed (${status})`);
  }
  return { workflowId: data.id as string, state: previewState(data) };
}

export async function readModel3DPreview(workflowId: string): Promise<PreviewState> {
  const { data, error } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId },
  });
  if (!data) toOrchestratorError(error);
  return previewState(data);
}

export const model3dRatingV2Deps: Model3dRatingV2Deps = {
  matureLevel: async (user) =>
    matureLevelOf(
      await getFliptVariant(
        FLIPT_FEATURE_FLAGS.MODEL3D_RATING_V2,
        String(user.id),
        buildFliptContext(user)
      ).catch(() => null)
    ),
  claim: async (user, req) => {
    const record = await claimRateLimitAttempt({
      rules: MODEL3D_RATING_V2_RATE_LIMIT.rules,
      keyName: MODEL3D_RATING_V2_RATE_LIMIT.key,
      user,
      req,
    });
    await record();
    const { key, max, windowSeconds } = MODEL3D_RATING_V2_GLOBAL_LIMIT;
    const global = await checkFixedWindow(key, max, windowSeconds, { failOpen: false });
    return global.allowed;
  },
  rate: rateImagesV2,
  remembered: async (workflowId) => (await redis.exists(rememberedKey(workflowId))) > 0,
  remember: async (workflowId) => {
    await redis.set(rememberedKey(workflowId), '1', { EX: REMEMBER_SECONDS });
  },
  rememberedClear: async (userId, workflowId) => await redis.get(clearKey(userId, workflowId)),
  rememberClear: async (userId, workflowId, rated) => {
    await redis.set(clearKey(userId, workflowId), rated, { EX: REMEMBER_SECONDS });
  },
  pendingPreview: async (userId, workflowId) => {
    const raw = await redis.get(pendingPreviewKey(userId, workflowId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingPreview>;
    return typeof value.workflowId === 'string' && typeof value.at === 'number'
      ? { workflowId: value.workflowId, at: value.at }
      : null;
  },
  setPendingPreview: async (userId, workflowId, value) => {
    // Kept as long as a mature verdict is, so a result is rendered once however often it is posted.
    await redis.set(pendingPreviewKey(userId, workflowId), JSON.stringify(value), {
      EX: REMEMBER_SECONDS,
    });
  },
  exclusive: (userId, workflowId, op) =>
    withDistributedLock(
      { key: `model3d-preview:${userId}:${workflowId}`, ttl: 60, maxRetries: 0, autoRenew: true },
      op
    ),
  clearPendingPreview: async (userId, workflowId) => {
    await redis.del(pendingPreviewKey(userId, workflowId));
  },
  takeRetry: async (userId, workflowId) =>
    // SET NX answers null when the key was already there.
    (await redis.set(retryKey(userId, workflowId), '1', { NX: true, EX: REMEMBER_SECONDS })) !==
    null,
  claimPreviewUser: async (user, req) => {
    const record = await claimRateLimitAttempt({
      rules: MODEL3D_PREVIEW_V2_RATE_LIMIT.rules,
      keyName: MODEL3D_PREVIEW_V2_RATE_LIMIT.key,
      user,
      req,
    });
    await record();
    return record;
  },
  claimPreview: async () => {
    const key = previewWindowKey(Date.now());
    const { max, windowSeconds } = MODEL3D_PREVIEW_V2_GLOBAL_LIMIT;
    // Kept past its window, so a slot given back after the window ends lands in the window it was
    // counted in.
    const counted = await checkFixedWindow(key, max, windowSeconds + WINDOW_GRACE_SECONDS, {
      failOpen: false,
    });
    return counted.allowed ? key : null;
  },
  releasePreview: async (windowKey) => {
    // A key that has expired is recreated by the decrement; it is a past window, so it is dropped.
    // Two commands, not one: safe because only a past window can go below zero.
    if ((await redis.incrBy(windowKey as never, -1)) < 0) await redis.del(windowKey as never);
  },
  submitPreview: submitModel3DPreview,
  readPreview: readModel3DPreview,
  now: () => Date.now(),
};

/** The result's own mesh when it is one the preview can render from: a GLB or PLY the orchestrator
 *  hosts. */
function rateableMesh(model: Pick<Model3dBlob, 'format' | 'url'>) {
  const format = model.format?.toLowerCase();
  return model.url && RATEABLE_MESH_FORMATS.has(format) && isCivitaiMediaUrl(model.url)
    ? { url: model.url, format }
    : undefined;
}

/** The angles of this user's preview render of the result, or `pending` while it runs. Empty when none
 *  came back: failed, still running past the expiry, refused by the global window, or unreachable. */
async function previewAngles(
  {
    user,
    req,
    mesh,
    workflowId,
  }: {
    user: SessionUser;
    req: NextApiRequest;
    mesh: { url: string; format: string };
    workflowId: string;
  },
  deps: Model3dRatingV2Deps
): Promise<string[] | 'pending'> {
  const now = deps.now();
  const pending = await deps.pendingPreview(user.id, workflowId).catch(() => null);
  if (pending) {
    // A read that fails is no answer yet: the render may still come back.
    const state: PreviewState = await deps
      .readPreview(pending.workflowId)
      .catch(() => ({ status: 'running' }));
    if (state.status === 'running') {
      return now - pending.at > PREVIEW_EXPIRY_SECONDS * 1000 ? [] : 'pending';
    }
    const urls = state.urls.filter(isRateableMediaUrl);
    if (urls.length) return urls;
    if (!(await deps.takeRetry(user.id, workflowId).catch(() => false))) {
      // The retry is spent; if another click is re-rendering right now, wait for that render.
      const current = await deps.pendingPreview(user.id, workflowId).catch(() => pending);
      return current?.workflowId === pending.workflowId ? [] : 'pending';
    }
    await deps.clearPendingPreview(user.id, workflowId).catch(() => undefined);
  }
  return submitAngles({ user, req, mesh, workflowId, now }, deps);
}

/** Asks for the render once: a click while another asks returns pending without asking again, and
 *  the user's own limit is spent before the shared window. */
async function submitAngles(
  args: {
    user: SessionUser;
    req: NextApiRequest;
    mesh: { url: string; format: string };
    workflowId: string;
    now: number;
  },
  deps: Model3dRatingV2Deps
): Promise<string[] | 'pending'> {
  const asked = await deps
    .exclusive(args.user.id, args.workflowId, () => submitOnce(args, deps))
    .catch((e) => {
      if (e instanceof TRPCError && e.code === 'TOO_MANY_REQUESTS') throw e;
      return [];
    });
  if (asked) return asked;
  // The lock was not taken: another click holds it, unless the store itself cannot be read.
  return (await deps.pendingPreview(args.user.id, args.workflowId).then(
    () => true,
    () => false
  ))
    ? 'pending'
    : [];
}

async function submitOnce(
  {
    user,
    req,
    mesh,
    workflowId,
    now,
  }: {
    user: SessionUser;
    req: NextApiRequest;
    mesh: { url: string; format: string };
    workflowId: string;
    now: number;
  },
  deps: Model3dRatingV2Deps
): Promise<string[] | 'pending'> {
  // Another click may have asked between this one's read and taking the lock.
  if (await deps.pendingPreview(user.id, workflowId)) return 'pending';
  // The user's own limit is theirs to spend, so its refusal blocks the post rather than letting it
  // fall back to the front render.
  const userClaim = await deps.claimPreviewUser(user, req);
  const windowKey = await deps.claimPreview().catch(() => null);
  if (!windowKey) {
    await userClaim.refund();
    return [];
  }
  let submitted: { workflowId: string; state: PreviewState };
  try {
    submitted = await deps.submitPreview(mesh, {
      kind: 'model3d-post-preview',
      userId: user.id,
      workflowId,
    });
  } catch (e) {
    // Given back only when nothing was asked for; a submit lost in transit may have been accepted.
    if (e instanceof Model3dPreviewRejectedError) {
      await deps.releasePreview(windowKey).catch(() => undefined);
      await userClaim.refund();
    }
    return [];
  }
  await deps
    .setPendingPreview(user.id, workflowId, { workflowId: submitted.workflowId, at: now })
    .catch(() => undefined);
  if (submitted.state.status === 'running') return 'pending';
  return submitted.state.urls.filter(isRateableMediaUrl);
}

/** `unrateable`: the result's own preview set can't be sent, which the user controls, so it can't pass
 *  unrated. `pending`: its preview render is still running, so it can't pass yet. `clear`: no gate; the
 *  post decides on its current rating. */
export type Model3dV2Verdict = 'mature' | 'clear' | 'unrateable' | 'pending';

export async function rateModel3DByV2(
  {
    user,
    req,
    primaryModel,
    previewUrls,
    coverUrl,
    workflowId,
  }: {
    user: SessionUser;
    req: NextApiRequest;
    primaryModel: Pick<Model3dBlob, 'format' | 'url'>;
    previewUrls: string[];
    /** The image the post shows as its cover: always among those rated. Required, so a caller can't
     *  leave it out by omission. */
    coverUrl: string | undefined;
    workflowId: string;
  },
  deps: Model3dRatingV2Deps = model3dRatingV2Deps
): Promise<Model3dV2Verdict> {
  // Each system-side step failing open keeps the post on its current rating: this rater can only add
  // the gate.
  const matureLevel = await deps.matureLevel(user).catch(() => null);
  if (matureLevel === null) return 'clear';
  if (await deps.remembered(workflowId).catch(() => false)) return 'mature';
  // A GLB or PLY is rated from its own four-angle render; when none of it comes back, even after its
  // one retry, from the renders the result already has.
  const mesh = rateableMesh(primaryModel);
  const rendered = mesh ? await previewAngles({ user, req, mesh, workflowId }, deps) : [];
  if (rendered === 'pending') return 'pending';
  const angles = (rendered.length ? rendered : previewUrls).slice(0, MAX_ANGLES);
  if (coverUrl && !angles.includes(coverUrl)) angles.push(coverUrl);
  if (!angles.length || !angles.every(isRateableMediaUrl)) {
    logToAxiom({
      name: 'model3d-rating-v2-unrateable',
      type: 'info',
      payload: { reason: angles.length ? 'url' : 'empty', angles: previewUrls.length },
    });
    return 'unrateable';
  }
  const rated = clearStamp(matureLevel, angles);
  if ((await deps.rememberedClear(user.id, workflowId).catch(() => null)) === rated) return 'clear';
  // The user's own limit is theirs to spend, so its refusal blocks the post (try again shortly) rather
  // than letting it through unrated; a system-side refusal or failure keeps the post's current rating.
  const claimed = await deps.claim(user, req).catch((e) => {
    if (e instanceof TRPCError && e.code === 'TOO_MANY_REQUESTS') throw e;
    return false;
  });
  if (!claimed) return 'clear';
  const results = await deps
    .rate({
      items: angles.map((mediaUrl, i) => ({ key: `${i}`, mediaUrl })),
      matureLevel,
      metadata: { kind: 'model3d-post-rating', userId: user.id, workflowId },
      tags: ['civitai', 'model3d', 'post-rating'],
    })
    .catch(() => null);
  if (!results) return 'clear';
  const verdicts = results.map((r) => r.mature);
  if (!anglesMature(verdicts)) {
    // Only a verdict on every image is kept, so an image with none is asked again next time.
    if (verdicts.length === angles.length && verdicts.every((v) => v === false)) {
      await deps.rememberClear(user.id, workflowId, rated).catch(() => undefined);
    }
    return 'clear';
  }
  await deps.remember(workflowId).catch(() => undefined);
  return 'mature';
}

// No Yellow Buzz unlock is offered: the unlock releases only what the orchestrator itself rated mature.
export const MODEL3D_V2_MATURE = "This 3D model's preview was rated mature, so it can't be posted.";

export const MODEL3D_PREVIEW_PENDING =
  "Still checking this model's preview. Try again in a moment.";

export const MODEL3D_UNRATEABLE_PREVIEW =
  "This 3D model's preview couldn't be rated. Render it again, then post.";

/** What a 3D post shows as its cover and the images the v2 rater is shown for it: the preview renders,
 *  or, with none, the auto-thumbnail the cover falls back to; a cover with no url leaves nothing rated. */
export function model3DPostImages<T extends { url?: string | null }>(
  renders: readonly (T | null | undefined)[],
  thumbnail: T | null | undefined
): { coverOverride: T | undefined; cover: T | undefined; ratedUrls: string[] } {
  const rendered = renders.filter((img): img is T & { url: string } => !!img?.url);
  const coverOverride = rendered[0];
  const cover = coverOverride ?? thumbnail ?? undefined;
  const ratedUrls = rendered.length
    ? rendered.map((img) => img.url)
    : cover?.url
    ? [cover.url]
    : [];
  return { coverOverride, cover, ratedUrls };
}

/** The post gate with the v2 rater added: today's block, else a block when the v2 rater calls the
 *  result mature. It is asked only when the current rating would let a result without mature-content
 *  billing through. */
export async function getModel3DPostBlock(
  {
    primaryModel,
    effectiveNsfwLevel,
    allowMatureContent,
    ...rating
  }: {
    primaryModel: Pick<Model3dBlob, 'format' | 'url'>;
    effectiveNsfwLevel: NsfwLevel | undefined;
    allowMatureContent: boolean | null | undefined;
    user: SessionUser;
    req: NextApiRequest;
    previewUrls: string[];
    coverUrl: string | undefined;
    workflowId: string;
  },
  deps: Model3dRatingV2Deps = model3dRatingV2Deps
): Promise<string | undefined> {
  const block = getPolyGenPostBlock({ primaryModel, effectiveNsfwLevel, allowMatureContent });
  if (block || allowMatureContent !== false || isMature(effectiveNsfwLevel)) return block;
  const verdict = await rateModel3DByV2({ ...rating, primaryModel }, deps);
  if (verdict === 'pending') return MODEL3D_PREVIEW_PENDING;
  if (verdict === 'unrateable') return MODEL3D_UNRATEABLE_PREVIEW;
  if (verdict !== 'mature') return undefined;
  return MODEL3D_V2_MATURE;
}
