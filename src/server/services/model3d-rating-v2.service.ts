import { buildFliptContext } from '@civitai/flipt/context';
import type { Model3dBlob, NsfwLevel } from '@civitai/orchestration-client';
import { NsfwLevel as OrchestratorNsfwLevel } from '@civitai/orchestration-client';
import type { NextApiRequest } from 'next';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { getPolyGenPostBlock } from '~/server/orchestrator/polygen/polygen-output';
import {
  isRateableMediaUrl,
  matureLevelOf,
  rateImagesV2,
} from '~/server/services/rating-v2.service';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
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

/** Mature only when every angle has a v2 verdict and one of them is mature: a missing angle leaves the
 *  result to its current rating, since the v2 rater can only add the gate. */
export function anglesMature(verdicts: (boolean | null)[]): boolean {
  return (
    verdicts.length > 0 && verdicts.every((v) => v !== null) && verdicts.some((v) => v === true)
  );
}

export type Model3dRatingV2Deps = {
  matureLevel: (user: SessionUser) => Promise<number | null>;
  /** False when a limit refuses: the result then keeps its current rating. */
  claim: (user: SessionUser, req: NextApiRequest) => Promise<boolean>;
  rate: typeof rateImagesV2;
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
    try {
      const record = await claimRateLimitAttempt({
        rules: MODEL3D_RATING_V2_RATE_LIMIT.rules,
        keyName: MODEL3D_RATING_V2_RATE_LIMIT.key,
        user,
        req,
      });
      await record();
    } catch {
      return false;
    }
    const { key, max, windowSeconds } = MODEL3D_RATING_V2_GLOBAL_LIMIT;
    const global = await checkFixedWindow(key, max, windowSeconds, { failOpen: false });
    return global.allowed;
  },
  rate: rateImagesV2,
};

/** Whether the v2 rater calls this 3D result's preview renders mature. Off (flag), refused (limits),
 *  failed or partly rated is false: the post gate then decides on the current rating alone. */
export async function isModel3DMatureByV2(
  {
    user,
    req,
    previewUrls,
    workflowId,
  }: { user: SessionUser; req: NextApiRequest; previewUrls: string[]; workflowId: string },
  deps: Model3dRatingV2Deps = defaultDeps
): Promise<boolean> {
  if (!previewUrls.length || !previewUrls.every(isRateableMediaUrl)) return false;
  const matureLevel = await deps.matureLevel(user);
  if (matureLevel === null) return false;
  if (!(await deps.claim(user, req))) return false;
  const results = await deps
    .rate({
      items: previewUrls.map((mediaUrl, i) => ({ key: `${i}`, mediaUrl })),
      matureLevel,
      metadata: { kind: 'model3d-post-rating', userId: user.id, workflowId },
      tags: ['civitai', 'model3d', 'post-rating'],
      waitSeconds: WAIT_SECONDS,
    })
    .catch(() => null);
  return results ? anglesMature(results.map((r) => r.mature)) : false;
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
  if (!(await isModel3DMatureByV2(rating, deps))) return undefined;
  return getPolyGenPostBlock({
    primaryModel,
    effectiveNsfwLevel: OrchestratorNsfwLevel.R,
    allowMatureContent,
  });
}
