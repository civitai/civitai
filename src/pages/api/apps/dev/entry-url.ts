import * as z from 'zod';
import { resolveDevTunnelPageFrame } from '~/server/services/blocks/dev-tunnel-page-frame.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

const querySchema = z.object({ blockId: z.string().min(1).max(64) });

const NOT_FOUND = { error: 'App not found' };

/**
 * GET ?blockId= → `{ iframeSrc, host }`: a freshly signed dev-tunnel entry URL for the
 * `/apps/dev/<blockId>` page's Retry, which swaps it into the frame without remounting the host.
 *
 * Behind exactly the page's gates (`resolveDevTunnelPageFrame`), plus a full-scope session. Every
 * refusal the page answers with `notFound` — a gated account, a foreign or missing app, a
 * malformed id — is this one bare 404. 409 when the app is the caller's but there is no URL to sign:
 * no live tunnel, or its host is not published yet. The host comes only from the server-side tunnel
 * record, never from the request.
 */
export default AuthedEndpoint(async (req, res, user) => {
  if (!requireFullScopeSession(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  const query = querySchema.safeParse(req.query);
  if (!query.success) return res.status(404).json(NOT_FOUND);

  const features = await getFeatureFlagsAsync({ user, req });
  const frame = await resolveDevTunnelPageFrame(user, query.data.blockId, features);
  if (!frame) return res.status(404).json(NOT_FOUND);
  if (!frame.iframeSrc || !frame.host)
    return res.status(409).json({
      error: frame.dnsPending
        ? 'The dev tunnel is not reachable yet'
        : 'No live dev tunnel for this app',
    });
  return res.json({ iframeSrc: frame.iframeSrc, host: frame.host });
});
