import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getNextPage } from '~/server/utils/pagination-helpers';
import {
  ModelSearchMeiliTimeoutError,
  resolveModelSearchIds,
  runModelSearch,
} from '~/server/services/model-search.service';
import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { ModelSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { constants } from '~/server/common/constants';

/**
 * GET /api/v1/blocks/models
 *
 * Block-token-gated catalog search for App Blocks (Phase 3 maturity clamp;
 * GA-safety follow-up to PR #2670). Returns the SAME response shape as the
 * public /api/v1/models (it shares `runModelSearch`), so an in-block model
 * selector can switch endpoints with minimal change. The CRITICAL difference:
 *
 *   The effective browsing level is AUTHORITATIVELY CLAMPED to the block
 *   token's color-domain ceiling (`claims.maxBrowsingLevel`). A SFW-domain
 *   (green/blue) block CANNOT fetch mature catalog content, no matter what the
 *   client sends — `nsfw=true` / `browsingLevel=31` / a body maturity field are
 *   all ignored beyond the clamp.
 *
 * Why Option B (a block-gated endpoint) and NOT clamping the public
 * /api/v1/models: the public endpoint is the apex public-API contract +
 * Cloudflare-cached by query key, so domain-clamping it would break the
 * contract and risk cache poisoning (one domain's clamped view served to
 * another). withBlockScope already forces `Cache-Control: private, no-store`
 * + exact-origin CORS on this route, so there is no cache-key / cross-domain
 * leak here.
 *
 * Auth: ANY valid block token (no required scope). The catalog is PUBLIC,
 * maturity-clamped data, so a specific declarable+grantable scope adds friction
 * (the Go CLI manifest validator must allow it + each app's
 * OauthClient.allowedScopes would need the bit) with ZERO security value — this
 * endpoint is strictly MORE restricted than the public /api/v1/models. The
 * token is required ONLY for its signed `maxBrowsingLevel` claim (the
 * authoritative maturity ceiling), NOT for authorization. withBlockScope still
 * runs the FULL token validation + revocation + `private, no-store` +
 * exact-origin CORS; it just skips the per-scope check. Anon (no token) → 401.
 * (Previously gated on `catalog:read`, retired as no-value friction.)
 *
 * NOTE (advisory until #2670 merges): the authoritative `maxBrowsingLevel`
 * claim is MINTED by PR #2670 (color-domain maturity). Until #2670 lands,
 * tokens carry no claim → the clamp's fail-closed branch resolves EVERY token
 * to SFW (the safe GA posture). The red-domain unclamp path activates
 * automatically once #2670's mint stamps the claim. This endpoint depends only
 * on `origin/main` primitives so it is not a stacked PR.
 */

// Subset of the public endpoint's param schema — the fields an in-block model
// selector needs. Maturity is intentionally ABSENT: it comes ONLY from the
// server-side clamp, never the client. (We don't even read `nsfw` /
// `browsingLevel` from the query — see the clamp below.)
const blockModelsSchema = z.object({
  query: z.string().optional(),
  types: z
    .union([z.string(), z.string().array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel])),
  baseModels: z
    .union([z.string(), z.string().array()])
    .optional()
    .transform((rel) => (!rel ? undefined : Array.isArray(rel) ? rel : [rel])),
  sort: z.enum(ModelSort).optional(),
  limit: z.preprocess((val) => Number(val ?? 100), z.number().min(1).max(100)).default(100),
  cursor: z.string().optional(),
  supportsGeneration: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // withBlockScope only invokes this handler with a valid block JWT; this is
    // defense in depth.
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  const parsed = blockModelsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  // Per-token rate limit (keyed on the stable blockInstanceId) — bounds a block
  // hammering this private,no-store (Cloudflare-uncacheable) catalog route onto
  // the origin. Fail-open + generous enough that a paginating selector never
  // trips it (see block-catalog-rate-limit.ts). Runs BEFORE the expensive search.
  const rateLimit = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  // AUTHORITATIVE clamp — maturity comes ONLY from the token's domain ceiling,
  // then narrowed to SFW for region-restricted viewers (mirrors the public
  // /api/v1/models region override the shared search service does NOT apply).
  const regionRestricted = isRegionRestricted(getRegion(req));
  const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel(claims, { regionRestricted });

  const { query, types, baseModels, sort, limit, cursor, supportsGeneration } = parsed.data;

  let searchIds: number[] = [];
  let meiliNextCursor: string | undefined;
  if (query) {
    try {
      const meili = await resolveModelSearchIds({ query, cursor, limit, browsingLevel });
      searchIds = meili.searchIds;
      meiliNextCursor = meili.nextCursor;
    } catch (e) {
      if (e instanceof ModelSearchMeiliTimeoutError) {
        res.setHeader('Retry-After', '2');
        res.status(503).json({ error: e.message });
        return;
      }
      throw e;
    }
  }

  try {
    const baseUrlOrigin = getNextPage({ req }).baseUrl.origin;

    const { items, nextCursor } = await runModelSearch(
      {
        types: types as never,
        baseModels,
        // sort/period drive orderBy + metric-key construction in getModelsRaw;
        // default them so the selector subset behaves like the public endpoint.
        sort: (sort ?? constants.modelFilterDefaults.sort) as never,
        period: MetricTimeframe.AllTime,
        supportsGeneration,
        limit,
        cursor: !query ? cursor : undefined,
        query,
        searchIds,
      },
      {
        // CLAMPED browsing level — never the client's. nsfwImagePassthrough is
        // false so the per-image filter is driven SOLELY by the clamped level
        // (a SFW ceiling can never surface a mature cover image).
        browsingLevel,
        nsfwImagePassthrough: false,
        // The viewer (sub) is intentionally NOT threaded as a session user:
        // catalog is public + the clamp is the whole authority surface. Passing
        // the block subject as `user` would risk surfacing favorites/hidden
        // personalization the block never asked for.
        user: undefined,
        baseUrlOrigin,
      }
    );

    const effectiveNextCursor = query ? meiliNextCursor : nextCursor;
    const { nextPage } = getNextPage({ req, nextCursor: effectiveNextCursor });

    res.status(200).json({
      items,
      metadata: { nextCursor: effectiveNextCursor, nextPage },
      // Echo the applied ceiling so the in-block selector can render an honest
      // "SFW only" affordance. Advisory only — the clamp is authoritative.
      maturity: { browsingLevel, sfwOnly: isSfwCeiling },
    });
    return;
  } catch (e) {
    handleEndpointError(res, e);
    return;
  }
});

// No requiredScope: any valid block token is accepted (see doc above). The
// maturity clamp (resolveCatalogBrowsingLevel) remains the whole authority
// surface. allowOpaqueOrigin: an UNVERIFIED block runs at an opaque origin
// (`Origin: null`) so its direct catalog fetch needs `ACAO: null` to clear the
// CORS preflight; safe here (public maturity-clamped data, no credentials,
// still token-gated) — see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, { allowOpaqueOrigin: true });
