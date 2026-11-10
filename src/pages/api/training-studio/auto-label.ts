import type { NextApiRequest } from 'next';
import {
  studioAutoLabelPollSchema,
  studioAutoLabelSubmitSchema,
} from '~/server/schema/training-studio-auto-label.schema';
import {
  pollStudioAutoLabel,
  STUDIO_AUTO_LABEL_RATE_LIMITS,
  submitStudioAutoLabel,
} from '~/server/services/training-studio-auto-label.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
import {
  allowTrainingStudio,
  isStandaloneStudioAllowed,
} from '~/server/utils/training-studio-access';
import type { SessionUser } from '~/types/session';

export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

async function takeAttempt(
  limit: (typeof STUDIO_AUTO_LABEL_RATE_LIMITS)[keyof typeof STUDIO_AUTO_LABEL_RATE_LIMITS],
  user: SessionUser,
  req: NextApiRequest
) {
  const record = await claimRateLimitAttempt({ rules: limit.rules, keyName: limit.key, user, req });
  await record();
}

/**
 * The standalone Training Studio's auto-label: the same free, system-paid path the embed reaches
 * through `training.studioAutoLabelSubmit` / `studioAutoLabelPoll`, with the same per-minute buckets
 * and daily quota. POST { mode, media, items } → { workflowId }; GET ?workflowId= → { done, results }.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;
    if (!(await isStandaloneStudioAllowed(user)))
      return res
        .status(403)
        .json({ error: "Auto-labeling isn't available on this account right now." });
    res.setHeader('Cache-Control', 'no-store');

    try {
      if (req.method === 'POST') {
        const input = studioAutoLabelSubmitSchema.safeParse(req.body);
        if (!input.success) return res.status(400).json({ error: 'Invalid auto-label request.' });
        await takeAttempt(STUDIO_AUTO_LABEL_RATE_LIMITS.submit, user, req);
        return res.json(await submitStudioAutoLabel({ ...input.data, userId: user.id }));
      }
      const input = studioAutoLabelPollSchema.safeParse(req.query);
      if (!input.success) return res.status(400).json({ error: 'Invalid auto-label request.' });
      await takeAttempt(STUDIO_AUTO_LABEL_RATE_LIMITS.poll, user, req);
      return res.json(await pollStudioAutoLabel({ ...input.data, userId: user.id }));
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET', 'POST']
);
