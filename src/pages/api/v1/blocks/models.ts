import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  parseSubjectUserId,
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
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

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
 * Filters beyond the public endpoint's subset (all filters AND together):
 *
 *   owner=mine|any (default any) — `mine` lists the SIGNED-IN viewer's own models. The user id
 *     comes ONLY from the token's `sub` (`user:<id>`); an anonymous token gets 401, and no
 *     `userId` / `username` query param is read. It is a filter, not a viewer: the owner's
 *     unpublished models and Private-availability versions stay out, the maturity clamp and the
 *     rate limit apply unchanged. With `query`, the owner filter is applied inside Meilisearch too
 *     (`user.id`), otherwise the top-N hits across all users would be cut down to one user's
 *     afterwards and pages would come back sparse or empty.
 *     It deliberately does NOT reuse getModelsRaw's `username` filter, which serves profile pages:
 *     that one throws NotFound for an unknown name and has its own version-visibility rules.
 *     Every 200 echoes the applied mode as `metadata.owner` (`'mine'` or `'any'`; `'any'` when
 *     the param is absent). A response without `metadata.owner` came from a server that predates
 *     the param and ignored it, so its items are NOT owner-filtered.
 *
 *   modelVersionIds=1,2,3 — up to 100 positive ids; returns the models those versions belong to,
 *     each narrowed to the requested versions, so a block can rehydrate saved cards by id. Same
 *     clamp, Published-only and Public-only rules; a requested version that fails them is
 *     omitted, and a model left with no version is omitted. Send it WITHOUT `query`: a text
 *     query intersects the ids with that query's top-N Meilisearch hits, so a rehydrate that
 *     also carries `query` can come back sparse or empty.
 *
 * Every response keeps only Public-availability versions (`publicVersionsOnly`), whichever
 * filters are set. The block tool route (`blocks/tools.ts`, `search_models`) passes the same flag.
 *
 * NOTE (advisory until #2670 merges): the authoritative `maxBrowsingLevel`
 * claim is MINTED by PR #2670 (color-domain maturity). Until #2670 lands,
 * tokens carry no claim → the clamp's fail-closed branch resolves EVERY token
 * to SFW (the safe GA posture). The red-domain unclamp path activates
 * automatically once #2670's mint stamps the claim. This endpoint depends only
 * on `origin/main` primitives so it is not a stacked PR.
 */

const MAX_MODEL_VERSION_IDS = 100;
const PG_INT4_MAX = 2_147_483_647;

// Subset of the public endpoint's param schema — the fields an in-block model
// selector needs — plus the block-only `owner`. Maturity is intentionally
// ABSENT: it comes ONLY from the server-side clamp, never the client. (We don't even read `nsfw` /
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
  // Only the mode is read from the client. The user id behind `mine` comes from the token's
  // `sub`, and no `userId` / `username` param is declared, so one sent in the query is dropped.
  owner: z.enum(['mine', 'any']).default('any'),
  // `1,2,3`, or repeated single-id params (`a=1&a=2`; a comma list inside a repeated param is a
  // 400). Parsed with Number(), so `0x1f` / `1e3` are read as 31 / 1000. Each must be a positive
  // int4 (the column type, so an out-of-range id is a 400 here rather than a database error), at
  // most MAX_MODEL_VERSION_IDS of them.
  modelVersionIds: commaDelimitedNumberArray(
    z.number().int().positive().max(PG_INT4_MAX).array().max(MAX_MODEL_VERSION_IDS)
  ).optional(),
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

  // owner=mine: the id comes ONLY from the verified token subject.
  let ownerUserId: number | undefined;
  if (parsed.data.owner === 'mine') {
    let subjectUserId: number | null;
    try {
      subjectUserId = parseSubjectUserId(claims.sub);
    } catch {
      res.status(403).json({ error: 'Invalid subject claim' });
      return;
    }
    if (subjectUserId === null) {
      res.status(401).json({ error: 'Sign-in required' });
      return;
    }
    ownerUserId = subjectUserId;
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

  const { query, types, baseModels, sort, limit, cursor, supportsGeneration, modelVersionIds } =
    parsed.data;

  let searchIds: number[] = [];
  let meiliNextCursor: string | undefined;
  if (query) {
    try {
      const meili = await resolveModelSearchIds({
        query,
        cursor,
        limit,
        browsingLevel,
        types,
        ownerUserId,
        baseModels,
        supportsGeneration,
      });
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
        modelVersionIds,
        // The public endpoint lets the addon policy decide, which leaves minor
        // models visible under a SFW ceiling. Blocks stay strict on both axes.
        disableMinor: true,
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
        // Ownership is a FILTER here, never a viewer: the owner's own Private
        // and unpublished versions stay out exactly as for anyone else.
        ownerUserId,
        publicVersionsOnly: true,
      }
    );

    const effectiveNextCursor = query ? meiliNextCursor : nextCursor;
    const { nextPage } = getNextPage({ req, nextCursor: effectiveNextCursor });

    res.status(200).json({
      items,
      // `owner` echoes the filter this server APPLIED, so a client can tell an owner-filtered
      // page from one served by a server that does not know the param and ignored it.
      metadata: { nextCursor: effectiveNextCursor, nextPage, owner: parsed.data.owner },
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
export default withBlockScope(baseHandler, {
  endpoint: 'models',
  allowOpaqueOrigin: true,
  // Public, maturity-clamped catalog read. No requiredScope, no context binding, nothing
  // scoped to the viewer and nothing written — a suspended app reaching this handler on an
  // unreachable replica obtains public data clamped by a ceiling the TOKEN carries, which
  // does not depend on the approval row. Refusing removes no takedown path; it only turns
  // a replica blip into a fleet-wide 503 for a body that is public anyway.
  onApprovalLookupFailure: 'serve',
});
