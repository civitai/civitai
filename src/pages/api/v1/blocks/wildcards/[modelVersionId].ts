import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import {
  getWildcardPackContent,
  MAX_PACK_FILE_KB,
} from '~/server/services/blocks/wildcard-pack.service';

/**
 * GET /api/v1/blocks/wildcards/[modelVersionId]
 *
 * Block-token-gated wildcard-pack CONTENT for App Blocks (WILDCARD_PACK_SPEC).
 * Reads the published pack archive server-side, parses it, and returns clean
 * capped JSON lists — because the sandboxed iframe (opaque origin) cannot
 * fetch pack files itself (no CORS on the signed storage URLs for
 * `Origin: null`, anon 401s, no session cookies). Only parsed, capped,
 * text-only JSON ever reaches the block; never raw file/zip bytes.
 *
 * Mirrors /api/v1/blocks/models EXACTLY on auth + maturity:
 *   - withBlockScope, ANY valid block token (no required scope — same rationale
 *     as models.ts: public data, the token is needed only for its signed
 *     `maxBrowsingLevel` clamp), forcing `private, no-store` + exact-origin
 *     CORS; `allowOpaqueOrigin` so an unverified block at `Origin: null`
 *     clears the preflight.
 *   - checkBlockCatalogRateLimit BEFORE any db/storage work.
 *   - The pack's `model.nsfwLevel` must fit entirely inside
 *     `resolveCatalogBrowsingLevel(claims, { regionRestricted })` — fail-closed
 *     SFW, region-narrowed, echoed in the response like models.ts.
 *
 * What keeps this from being a generic file-exfil proxy: the service serves
 * ONLY `model.type === 'Wildcards'`, published + public + non-archived, under
 * a pre-download size cap and zip-bomb parse caps (see wildcard-pack.service).
 */

const paramsSchema = z.object({
  modelVersionId: z.preprocess((v) => Number(v), z.number().int().positive()),
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

  const parsed = paramsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid modelVersionId', details: parsed.error.flatten() });
    return;
  }

  // Per-token rate limit (same limiter + key family as the catalog reads) —
  // runs BEFORE any db/storage work.
  const rateLimit = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  // AUTHORITATIVE maturity clamp — token ceiling ∩ region restriction, never
  // the client (no maturity param is read from the query at all).
  const regionRestricted = isRegionRestricted(getRegion(req));
  const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel(claims, { regionRestricted });

  try {
    const result = await getWildcardPackContent({
      modelVersionId: parsed.data.modelVersionId,
      browsingLevel,
    });

    switch (result.status) {
      case 'not-found':
        // Unknown id, non-Wildcards type, unpublished/deleted/archived/gated —
        // all collapse to 404 (a block can't probe hidden-state distinctions).
        res.status(404).json({ error: 'Wildcard pack not found' });
        return;
      case 'forbidden':
        res.status(403).json({ error: 'This pack is not available at your maturity level' });
        return;
      case 'too-large':
        res.status(422).json({
          error: `Pack file exceeds the ${Math.floor(MAX_PACK_FILE_KB / 1024)} MB import limit`,
        });
        return;
      case 'fetch-failed':
        res.status(502).json({ error: 'Could not fetch the pack file, please retry shortly.' });
        return;
      case 'ok':
        res.status(200).json({
          ...result.body,
          // Echo the applied ceiling so the block can render an honest "SFW
          // only" affordance. Advisory only — the clamp is authoritative.
          maturity: { browsingLevel, sfwOnly: isSfwCeiling },
        });
        return;
    }
  } catch (e) {
    handleEndpointError(res, e);
    return;
  }
});

// No requiredScope: any valid block token is accepted (same posture as the
// catalog endpoints — the type gate + maturity clamp are the authority
// surface). allowOpaqueOrigin: an UNVERIFIED block runs at an opaque origin
// (`Origin: null`) so its direct fetch needs `ACAO: null` to clear the CORS
// preflight; safe here (published maturity-clamped data, no credentials,
// still token-gated).
export default withBlockScope(baseHandler, { endpoint: 'wildcards', allowOpaqueOrigin: true });
