import { isOrchestratorUrl } from '~/server/common/constants';

// Cloudflare-fronted reverse proxy to the orchestrator. Russian ISP DPI filters
// the bare orchestration origin IP/SNI directly, so browser-direct blob fetches
// die in RU (net::ERR_TIMED_OUT). Routing those fetches through this CF-fronted
// host bypasses the block region-wide. See ClickUp 868kdkv93 / 868ke4d0f.
export const ORCHESTRATOR_PROXY_HOST = 'orchestration-proxy.civitai.com';

/**
 * Swap an orchestrator URL's host to the Cloudflare-fronted proxy. Path and
 * query (incl. the presign `sig`) are preserved — the proxy is a transparent CF
 * route to the same service, so signatures stay valid. Non-orchestrator URLs and
 * URLs already on the proxy host are returned unchanged.
 */
export function rewriteOrchestratorUrlToProxy(url: string): string {
  if (!isOrchestratorUrl(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.host === ORCHESTRATOR_PROXY_HOST) return url;
    parsed.host = ORCHESTRATOR_PROXY_HOST;
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Recursively rewrite every orchestrator URL string found in a tRPC response
 * payload to the proxy host, in place. Only invoked for proxied regions (RU), so
 * the traversal cost never touches the common path.
 */
export function deepRewriteOrchestratorUrls(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === 'string') value[i] = rewriteOrchestratorUrlToProxy(item);
      else deepRewriteOrchestratorUrls(item);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    const item = record[key];
    if (typeof item === 'string') record[key] = rewriteOrchestratorUrlToProxy(item);
    else deepRewriteOrchestratorUrls(item);
  }
}
