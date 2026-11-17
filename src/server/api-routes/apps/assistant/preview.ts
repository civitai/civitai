import * as z from 'zod';
import {
  getAppAssistantPreview,
  getAppAssistantRefusal,
} from '~/server/services/app-assistant/app-assistant.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

const querySchema = z.object({ blockId: z.string().min(1).max(64) });

/**
 * GET ?blockId= → the preview pane's frame: the caller's own app over its live dev tunnel, with a
 * freshly signed entry URL, or `{ preparing: true }` while the tunnel's host is not resolvable yet.
 * 404 when the app is not theirs; 409 when no tunnel is up yet.
 */
export default AuthedEndpoint(async (req, res, user) => {
  if (!requireFullScopeSession(req, res)) return;
  const refusal = await getAppAssistantRefusal({ user, req });
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });

  const query = querySchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: 'blockId is required' });

  res.setHeader('Cache-Control', 'no-store');
  const preview = await getAppAssistantPreview({ user, req, blockId: query.data.blockId });
  switch (preview.status) {
    case 'ok':
      return res.json(preview.frame);
    case 'preparing':
      return res.json({ preparing: true });
    case 'forbidden':
      return res.status(403).json({ error: preview.error });
    case 'not-found':
      return res.status(404).json({ error: 'App not found' });
    case 'no-tunnel':
      return res.status(409).json({ error: 'No live preview is running for this app' });
  }
});
