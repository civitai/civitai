import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { getResourceIntent } from '~/server/services/resource-intent.service';
import { resourceIntentInputSchema } from '~/server/schema/resource-intent.schema';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { checkBlockLLMRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/resource-intent — prompt → intent + criteria → civitai
 * resource suggestions (the Jev resource-intent primitive).
 *
 * App Blocks surface. Mirrors /api/v1/blocks/generation-resources EXACTLY on
 * auth + maturity + CORS:
 *   - withBlockScope (any valid block JWT, no required scope — the token is
 *     needed ONLY for its signed `maxBrowsingLevel` clamp), forcing
 *     `private, no-store` + exact-origin CORS. `allowOpaqueOrigin` so an
 *     unverified block at `Origin: null` clears the preflight (public,
 *     maturity-clamped data, no credentials, still token-gated).
 *   - The effective browsing level is AUTHORITATIVELY CLAMPED to the token's
 *     `maxBrowsingLevel` ceiling; region restriction clamps further.
 *   - Anon read: personalization would leak favorites/hidden prefs, and the
 *     response is projected through the SAME `projectSafeGenerationResource`
 *     the picker/rehydrate path uses — no availability/hasAccess/usageControl
 *     internals cross the boundary.
 *
 * DELIBERATELY NOT mirrored: `onApprovalLookupFailure: 'serve'`. That opt-out
 * is an availability argument for reads where a suspended app obtains nothing
 * new. This route costs vendor LLM spend on EVERY call, so the default
 * fail-closed 503 on an approved-status lookup failure is kept.
 *
 * Rate limit: per-blockInstanceId LLM bucket (NOT the catalog bucket) — each
 * request is up to three vendor calls (stage 1, then two stage-3 calls in
 * parallel). Flag: `resourceIntentJev` (Flipt
 * `resource-intent-jev`, default-deny when absent) is checked BEFORE the
 * response cache so a dark flag never reads, never spends.
 *
 * Any failure inside the primitive returns 200 with `degraded: true` and empty
 * suggestions — never a stack trace, never fabricated suggestions. ⚠️ ONE
 * EXCEPTION, and this line used to state the rule without it: a failed
 * `ResourceInsight` label read is handled inside the matcher and returns a normal
 * 200 with `degraded: false`, real suggestions, and `insightFallback: true`.
 *
 * 🔴 `insightFallback` is therefore PART OF THIS ROUTE'S PUBLIC BODY — this handler
 * spreads the service result, so adding a field to the response adds it here. That
 * is accepted rather than incidental: it is one bit saying "this shortlist is in
 * seed order, not label order, because our label read failed", the same category of
 * service-health disclosure `degraded` already publishes, it carries no viewer,
 * model or moderation data, and a block that wanted to retry or to stop trusting
 * the ordering has no other way to know. The reason it lives on the response at all
 * is the cache: the response is what gets cached, so a replay has to report what
 * the computation did. If a future field is NOT meant to be public, destructure it
 * out here rather than relying on this comment.
 */

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // withBlockScope only invokes this handler with a valid block JWT; defense in depth.
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  // Dark by default — deny before anything reads the cache or spends a token.
  const features = getFeatureFlags({ req });
  if (!features.resourceIntentJev) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const parsed = resourceIntentInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const rateLimit = await checkBlockLLMRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  const regionRestricted = isRegionRestricted(getRegion(req));
  const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel(claims, { regionRestricted });

  try {
    // Coverage is resolved INSIDE the service, on the cache-miss path only —
    // a Flipt eval on every cache hit would be pure waste.
    const result = await getResourceIntent(parsed.data, { browsingLevel });
    res.status(200).json({
      ...result,
      // Echo the applied ceiling (advisory — the clamp is authoritative).
      maturity: { browsingLevel, sfwOnly: isSfwCeiling },
    });
    return;
  } catch (e) {
    handleEndpointError(res, e);
    return;
  }
});

// No requiredScope: any valid block token (same argument as generation-resources —
// public, maturity-clamped resource data; nothing viewer-scoped, nothing written).
export default withBlockScope(baseHandler, {
  endpoint: 'resource_intent',
  allowOpaqueOrigin: true,
});
