import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getResourceData } from '~/server/services/generation/generation.service';
import {
  resolveCatalogBrowsingLevel,
  resourceExceedsCatalogCeiling,
} from '~/server/utils/block-catalog-maturity';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { projectSafeGenerationResource } from '~/server/schema/blocks/generation-resource-projection';

/**
 * GET /api/v1/blocks/generation-resources?ids=1,2,3
 *
 * App Blocks (Phase-2a PR-C) — block-token-gated REHYDRATE of generation resources
 * by version id. When a block loads a saved set of resources it holds only the
 * picked modelVersionIds; this endpoint returns the SAME public "safe subset" the
 * OPEN_RESOURCE_PICKER result carries (`projectSafeGenerationResource`) for those
 * ids, WITHOUT re-opening the picker. It never returns availability / hasAccess /
 * usageControl / early-access / minor / poi / sfwOnly / cover-image internals —
 * only the public recommended settings + trained words a block renders.
 *
 * Mirrors /api/v1/blocks/models EXACTLY on auth + maturity:
 *   - withBlockScope (any valid block JWT, no required scope — like models.ts,
 *     the token is needed ONLY for its signed `maxBrowsingLevel` clamp), forcing
 *     `private, no-store` + exact-origin CORS. `allowOpaqueOrigin` so an unverified
 *     block at `Origin: null` clears the preflight (public, maturity-clamped data,
 *     no credentials, still token-gated).
 *   - The effective browsing level is AUTHORITATIVELY CLAMPED to the token's
 *     `maxBrowsingLevel` ceiling; a SFW-domain block never gets a mature resource's
 *     data back (resourceExceedsCatalogCeiling drops them). `ids` is bounded (≤30).
 */

const MAX_IDS = 30;

const generationResourcesSchema = z.object({
  ids: z
    .union([z.string(), z.string().array()])
    .transform((rel) => (Array.isArray(rel) ? rel : rel.split(',')))
    // Split comma lists, coerce to positive ints, drop junk, de-dupe, cap count.
    .transform((arr) =>
      Array.from(
        new Set(
          arr
            .flatMap((s) => String(s).split(','))
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n > 0)
        )
      )
    )
    .refine((arr) => arr.length > 0, { message: 'ids is required' })
    .refine((arr) => arr.length <= MAX_IDS, { message: `at most ${MAX_IDS} ids` }),
});

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // withBlockScope only invokes this handler with a valid block JWT; defense in depth.
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  const parsed = generationResourcesSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  // Per-token rate limit (keyed on the stable blockInstanceId), same as the other
  // block catalog endpoints — bounds a block hammering this private,no-store route.
  const rateLimit = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  const regionRestricted = isRegionRestricted(getRegion(req));
  const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel(claims, { regionRestricted });

  try {
    // Anon read (like models.ts, the viewer is NOT threaded — the clamp is the
    // whole authority surface; personalization would leak favorites/hidden prefs).
    const resources = await getResourceData(parsed.data.ids);

    const items = resources
      // PUBLIC-ONLY gate: getResourceData's backing fetch has NO status/availability
      // filter — it returns name/trainedWords/baseModel for ANY version id incl.
      // Draft/Training/Private/Unpublished, merely setting hasAccess=false. Dropping
      // !hasAccess here prevents a block-token holder from harvesting names + trigger
      // words of non-public versions by enumerating ids. The computed `hasAccess`
      // (anon read) encodes "Published & Public".
      .filter((r) => r.hasAccess)
      // Maturity clamp: on a SFW ceiling, drop any resource that exceeds the clamped
      // browsing level (never leak a mature resource's public data to a SFW-domain
      // block). `model.nsfw` is the ACTIVE clamp signal in this path; `imageNsfwLevel`
      // is passed defensively (getResourceData does not populate a cover image here,
      // so it is typically undefined — kept so a future cover level is honored).
      .filter(
        (r) =>
          !isSfwCeiling ||
          !resourceExceedsCatalogCeiling(
            { imageNsfwLevel: r.image?.nsfwLevel, modelNsfw: r.model.nsfw },
            browsingLevel
          )
      )
      .map((r) => projectSafeGenerationResource(r));

    res.status(200).json({
      items,
      // Echo the applied ceiling (advisory — the clamp is authoritative).
      maturity: { browsingLevel, sfwOnly: isSfwCeiling },
    });
    return;
  } catch (e) {
    handleEndpointError(res, e);
    return;
  }
});

// No requiredScope: any valid block token (see doc above + models.ts). allowOpaqueOrigin
// so an unverified block's direct fetch (Origin: null) clears the CORS preflight;
// safe here (public maturity-clamped data, no credentials, still token-gated).
export default withBlockScope(baseHandler, {
  endpoint: 'generation_resources',
  allowOpaqueOrigin: true,
});
