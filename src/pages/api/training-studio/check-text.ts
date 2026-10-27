import * as z from 'zod';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { assertTrainingTriggerWordAllowed } from '~/server/services/orchestrator/training/training-trigger-word-check';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

// Far beyond any trigger word or edit prompt; bounds what one request sends to the classifier.
// Strict: a body naming both keys is refused rather than checked as whichever branch matches first,
// which would let an edit prompt through as a trigger word.
const schema = z.union([
  // The Studio's "create the after image" generates from this prompt, so it gets the generator's check.
  z
    .object({
      editPrompt: z.string().min(1).max(1500),
      inputImages: z.array(z.string().url().max(2000)).max(1).optional(),
    })
    .strict(),
  z.object({ triggerWord: z.string().max(1000) }).strict(),
]);

/**
 * The text checks for the Training Studio, which submits to the orchestrator itself: both of its
 * surfaces call this before submitting. POST { triggerWord } runs the training trigger word check
 * for a run; POST { editPrompt, inputImages } runs the generator's prompt check before the Studio
 * generates an edit with it. 200 { ok: true }; 400 with the refusal's reason in `message`.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;

    const input = schema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid text to check.' });

    try {
      if ('editPrompt' in input.data)
        await auditPromptServer({
          prompt: input.data.editPrompt,
          userId: user.id,
          isGreen: getRequestDomainColor(req) === 'green',
          isModerator: user.isModerator,
          inputImages: input.data.inputImages,
        });
      else
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
