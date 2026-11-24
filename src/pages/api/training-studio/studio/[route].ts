import {
  forwardToStudio,
  sessionCookiesOf,
  STUDIO_FORWARD_ROUTES,
} from '~/server/services/training-studio-forward.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';

// The Studio's own limit on a request body (BODY_SIZE_LIMIT in apps/training-studio/Dockerfile).
export const config = { api: { bodyParser: { sizeLimit: '16mb' } } };

/**
 * The embedded Training Studio's `studioServer` hook (docs/training-studio-web-component.md):
 * forwards one of the Studio's training routes, `/api/<route>`, to the Studio's server as this user.
 * Answers with the Studio's status and JSON body only.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    res.setHeader('Cache-Control', 'no-store');
    const route = req.query.route;
    const methods = typeof route === 'string' ? STUDIO_FORWARD_ROUTES[route] : undefined;
    if (typeof route !== 'string' || !Object.hasOwn(STUDIO_FORWARD_ROUTES, route) || !methods)
      return res.status(404).json({ error: 'Not found' });
    if (!methods.includes(req.method ?? ''))
      return res.status(405).json({ error: 'Method not allowed' });
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json'))
      return res.status(415).json({ error: 'Expected JSON' });

    if (!(await allowTrainingStudio(req, res, user))) return;

    const sessionCookies = sessionCookiesOf(req.headers.cookie, req.headers.host);
    if (!sessionCookies) return res.status(401).json({ message: 'Sign in again to continue.' });

    // The query minus the route segment Next adds to it.
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'route') continue;
      for (const v of Array.isArray(value) ? value : [value])
        if (v !== undefined) params.append(key, v);
    }
    const search = params.size ? `?${params}` : '';

    const { status, body } = await forwardToStudio({
      route,
      method: req.method!,
      search,
      body: req.method === 'POST' ? req.body : undefined,
      sessionCookies,
    });
    return res.status(status).json(body);
  },
  ['GET', 'POST']
);
