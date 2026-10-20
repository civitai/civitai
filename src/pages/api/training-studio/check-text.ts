import * as z from 'zod';
import { assertTrainingTriggerWordAllowed } from '~/server/services/orchestrator/training/training-trigger-word-check';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

// Far beyond any trigger word; bounds what one request sends to the classifier.
const schema = z.object({ triggerWord: z.string().max(1000) });

/**
 * The training trigger word check for the Training Studio, which submits to the orchestrator
 * itself: both of its surfaces call this for every run before submitting. POST { triggerWord } →
 * 200 { ok: true }; 400 with the refusal's reason in `message`.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;

    const input = schema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid trigger word.' });

    try {
      await assertTrainingTriggerWordAllowed({
        triggerWord: input.data.triggerWord,
        log: { userId: user.id, source: 'training-studio' },
      });
    } catch (e) {
      // A refusal reaches the Studio as a 400 carrying its reason; anything else as a generic 5xx.
      return handleEndpointError(res, e);
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true });
  },
  ['POST']
);
