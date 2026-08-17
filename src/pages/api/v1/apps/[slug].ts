import * as z from 'zod';
import { resolveStoreVisibilityScope } from '~/server/services/app-blocks-flag';
import { getListingDetail } from '~/server/services/blocks/app-listing.service';
import { recordStoreScopeApplied } from '~/server/prom/store-scope.metrics';
import { resolvePublicAppsCatalogScope } from '~/server/services/blocks/public-apps-catalog';
import { MixedAuthEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { enforceAppsCatalogRateLimit } from '~/server/utils/apps-catalog-rate-limit';
import { isHostForColor } from '~/server/utils/server-domain';
import { REST_ERROR_CODE, restErrorBody } from '~/server/utils/rest-error-envelope';

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
 * ## Visibility — a PUBLIC catalog, by decision
 * Same gate as the list endpoint: `resolveStoreVisibilityScope({ user })` is
 * computed, run through `resolvePublicAppsCatalogScope` (a privileged caller keeps
 * their own scope; everyone else gets the deliberate public grant, which an
 * operator can withhold), and the result is passed EXPLICITLY to the listing
 * service. A `none` scope — i.e. the grant withheld — yields 404, and a caller can
 * never enumerate a listing outside whatever scope they end up with.
 *
 * ## 404 posture
 * A missing slug, a non-approved listing, an onsite listing under
 * `public-external` scope, or a mature listing off a non-red host all resolve to
 * the SAME 404 as a genuinely absent app — no existence oracle.
 *
 * ## Error envelope — ONE shape for every non-2xx (civitai#3845)
 * 400 / 404 / 429 / 500 all carry `{ error, message, code }`:
 *   - `code` is the stable machine-readable discriminator a client branches on
 *     (`BAD_REQUEST` | `NOT_FOUND` | `TOO_MANY_REQUESTS` | `INTERNAL_SERVER_ERROR`),
 *     and is NEVER present on a 2xx.
 *   - `message` is always a string.
 *   - `error` is RETAINED with its historical per-status value — including the
 *     zod `.flatten()` OBJECT on 400, which the shipped Go CLI special-cases to
 *     render per-field errors. See `~/server/utils/rest-error-envelope`.
 * The 500 body is generic BY DESIGN: `handleEndpointError` must never place
 * driver text on this public, unauthenticated surface (#3845 leaked a Prisma
 * invocation with the table and column name). Attribution lives in the log.
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
    // `error` stays the zod flatten OBJECT — the shipped Go CLI special-cases
    // that exact shape (`{formErrors, fieldErrors}`) to render per-field errors.
    return res
      .status(400)
      .json(restErrorBody(REST_ERROR_CODE.BAD_REQUEST, 'Invalid slug', parsed.error.flatten()));
  }

  // Everything that can throw lives INSIDE the try. The rate limiter and the
  // scope gate used to sit outside it: both are `await`ed calls into Redis / the
  // Flipt client, and a throw from either would escape `handleEndpointError`
  // entirely — no envelope, no `code`, no fault log, just Next.js's default 500.
  // Neither has a known throw path today (the limiter catches its own Redis
  // errors and fails open; `isFlipt` swallows init + eval failures and returns
  // false), so this closes a STRUCTURAL gap rather than an observed bug — but
  // "no envelope on this path" should not depend on a dependency's internals
  // staying that defensive.
  try {
    const limited = await enforceAppsCatalogRateLimit({ req, res, user, log: req.log });
    if (limited) return;

    // DEFAULT-CLOSED scope gate — pass the resolved scope EXPLICITLY to the service.
    const rawScope: unknown = await resolveStoreVisibilityScope({ user });
    // See the sibling `index.ts` + store-scope.metrics: recorded BEFORE narrowing so
    // an ABSENT scope is distinguishable from a resolved one in production (#3983).
    recordStoreScopeApplied(rawScope as string | undefined, 'rest-detail');
    // The PUBLIC-CATALOG decision — see the sibling `index.ts` and
    // `~/server/services/blocks/public-apps-catalog`. Narrows first (#4041: an
    // absent scope is never an entitlement — it used to slip past this negative
    // test and meet `getListingDetail`'s `?? 'full'`), passes a privileged caller
    // through verbatim, then applies the deliberate public grant.
    const scope = await resolvePublicAppsCatalogScope(rawScope, 'rest-detail');
    if (scope === 'none') {
      return res.status(404).json(restErrorBody(REST_ERROR_CODE.NOT_FOUND, 'App not found'));
    }

    const detail = await getListingDetail(
      { slug: parsed.data.slug },
      { redCapable: isRedCapableRequest(req.headers.host), scope }
    );
    if (!detail) {
      return res.status(404).json(restErrorBody(REST_ERROR_CODE.NOT_FOUND, 'App not found'));
    }
    return res.status(200).json(detail);
  } catch (e) {
    return handleEndpointError(res, e);
  }
});
