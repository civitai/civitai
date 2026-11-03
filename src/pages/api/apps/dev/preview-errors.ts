import * as z from 'zod';
import {
  PREVIEW_ERRORS_BATCH_MAX,
  previewErrorReportSchema,
  storePreviewErrors,
} from '~/server/services/app-assistant/preview-errors.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

const bodySchema = z.object({
  blockId: z.string().min(1).max(64),
  errors: z.array(previewErrorReportSchema).min(1).max(PREVIEW_ERRORS_BATCH_MAX),
});

/**
 * POST { blockId, errors } → keeps the errors the caller's app reported in its LIVE DEV PREVIEW
 * (`BLOCK_ERROR {fatal:false}`, sent only by the dev-tunnel host, `DevTunnelBlockHost`), for App
 * Assistant's app-activity read. Owner-only: kept only while the caller has a live dev tunnel of
 * that app, so a production block (which has none) stores nothing. The text is redacted and capped
 * again on the server (`preview-errors.service.ts`).
 *
 *   200 `{ stored }`
 *   400 the body is not that shape
 *   404 no live dev preview of the caller's for that app
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!requireFullScopeSession(req, res)) return;
    const body = bodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Expected { blockId, errors }' });

    res.setHeader('Cache-Control', 'no-store');
    const result = await storePreviewErrors({
      userId: user.id,
      blockId: body.data.blockId,
      reports: body.data.errors,
    });
    if (result.status === 'not-found')
      return res.status(404).json({ error: 'No live preview of yours for this app' });
    return res.json({ stored: result.stored });
  },
  ['POST']
);
