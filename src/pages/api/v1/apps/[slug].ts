import * as z from 'zod';
import { resolveStoreVisibilityScope } from '~/server/services/app-blocks-flag';
import { getListingDetail } from '~/server/services/blocks/app-listing.service';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { enforceAppsCatalogRateLimit } from '~/server/utils/apps-catalog-rate-limit';
import { isHostForColor } from '~/server/utils/server-domain';

/**
 * GET /api/v1/apps/{slug}
 *
 * PUBLIC, stable REST detail (card fields + gallery + manifest-derived action
 * data) for ONE published App-Block listing, by slug — the REST front for the
 * otherwise tRPC-only per-app store detail. Backs the CLI's app-view command.
 *
 * ## Auth — OPTIONAL bearer (anon-capable)
 * `MixedAuthEndpoint` resolves the caller from an `Authorization: Bearer` token
 * when present and otherwise proceeds anonymous; an absent / invalid / expired
 * token is treated as anonymous, never a hard error.
 *
 * ## Visibility — per-user SCOPE, DEFAULT CLOSED
 * Same gate as the list endpoint: `resolveStoreVisibilityScope({ user })` is
 * computed and passed EXPLICITLY to the listing service. A `none` scope (anon /
 * non-privileged, pre-launch default) yields 404 — a caller can never enumerate
 * a listing outside their scope, and the boundary AUTO-WIDENS with the same
 * marketplace flag the store UI keys on (no code change here).
 *
 * ## 404 posture
 * A missing slug, a non-approved listing, an onsite listing under
 * `public-external` scope, or a mature listing off a non-red host all resolve to
 * the SAME 404 as a genuinely absent app — no existence oracle.
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

const slugSchema = z.object({ slug: z.string().min(1).max(64) });

export default MixedAuthEndpoint(async function handler(req, res, user) {
  const parsed = slugSchema.safeParse({ slug: firstQuery(req.query.slug) });
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const limited = await enforceAppsCatalogRateLimit({ req, res, user, log: req.log });
  if (limited) return;

  // DEFAULT-CLOSED scope gate — pass the resolved scope EXPLICITLY to the service.
  const scope = await resolveStoreVisibilityScope({ user });
  if (scope === 'none') {
    return res.status(404).json({ error: 'App not found' });
  }

  try {
    const detail = await getListingDetail(
      { slug: parsed.data.slug },
      { redCapable: isRedCapableRequest(req.headers.host), scope }
    );
    if (!detail) {
      return res.status(404).json({ error: 'App not found' });
    }
    return res.status(200).json(detail);
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
