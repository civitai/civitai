import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import dayjs from '~/shared/utils/dayjs';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { runImageSearch } from '~/server/services/image-search.service';
import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { getNextPage, getPagination } from '~/server/utils/pagination-helpers';
import {
  isFailfastStatus,
  MeiliCallTimeoutError,
  MeilisearchFetchError,
} from '~/server/meilisearch/client';
import { isClientAbortError } from '~/server/utils/errorHandling';
import {
  acquireBulkheadSlot,
  BulkheadFullError,
  HEAVY_REQUEST_CONCURRENCY,
} from '~/server/utils/request-bulkhead';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { usernameSchema } from '~/shared/zod/username.schema';
import {
  booleanString,
  commaDelimitedEnumArray,
  commaDelimitedNumberArray,
  numericString,
} from '~/utils/zod-helpers';

export const config = {
  api: {
    responseLimit: false,
  },
};

/**
 * GET /api/v1/blocks/images
 *
 * Block-token-gated catalog IMAGE search for App Blocks (Phase 3 maturity
 * clamp; GA-safety follow-up to PR #2670). The sibling of
 * /api/v1/blocks/models — closes the /api/v1/images mature-content surface for
 * blocks the same way blocks/models closed /api/v1/models. Returns the SAME
 * response shape as the public /api/v1/images (it shares `runImageSearch`), so
 * an in-block image browser can switch endpoints with minimal change. The
 * CRITICAL difference:
 *
 *   The effective browsing level is AUTHORITATIVELY CLAMPED to the block
 *   token's color-domain ceiling (`claims.maxBrowsingLevel`). A SFW-domain
 *   (green/blue) block CANNOT fetch mature catalog images, no matter what the
 *   client sends — there is no `nsfw` / `browsingLevel` knob on this endpoint's
 *   schema at all, so maturity is NEVER read from the request beyond the clamp.
 *
 * Why Option B (a block-gated endpoint) and NOT clamping the public
 * /api/v1/images: the public endpoint is the apex public-API contract +
 * region/Cloudflare-shaped, so domain-clamping it would break the contract and
 * risk cache poisoning. withBlockScope already forces `Cache-Control: private,
 * no-store` + exact-origin CORS on this route, so there is no cache-key /
 * cross-domain leak here.
 *
 * Auth: ANY valid block token (no required scope) — the SAME mode
 * blocks/models uses. The catalog is PUBLIC, maturity-clamped data, so a
 * declarable+grantable scope adds CLI-validator + per-app-allowedScopes
 * friction with NO security value (this endpoint is strictly MORE restricted
 * than the public /api/v1/images). The token is required ONLY for its signed
 * `maxBrowsingLevel` claim (the maturity ceiling), NOT for authorization.
 * withBlockScope still runs FULL token validation + revocation + `private,
 * no-store` + exact-origin CORS; it just skips the per-scope check. Anon → 401.
 * (Previously gated on `catalog:read`, retired as no-value friction.)
 *
 * NOTE (advisory until #2670 merges): the authoritative `maxBrowsingLevel`
 * claim is MINTED by PR #2670. Until then every token resolves to SFW here (the
 * safe GA posture, via the shared clamp's fail-closed branch). The red-domain
 * unclamp path activates automatically once #2670's mint stamps the claim.
 *
 * Image maturity mechanism note: unlike the model endpoint (which had a
 * separate `?nsfw=` image-list passthrough), the per-image `nsfwLevel` filter
 * applied by the getAllImages / getAllImagesIndex / feed-search paths is driven
 * SOLELY by `browsingLevel`. So clamping `browsingLevel` is the whole authority
 * surface — there is no passthrough flag that could re-widen images past the
 * clamp.
 */

// Subset of the public /api/v1/images param schema — the fields an in-block
// image browser needs. Maturity (`nsfw` / `browsingLevel`) is intentionally
// ABSENT: it comes ONLY from the server-side clamp, never the client.
const blockImagesSchema = z.object({
  limit: numericString(z.number().min(0).max(200)).default(constants.galleryFilterDefaults.limit),
  page: numericString().optional(),
  postId: numericString().optional(),
  modelId: numericString().optional(),
  modelVersionId: numericString().optional(),
  imageId: numericString().optional(),
  username: usernameSchema.optional(),
  userId: numericString().optional(),
  period: z.enum(MetricTimeframe).default(constants.galleryFilterDefaults.period),
  sort: z.enum(ImageSort).default(constants.galleryFilterDefaults.sort),
  tags: commaDelimitedNumberArray().optional(),
  cursor: z
    .union([z.bigint(), z.number(), z.string(), z.date()])
    .transform((val) =>
      typeof val === 'string' && dayjs(val, 'YYYY-MM-DDTHH:mm:ss.SSS[Z]', true).isValid()
        ? new Date(val)
        : val
    )
    .optional(),
  type: z.enum(MediaType).optional(),
  baseModels: commaDelimitedEnumArray([...baseModels]).optional(),
  withMeta: booleanString().default(false),
  requiringMeta: booleanString().optional(),
  flatMeta: booleanString().optional(),
  withTags: booleanString().default(false),
});

