import { buildFliptContext } from '@civitai/flipt/context';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { studioDatasetRatingSchema } from '~/server/schema/training-studio-dataset-rating.schema';
import {
  rateStudioDatasetImages,
  STUDIO_DATASET_RATING_GLOBAL_LIMIT,
  STUDIO_DATASET_RATING_RATE_LIMIT,
} from '~/server/services/training-studio-dataset-rating.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { resolveUsageLimitRules } from '~/server/services/usage-limit-config.service';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { claimRateLimitAttempt, peekRateLimit } from '~/server/utils/rate-limit-bucket';
import { rateLimitMetaOf } from '~/server/utils/rate-limit-error';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

// Both Studio surfaces reach this through the Studio's server, so it is gated like check-text, not
// as standalone-only.
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;
    // Off for this user: refused before any limit is counted or anything is submitted.
    const matureLevel = await datasetRatingLevel(user);
    if (matureLevel === null)
      return res.status(403).json({ error: 'Dataset rating is not available on this account.' });
    res.setHeader('Cache-Control', 'no-store');
    const input = studioDatasetRatingSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid dataset rating request.' });
    // The Studio caches the verdict under its own reading of the flag; a verdict made at another level
    // would be stored as this one's for every user at it. Refused before anything is counted.
    if (input.data.matureLevel !== matureLevel)
      return res.status(409).json({ error: 'Dataset rating settings changed. Try again.' });
    try {
      const record = await claimRateLimitAttempt({
        rules: STUDIO_DATASET_RATING_RATE_LIMIT.rules,
        keyName: STUDIO_DATASET_RATING_RATE_LIMIT.key,
        user,
        req,
      }).catch(async (e) => {
        if (rateLimitMetaOf(e)?.id === DAILY_LIMIT_ID) await reportDailyCap(user, req);
        throw e;
      });
      await record();
      const { key, max, windowSeconds } = STUDIO_DATASET_RATING_GLOBAL_LIMIT;
      const global = await checkFixedWindow(key, max, windowSeconds, { failOpen: false });
      if (!global.allowed) {
        res.setHeader('Retry-After', String(global.retryAfterSeconds));
        return res.status(429).json({ error: 'Dataset rating is unavailable until tomorrow.' });
      }
      return res.json(
        await rateStudioDatasetImages({ items: input.data.items, userId: user.id, matureLevel })
      );
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['POST']
);

/** The Studio's own reading of the flag (parseMatureLevel): a variant s1-s4 names the lowest mature
 *  level; anything else, or Flipt failing, is null, so it refuses. */
async function datasetRatingLevel(user: SessionUser): Promise<number | null> {
  const variant = await getFliptVariant(
    FLIPT_FEATURE_FLAGS.TRAINING_STUDIO_DATASET_RATING_V2,
    String(user.id),
    buildFliptContext(user)
  ).catch(() => null);
  const match = typeof variant === 'string' ? /^s([1-4])$/i.exec(variant.trim()) : null;
  return match ? Number(match[1]) : null;
}

const DAILY_LIMIT_ID = 'dataset-rating.daily';

/** The abuse signal: once per user per day, however many refusals follow. No blob ids. */
async function reportDailyCap(user: SessionUser, req: NextApiRequest) {
  try {
    const first = await checkFixedWindow(
      `training-studio:dataset-rating:daily-cap:${user.id}`,
      1,
      24 * 60 * 60,
      { failOpen: false }
    );
    if (!first.allowed) return;
    // The day's one signal is already claimed: log it even when the count can't be read.
    const usage = await resolveUsageLimitRules([DAILY_LIMIT_ID], user)
      .then((rules) =>
        peekRateLimit({ rules, sharedKey: STUDIO_DATASET_RATING_RATE_LIMIT.key, user, req })
      )
      .then(([daily]) => daily)
      .catch(() => undefined);
    logToAxiom({
      name: 'training-studio-dataset-rating-daily-cap',
      type: 'warning',
      message: 'user reached the dataset rating daily cap',
      userId: user.id,
      payload: { count: usage?.used ?? null },
    });
  } catch {
    // The refusal stands whether or not the signal is recorded.
  }
}
