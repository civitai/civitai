import { buildFliptContext } from '@civitai/flipt/context';
import type { Model3dBlob, NsfwLevel } from '@civitai/orchestration-client';
import type { NextApiRequest } from 'next';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { getPolyGenPostBlock } from '~/server/orchestrator/polygen/polygen-output';
import {
  isRateableMediaUrl,
  matureLevelOf,
  rateImagesV2,
} from '~/server/services/rating-v2.service';
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
const WAIT_SECONDS = 20;
/** The preview graph renders at most this many angles; only the first this many are sent. */
export const MAX_ANGLES = 4;
/** How long a mature v2 verdict holds the gate for that workflow without asking again. */
const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
const rememberedKey = (workflowId: string) =>
  `${REDIS_KEYS.GENERATION.MODEL3D_RATING_V2_MATURE}:${workflowId}` as const;

/** Mature when any angle has a mature v2 verdict; angles with no verdict add nothing. */
export function anglesMature(verdicts: (boolean | null)[]): boolean {
  return verdicts.some((v) => v === true);
}

export type Model3dRatingV2Deps = {
  matureLevel: (user: SessionUser) => Promise<number | null>;
  /** False when the global window refuses; throws the rate-limit error when the user's own limit
   *  refuses. */
  claim: (user: SessionUser, req: NextApiRequest) => Promise<boolean>;
  rate: typeof rateImagesV2;
  /** A mature verdict already given for this workflow. */
  remembered: (workflowId: string) => Promise<boolean>;
  remember: (workflowId: string) => Promise<void>;
};

const defaultDeps: Model3dRatingV2Deps = {
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
};

/** The v2 rater's answer for a 3D result's preview renders. `unrateable`: the result's own preview set
 *  can't be sent (none, or a URL that isn't an orchestrator-hosted image), which the user controls, so it
 *  can't pass unrated. `clear` covers the flag being off and every system-side gap (a full global
 *  window, a rater error, a timeout, no verdict on any angle): the post then decides on its current
 *  rating alone. */
export type Model3dV2Verdict = 'mature' | 'clear' | 'unrateable';

export async function rateModel3DByV2(
  {
    user,
    req,
    previewUrls,
    workflowId,
  }: { user: SessionUser; req: NextApiRequest; previewUrls: string[]; workflowId: string },
  deps: Model3dRatingV2Deps = defaultDeps
): Promise<Model3dV2Verdict> {
  // Each system-side step failing open keeps the post on its current rating: this rater can only add
  // the gate.
  const matureLevel = await deps.matureLevel(user).catch(() => null);
  if (matureLevel === null) return 'clear';
  if (await deps.remembered(workflowId).catch(() => false)) return 'mature';
  const angles = previewUrls.slice(0, MAX_ANGLES);
  if (!angles.length || !angles.every(isRateableMediaUrl)) {
    logToAxiom({
      name: 'model3d-rating-v2-unrateable',
      type: 'info',
      payload: { reason: angles.length ? 'url' : 'empty', angles: previewUrls.length },
    });
    return 'unrateable';
  }
  // The user's own limit is theirs to spend, so its refusal blocks the post (try again shortly) rather
  // than letting it through unrated; a system-side refusal or failure keeps today's rating.
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
      waitSeconds: WAIT_SECONDS,
    })
    .catch(() => null);
  if (!results || !anglesMature(results.map((r) => r.mature))) return 'clear';
  await deps.remember(workflowId).catch(() => undefined);
  return 'mature';
}

// No Yellow Buzz unlock is offered: the unlock releases only what the orchestrator itself rated mature.
export const MODEL3D_V2_MATURE = "This 3D model's preview was rated mature, so it can't be posted.";

export const MODEL3D_UNRATEABLE_PREVIEW =
  "This 3D model's preview couldn't be rated. Render it again, then post.";

/** What a 3D post shows as its cover and the images the v2 rater is shown for it: the preview renders,
 *  or, with none, the auto-thumbnail the cover falls back to. The cover is always one of the rated. */
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
    primaryModel: Pick<Model3dBlob, 'format'>;
    effectiveNsfwLevel: NsfwLevel | undefined;
    allowMatureContent: boolean | null | undefined;
    user: SessionUser;
    req: NextApiRequest;
    previewUrls: string[];
    workflowId: string;
  },
  deps: Model3dRatingV2Deps = defaultDeps
): Promise<string | undefined> {
  const block = getPolyGenPostBlock({ primaryModel, effectiveNsfwLevel, allowMatureContent });
  if (block || allowMatureContent !== false || isMature(effectiveNsfwLevel)) return block;
  const verdict = await rateModel3DByV2(rating, deps);
  if (verdict === 'unrateable') return MODEL3D_UNRATEABLE_PREVIEW;
  if (verdict !== 'mature') return undefined;
  return MODEL3D_V2_MATURE;
}
