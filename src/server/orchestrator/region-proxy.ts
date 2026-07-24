import { isOrchestratorUrl } from '~/server/common/constants';

// Cloudflare-fronted reverse proxy to the orchestrator. Russian ISP DPI filters
// the bare orchestration origin IP/SNI directly, so browser-direct blob fetches
// die in RU (net::ERR_TIMED_OUT). Routing those fetches through this CF-fronted
// host bypasses the block region-wide. See ClickUp 868kdkv93 / 868ke4d0f.
export const ORCHESTRATOR_PROXY_HOST = 'orchestration-proxy.civitai.com';

// Bounds the recursive walk. tRPC payloads are JSON-serializable (acyclic) in
// practice, so this is a defense-in-depth stack-overflow guard, not a real limit.
const MAX_REWRITE_DEPTH = 64;

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
 * Recursively rewrite every orchestrator URL string in a value to the proxy
 * host, returning the (in-place mutated) value. Handles a bare-string payload as
 * well as strings nested in arrays/objects. Only invoked for proxied regions, so
 * the traversal cost never touches the common path.
 */
export function rewriteOrchestratorUrlsDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return rewriteOrchestratorUrlToProxy(value);
  if (!value || typeof value !== 'object' || depth >= MAX_REWRITE_DEPTH) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = rewriteOrchestratorUrlsDeep(value[i], depth + 1);
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    record[key] = rewriteOrchestratorUrlsDeep(record[key], depth + 1);
  }
  return value;
}
