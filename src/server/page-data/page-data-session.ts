import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import {
  bootstrapSession,
  settingsBootstrapRequest,
} from '~/server/services/settings-bootstrap.service';

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * A response the session lookup can be handed when it must NOT write the session cookie. The
 * lookup only rolls or upgrades the cookie on a response that has a `setHeader`
 * (`maybeRollHubCookie`, `maybeUpgradeLegacySession`), and skips the hub call that mints the new
 * cookie along with it; so without one it reads the session and writes nothing.
 */
const READ_ONLY_SESSION_RESPONSE = {} as NextApiResponse;

/**
 * The viewer's session for a `GET /api/page-data/*` request. ONE implementation, two callers — the
 * page data of `/images/[imageId]` and its main-image lookup, which the shell requests in parallel
 * — so the two see the same viewer for the same request.
 *
 * The session is read from the request a server render's bootstrap reads (fixed path, so a
 * `?token=` here never replaces the cookie viewer), with the viewer's own host, which the session
 * cookie's Domain comes from. The credential the lookup records goes on THIS request's context,
 * where a tRPC context built from the request reads it (`getRequestCredential`).
 *
 * JSON round-tripped exactly as a server render's bootstrap is (`resolveSettingsBootstrapForRender`),
 * so the session procedures see is the one `_app` seeds a render's `req.session` with — dates as
 * ISO strings, not `Date`s.
 *
 * `res`: the REAL response where the session cookie may roll (the page data, which a viewer of a
 * shell page has no other request to roll it on), or `'read-only'` where it must not — a second
 * concurrent request rolling it too would mint a second cookie for the same viewer.
 */
export async function resolvePageDataSession(
  req: NextApiRequest,
  res: NextApiResponse | 'read-only'
) {
  const sessionRequest = settingsBootstrapRequest(req, {
    host: req.headers.host,
    context: ((req as { context?: Record<string, unknown> }).context ??= {}),
  });
  return jsonRoundTrip(
    bootstrapSession(
      await getServerAuthSession({
        req: sessionRequest,
        res: res === 'read-only' ? READ_ONLY_SESSION_RESPONSE : res,
      })
    )
  );
}
