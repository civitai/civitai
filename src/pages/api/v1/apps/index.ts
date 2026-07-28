import * as z from 'zod';
import { getAppListingsListQuery } from '~/server/schema/blocks/app-listing-read.schema';
import { resolveStoreVisibilityScope } from '~/server/services/app-blocks-flag';
import { listAvailableListings } from '~/server/services/blocks/app-listing.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { enforceAppsCatalogRateLimit } from '~/server/utils/apps-catalog-rate-limit';
import { getNextPage } from '~/server/utils/pagination-helpers';
import { isHostForColor } from '~/server/utils/server-domain';

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
 * ## Visibility — per-user SCOPE, DEFAULT CLOSED (the security crux)
 * The catalog is gated by `resolveStoreVisibilityScope({ user })` — the SAME
 * helper the store tRPC read middleware uses — and its result is passed
 * EXPLICITLY to the listing service. The service is scope-parametric and
 * defaults to `full`, so the scope MUST be threaded through: never let an
 * unscoped caller fall through to the full catalog.
 *   - `none`            → empty page (anon / non-privileged, pre-launch default).
 *   - `full`            → the whole approved catalog (mods + app-dev-testers).
 *   - `public-external` → offsite listings only (once the public flag opens).
 * This AUTO-WIDENS for everyone the instant the marketplace Flipt segment opens,
 * with no code change here — the endpoint defers to the same flag the store UI
 * keys on.
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
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const limited = await enforceAppsCatalogRateLimit({ req, res, user, log: req.log });
  if (limited) return;

  // DEFAULT-CLOSED scope gate — pass the resolved scope EXPLICITLY to the service.
  const scope = await resolveStoreVisibilityScope({ user });
  if (scope === 'none') {
    // Anon / non-privileged pre-launch → empty page, NEVER the full catalog.
    return res.status(200).json({ items: [], metadata: { nextCursor: undefined, nextPage: undefined } });
  }

  try {
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
