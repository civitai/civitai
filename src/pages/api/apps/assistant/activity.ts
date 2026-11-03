import * as z from 'zod';
import { getAppAssistantRefusal } from '~/server/services/app-assistant/app-assistant.service';
import { readAppActivity } from '~/server/services/app-assistant/app-activity.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

const querySchema = z.object({ blockId: z.string().min(1).max(64) });

/**
 * GET ?blockId= → what the caller's own app did in the last 2 hours (`AppActivity` from
 * `@civitai/app-assistant`): its generations, its calls to Civitai and the errors its live preview
 * reported, newest first, with a one-line summary. App Assistant's preview-pane strip and the
 * page's `app_activity` tool read it.
 *
 * 404 when the app is not one of the caller's own (someone else's, or someone else's pending
 * submission): one answer for both.
 */
export default AuthedEndpoint(async (req, res, user) => {
  if (!requireFullScopeSession(req, res)) return;
  const refusal = await getAppAssistantRefusal({ user, req });
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });

  const query = querySchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: 'blockId is required' });

  res.setHeader('Cache-Control', 'no-store');
  const activity = await readAppActivity({ userId: user.id, blockId: query.data.blockId });
  if (!activity) return res.status(404).json({ error: 'App not found' });
  return res.json(activity);
});
