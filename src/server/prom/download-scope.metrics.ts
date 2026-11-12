import client from 'prom-client';

// Download route requests whose bearer credential lacks the route's scope, by route, key type and
// flag mode. `route` and `apiKeyType` come from fixed sets, so a caller cannot add series.
//
// 🔴 Same invariant as `http-errors.ts`: import only from the request webpack graph, which is the
// registry `/api/metrics` scrapes.

declare global {
  // eslint-disable-next-line no-var
  var __civitaiDownloadScopeRefusedCounter: client.Counter<string> | undefined;
}

const downloadScopeRefusedCounter: client.Counter<string> =
  globalThis.__civitaiDownloadScopeRefusedCounter ??
  (globalThis.__civitaiDownloadScopeRefusedCounter = new client.Counter({
    name: 'civitai_download_scope_refused_total',
    help: 'Download route requests whose bearer credential lacks the route scope, by route, apiKeyType and mode. UNSAMPLED.',
    labelNames: ['route', 'apiKeyType', 'mode'],
  }));

/** Never throws. */
export function countDownloadScopeRefused(route: string, apiKeyType: string, mode: string) {
  try {
    downloadScopeRefusedCounter.inc({ route, apiKeyType, mode });
  } catch {
    // metrics never fail a download
  }
}
