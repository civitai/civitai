import * as z from 'zod';
import { getAppListingsListQuery } from '~/server/schema/blocks/app-listing-read.schema';
import { resolveStoreVisibilityScope } from '~/server/services/app-blocks-flag';
import { listAvailableListings } from '~/server/services/blocks/app-listing.service';
import { recordStoreScopeApplied } from '~/server/prom/store-scope.metrics';
import { resolvePublicAppsCatalogScope } from '~/server/services/blocks/public-apps-catalog';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { enforceAppsCatalogRateLimit } from '~/server/utils/apps-catalog-rate-limit';
import { getNextPage } from '~/server/utils/pagination-helpers';
import { isHostForColor } from '~/server/utils/server-domain';
import { REST_ERROR_CODE, restErrorBody } from '~/server/utils/rest-error-envelope';

/**
 * GET /api/v1/apps
 *
 * PUBLIC, stable REST list/search of PUBLISHED App-Block listings — the REST
 * front for the unified `/apps` marketplace (which is otherwise tRPC-only). It
 * backs a CLI app-discovery command: a client can enumerate + filter published
 * apps over the same `/api/v1/*` contract the rest of the CLI already speaks.
 *
 * ## Auth — OPTIONAL bearer (anon-capable)
 * `MixedAuthEndpoint` resolves the caller from an `Authorization: Bearer` token
 * when one is present (via the same session path every `/api/v1/*` endpoint
 * uses) and otherwise proceeds as anonymous. An absent / invalid / expired token
 * is simply treated as anonymous — NEVER a hard error.
 *
 * ## Visibility — a PUBLIC catalog, by decision (the security crux)
 * The caller's own scope comes from `resolveStoreVisibilityScope({ user })` — the
 * SAME helper the store tRPC read middleware uses — and is then passed through
 * `resolvePublicAppsCatalogScope`, which produces the scope handed EXPLICITLY to
 * the listing service:
 *   - a privileged caller (moderator / app-dev-tester → `full`, the external-only
 *     cohort → `public-external`) keeps their own scope, verbatim;
 *   - everyone else, INCLUDING an anonymous caller, gets the deliberate public
 *     catalog grant (`~/server/services/blocks/public-apps-catalog`), which an
 *     operator can withhold with a kill switch;
 *   - withheld → empty page.
 *
 * 🔴 The scope is NARROWED before any of that (`narrowStoreScope`, inside the
 * decision), and the listing service defaults an absent scope to `none` rather than
 * `full`. Both are civitai#3983: on the serving build this endpoint received NO
 * scope at all for an anonymous caller, the old `scope === 'none'` negative test
 * admitted it, and the service's old `?? 'full'` turned that missing value into the
 * whole approved catalog. The exploit was NOT that the catalog is public — that is
 * intended — it was that an ABSENT scope bought MORE than a resolved `none` did.
 * That is closed: absent and `none` are now the same input to the same decision, so
 * no failure of the resolver can widen this endpoint beyond what the public grant
 * already, deliberately, allows.
 *
 * 🔴 This endpoint's public reach is deliberately NOT expressed as a store flag.
 * `appListings` / `appBlocks` / `appListingsPublicExternal` also gate the `/apps`
 * PAGE through `hasAppsStoreAccess`, so granting public REST access through one of
 * them would launch the store. See the module doc for the full reasoning.
 *
 * ## Response — the standard paginated `/api/v1` envelope
 * `{ items: ListingCard[], metadata: { nextCursor, nextPage } }` — keyset cursor
 * pagination (NOT page/offset), so the client's existing cursor machinery works
 * unchanged.
 *
 * ## Filters (only what the store service actually supports)
 * `kind` (all|onsite|offsite), `category`, `sort` (top-rated|popular|newest|
 * name), `cursor`, `limit` (1..50). NOTE: the store service exposes no free-text
 * search or slot filter, so this endpoint intentionally does not accept a
 * `query`/`slot` param (they'd be inert).
 */

/** Single query-param value (Next gives `string | string[] | undefined`); '' → undefined. */
function firstQuery(v: string | string[] | undefined): string | undefined {
  const first = Array.isArray(v) ? v[0] : v;
  return first === '' ? undefined : first;
}

/** RED-capable host membership test — mirrors the store router's maturity gate. */
function isRedCapableRequest(host: string | undefined): boolean {
  return !!host && host !== '' && isHostForColor(host, 'red');
}

const querySchema = getAppListingsListQuery();

export default MixedAuthEndpoint(async function handler(req, res, user) {
  const parsed = querySchema.safeParse({
    kind: firstQuery(req.query.kind),
    category: firstQuery(req.query.category),
    sort: firstQuery(req.query.sort),
    cursor: firstQuery(req.query.cursor),
    limit: firstQuery(req.query.limit),
  });
  if (!parsed.success) {
    // Sibling of `[slug].ts` — same shared envelope (civitai#3845). `error`
    // stays the zod flatten OBJECT, which the shipped Go CLI special-cases.
    return res
      .status(400)
      .json(restErrorBody(REST_ERROR_CODE.BAD_REQUEST, 'Invalid query', parsed.error.flatten()));
  }

  // Same try-scope discipline as the sibling `[slug].ts`: the rate limiter and the
  // scope gate are `await`ed calls into Redis / the Flipt client, so a throw from
  // either must land in `handleEndpointError` rather than escaping to Next.js's
  // default 500 (no envelope, no fault log). Structural — neither has a known
  // throw path today.
  try {
    const limited = await enforceAppsCatalogRateLimit({ req, res, user, log: req.log });
    if (limited) return;

    // DEFAULT-CLOSED scope gate — pass the resolved scope EXPLICITLY to the service.
    const rawScope: unknown = await resolveStoreVisibilityScope({ user });
    // Record what this entry point actually branched on, BEFORE narrowing — an
    // ABSENT scope must stay distinguishable from a resolved `none` in production
    // (see store-scope.metrics; civitai#3983).
    recordStoreScopeApplied(rawScope as string | undefined, 'rest-list');
    // The PUBLIC-CATALOG decision. It narrows first (#4041's fail-closed rule —
    // anything uninterpretable becomes `none`, never an entitlement), passes a
    // privileged caller through verbatim, and then applies the DELIBERATE public
    // grant to everyone else. See `~/server/services/blocks/public-apps-catalog`
    // for why that grant lives in its own module and is NOT a store flag: the
    // store flags gate the `/apps` PAGE too, and this endpoint being public must
    // not launch the store.
    const scope = await resolvePublicAppsCatalogScope(rawScope, 'rest-list');
    if (scope === 'none') {
      // The public grant is withheld (operator kill switch) → empty page.
      return res
        .status(200)
        .json({ items: [], metadata: { nextCursor: undefined, nextPage: undefined } });
    }

    const { items, nextCursor } = await listAvailableListings(parsed.data, {
      redCapable: isRedCapableRequest(req.headers.host),
      scope,
    });
    const { nextPage } = getNextPage({ req, nextCursor });
    return res.status(200).json({ items, metadata: { nextCursor, nextPage } });
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