type Metadata = {
  currentPage?: number;
  pageSize?: number;
  nextCursor?: string;
  nextPage?: string;
};

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

  const reqParams = blockImagesSchema.safeParse(req.query);
  if (!reqParams.success) {
    res.status(400).json({ error: reqParams.error });
    return;
  }

  // Per-token rate limit (keyed on the stable blockInstanceId) — bounds a block
  // hammering this private,no-store (Cloudflare-uncacheable) catalog route onto
  // the origin. Fail-open + generous enough that a paginating image browser
  // never trips it (see block-catalog-rate-limit.ts). Runs BEFORE the bulkhead
  // slot + the expensive image search. Mirrors the 429+Retry-After shape this
  // endpoint already returns for the paging guard / bulkhead shed.
  const rateLimit = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  // AUTHORITATIVE clamp — maturity comes ONLY from the token's domain ceiling,
  // then narrowed to SFW for region-restricted viewers (mirrors the public
  // /api/v1/images region override the shared search service does NOT apply).
  // (The schema doesn't even expose nsfw/browsingLevel, so there is nothing to
  // read from the request; this is the single maturity authority.)
  const regionRestricted = isRegionRestricted(getRegion(req));
  const { browsingLevel } = resolveCatalogBrowsingLevel(claims, { regionRestricted });

  const { limit, page, cursor, type, withMeta, flatMeta, withTags, ...data } = reqParams.data;

  // Mirror the public endpoint's paging guard + skip math exactly.
  let skip: number | undefined;
  const usingPaging = page && !cursor;
  if (usingPaging) {
    if (page && page * limit > 1000) {
      res
        .status(429)
        .json({ error: "You've requested too many pages, please use cursors instead" });
      return;
    }
    ({ skip } = getPagination(limit, page));
  }

  // Per-pod heavy-image concurrency cap — same bulkhead key the public endpoint
  // and the tRPC feed share, so block traffic can't sneak past the shed.
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = acquireBulkheadSlot('heavy-image', HEAVY_REQUEST_CONCURRENCY);
  } catch (e) {
    if (e instanceof BulkheadFullError) {
      res.setHeader('Retry-After', '2');
      res.status(503).json({ error: 'Server busy, please retry shortly.' });
      return;
    }
    throw e;
  }

  try {
    const { items, nextCursor } = await runImageSearch(
      { limit, skip, cursor, type, withMeta, flatMeta, withTags, data },
      {
        // CLAMPED browsing level — never the client's. The per-image filter is
        // driven solely by this; a SFW ceiling can never surface a mature image.
        browsingLevel,
        // The viewer is intentionally NOT threaded as a session user: the
        // catalog is public + the clamp is the whole authority surface (mirrors
        // blocks/models — don't surface owner-personalization the block never
        // asked for).
        user: undefined,
        req,
      }
    );

    const metadata: Metadata = { nextCursor };
    if (usingPaging) {
      metadata.currentPage = page;
      metadata.pageSize = limit;
    }
    metadata.nextPage = getNextPage({ req, ...metadata }).nextPage;

    res.status(200).json({ items, metadata });
    return;
  } catch (error) {
    // Mirror the public endpoint's error mapping so the block selector sees the
    // same 499/503/<trpc-status> contract.
    if (isClientAbortError(error)) {
      if (!res.headersSent) res.status(499).end();
      return;
    }
    if (
      error instanceof MeiliCallTimeoutError ||
      (error instanceof MeilisearchFetchError && isFailfastStatus(error.status))
    ) {
      if (!res.headersSent) {
        res.setHeader('Retry-After', '2');
        res
          .status(503)
          .json({ error: 'Image search is temporarily overloaded — please retry.' });
      }
      return;
    }
    const trpcError = error as TRPCError;
    const statusCode = getHTTPStatusCodeFromError(trpcError);
    res.status(statusCode).json({ error: trpcError.message, code: trpcError.code });
    return;
  } finally {
    releaseSlot?.();
  }
});

// No requiredScope: any valid block token is accepted (see doc above). The
// maturity clamp (resolveCatalogBrowsingLevel) remains the whole authority
// surface. allowOpaqueOrigin: an UNVERIFIED block runs at an opaque origin
// (`Origin: null`) so its direct catalog fetch needs `ACAO: null` to clear the
// CORS preflight; safe here (public maturity-clamped data, no credentials,
// still token-gated) — see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, { allowOpaqueOrigin: true });
