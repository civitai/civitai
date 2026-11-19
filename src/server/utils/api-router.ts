import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

/** A route path under its key, e.g. `homeblock/create`, to its lazily loaded module. */
export type ApiRoutes = Record<string, () => Promise<{ default: NextApiHandler }>>;

/**
 * The handler for `src/pages/api/<key>/[...path].ts`, which serves `src/server/api-routes/<key>/**` so each
 * route is not its own build entry. A route that needs its own `config` or a dynamic segment stays a file
 * in `src/pages/api/<key>`. Each route loads on its first request.
 */
export function createApiRouter(routes: ApiRoutes) {
  return async function apiRouter(req: NextApiRequest, res: NextApiResponse) {
    const { path, ...query } = req.query;
    const key = (path as string[]).join('/');
    // Own keys only: `constructor` or `__proto__` would otherwise resolve to an Object.prototype member.
    const load = Object.hasOwn(routes, key) ? routes[key] : undefined;
    if (!load) return res.status(404).json({ error: 'Not found' });
    req.query = query;
    const { default: handler } = await load();
    return handler(req, res);
  };
}
