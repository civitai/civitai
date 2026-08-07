import type { PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import type { EndpointDoc } from '$lib/server/api-guard';

// The endpoint list is READ OFF THE ROUTES, not maintained here. A docs page that drifts from the API
// is worse than no docs page: it is a list of calls that used to work. Adding a route adds a row;
// deleting one removes it; a route with no `doc` export shows up flagged rather than silently missing.

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

// `_doc`, not `doc`: SvelteKit rejects any other export from a `+server.ts` at request time — a green
// typecheck and a 500 on every endpoint.
type EndpointModule = { _doc?: EndpointDoc } & Record<string, unknown>;

const modules = import.meta.glob<EndpointModule>('/src/routes/api/xguard/**/+server.ts', {
  eager: true,
});

export type Endpoint = {
  path: string;
  methods: string[];
  doc: EndpointDoc | null;
};

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);

  const endpoints: Endpoint[] = Object.entries(modules)
    .map(([file, mod]) => ({
      path: file.replace(/^\/src\/routes/, '').replace(/\/\+server\.ts$/, ''),
      methods: HTTP_METHODS.filter((m) => typeof mod[m] === 'function'),
      doc: mod._doc ?? null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return { endpoints };
};
