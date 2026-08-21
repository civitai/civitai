import type { SessionUser } from '@civitai/auth';
import { canAccess } from './access';
import type { EndpointDoc } from './api-guard';
import { specToDoc, type EndpointAuth, type EndpointSpec } from './api-endpoint';

// THE API CATALOG — every `/api/**` endpoint in the app, read off the routes themselves. A docs page
// that drifts from the API is worse than no docs page: it is a list of calls that used to work.
//
// Deliberately app-wide rather than per-feature. The XGuard lab's guide is a FILTERED VIEW of this, so a
// second token-callable area needs a filter, not a second copy of the discovery logic.
//
// Server-only, and every caller must pass the VIEWER. Being a moderator is not enough to see the whole
// surface: a session endpoint is listed only to someone who could call it, because its `page` names a
// grant they may not hold. Unreadable-auth routes are withheld from everyone rather than guessed at.

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

// `_doc`, not `doc`: SvelteKit rejects any other export from a `+server.ts` at request time — a green
// typecheck and a 500 on every endpoint. Handlers built by $lib/server/api-endpoint carry `spec` instead,
// which is derived from the schema that actually validates the request.
type EndpointModule = { _doc?: EndpointDoc } & Record<string, unknown>;

// Lazy: importing the catalog must not drag every endpoint's services into whatever imports it. The
// modules load only when a page actually asks for the list.
const modules = import.meta.glob<EndpointModule>('/src/routes/api/**/+server.ts');

export type CatalogEntry = {
  path: string;
  methods: string[];
  doc: EndpointDoc | null;
  /** Null when the route predates $lib/server/api-endpoint and its auth cannot be read structurally. */
  auth: EndpointAuth | null;
};

function specOf(mod: EndpointModule, method: string): EndpointSpec | undefined {
  return (mod[method] as { spec?: EndpointSpec } | undefined)?.spec;
}

function visibleTo(user: SessionUser, auth: EndpointAuth | null): boolean {
  // A legacy route carries no readable auth, so listing it would be a claim we cannot support.
  if (!auth) return false;
  // WEBHOOK_TOKEN is a deployment secret, not a per-moderator grant: any moderator may read that these
  // endpoints exist, and none of them can call one from a browser anyway.
  if (auth.kind === 'webhook') return true;
  return canAccess(user, auth.page);
}

/**
 * @param user   the viewer; session endpoints they cannot reach are omitted.
 * @param prefix restrict to one area, e.g. `/api/xguard`. Omit for everything.
 */
export async function apiCatalog(user: SessionUser, prefix?: string): Promise<CatalogEntry[]> {
  const wanted = Object.entries(modules).filter(([file]) =>
    prefix ? file.startsWith(`/src/routes${prefix}`) : true
  );

  const entries = await Promise.all(
    wanted.map(async ([file, load]) => {
      const mod = await load();
      const methods = HTTP_METHODS.filter((m) => typeof mod[m] === 'function');
      const specced = methods.map((m) => specOf(mod, m)).find(Boolean);
      return {
        path: file.replace('/src/routes', '').replace('/+server.ts', ''),
        methods: [...methods],
        doc: specced ? specToDoc(specced) : mod._doc ?? null,
        auth: specced?.auth ?? null,
      };
    })
  );

  return entries
    .filter((e) => visibleTo(user, e.auth))
    .sort((a, b) => a.path.localeCompare(b.path));
}
