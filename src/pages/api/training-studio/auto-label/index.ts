import { submitStudioAutoLabelSchema } from '~/server/schema/training.schema';
import { submitStudioAutoLabelWorkflow } from '~/server/services/training.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { allowStudioAutoLabel } from '~/server/utils/training-studio-access';
import { checkStudioAutoLabelRateLimit } from '~/server/utils/training-studio-auto-label-rate-limit';

// 16 items × a 2 KB URL plus a filename each, with headroom.
export const config = { api: { bodyParser: { sizeLimit: '64kb' } } };

/**
 * The Training Studio's auto-label submit. The Studio talks to the orchestrator on the user's own
 * token, which would bill each tag/caption job to them; this submits the batch on the system token
 * instead, as the classic trainer does, so auto-labeling stays free. Both Studio surfaces call it.
 * POST { mediaType, images: [{ mediaUrl, filename }], params } → 200 { workflowId, stepCount }.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowStudioAutoLabel(req, res, user))) return;

    const input = submitStudioAutoLabelSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid auto-label request.' });

    const limit = await checkStudioAutoLabelRateLimit(user.id);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many auto-label requests. Try again shortly.' });
    }

    try {
      const result = await submitStudioAutoLabelWorkflow({ ...input.data, userId: user.id });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(result);
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['POST']
);
