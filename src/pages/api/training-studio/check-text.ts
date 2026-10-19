import * as z from 'zod';
import { REDIS_KEYS } from '~/server/redis/client';
import { assertTrainingTextAllowed } from '~/server/services/orchestrator/training/training-label-check';
import { checkFixedWindow } from '~/server/utils/block-catalog-rate-limit';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { BodyTooLargeError, readCappedBody } from '~/server/utils/read-capped-body';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';
import { MAX_AUDIT_PROMPT_LENGTH } from '~/utils/metadata/audit';

// Body read by hand after authentication, so an anonymous request is never parsed.
export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Per user, counted in classifier batches, so a large dataset spends more of it than a small one. */
const RATE_LIMIT_BATCHES = 600;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

const schema = z.object({
  triggerWord: z.string(),
  captions: z.array(z.string()),
});

/**
 * The training text rule for the Training Studio, which submits to the orchestrator itself: both of
 * its surfaces call this for every run before submitting. POST { triggerWord, captions } → 200
 * { ok: true }; 400 with the refusal's reason in `message`; 413 when the text is beyond what is checked.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;

    let body: unknown;
    try {
      body = JSON.parse((await readCappedBody(req, MAX_BODY_BYTES)).toString('utf8'));
    } catch (e) {
      if (e instanceof BodyTooLargeError)
        return res.status(413).json({ error: 'This dataset has more text than can be checked.' });
      return res.status(400).json({ error: 'Invalid training text.' });
    }
    const input = schema.safeParse(body);
    if (!input.success) return res.status(400).json({ error: 'Invalid training text.' });

    const chars = input.data.captions.reduce(
      (sum, c) => sum + c.length,
      input.data.triggerWord.length
    );
    const rate = await checkFixedWindow(
      `${REDIS_KEYS.TRAINING_STUDIO.TEXT_CHECK_RATE_LIMIT}:${user.id}`,
      RATE_LIMIT_BATCHES,
      RATE_LIMIT_WINDOW_SECONDS,
      Math.max(1, Math.ceil(chars / MAX_AUDIT_PROMPT_LENGTH))
    );
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many training checks. Try again later.' });
    }

    try {
      await assertTrainingTextAllowed({
        ...input.data,
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
