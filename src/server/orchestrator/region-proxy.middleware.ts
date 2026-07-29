import { rewriteOrchestratorUrlsDeep } from '~/server/orchestrator/region-proxy';
import { middleware } from '~/server/trpc';
import { getRegion } from '~/server/utils/region-blocking';

/**
 * tRPC middleware that rewrites orchestrator URLs in the response to the
 * Cloudflare-fronted proxy for RU requests. Gated on the `ruOrchestratorProxy`
 * feature flag (fails closed / off) so it can be killed at runtime via Flipt.
 * Non-RU requests and the flag-off path early-return with zero traversal cost.
 * Attach to any procedure that can return orchestrator blob URLs to the browser.
 * See ClickUp 868kdkv93 / 868ke4d0f.
 */
export const regionProxyMiddleware = middleware(async ({ ctx, next }) => {
  const result = await next();
  if (!result.ok || !ctx.req || !ctx.features?.ruOrchestratorProxy) return result;
  if (getRegion(ctx.req).countryCode !== 'RU') return result;
  result.data = rewriteOrchestratorUrlsDeep(result.data);
  return result;
});
