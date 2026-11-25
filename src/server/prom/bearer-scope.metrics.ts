import client from 'prom-client';

// Bearer credentials the `bearer-scope-tighten` checks found short of a scope, by route and
// credential kind. Both come from fixed sets, so a caller cannot add series; ids go to the log.
//
// 🔴 Same invariant as `http-errors.ts`: import only from the request webpack graph, which is the
// registry `/api/metrics` scrapes.

declare global {
  // eslint-disable-next-line no-var
  var __civitaiBearerScopeRefusedCounter: client.Counter<string> | undefined;
}

const bearerScopeRefusedCounter: client.Counter<string> =
  globalThis.__civitaiBearerScopeRefusedCounter ??
  (globalThis.__civitaiBearerScopeRefusedCounter = new client.Counter({
    name: 'civitai_bearer_scope_refused_total',
    help: 'Bearer credentials short of a scope under the bearer-scope-tighten flag, by route and credential kind. UNSAMPLED.',
    labelNames: ['route', 'credentialKind'],
  }));

/** Never throws. */
export function countBearerScopeRefused(route: string, credentialKind: string) {
  try {
    bearerScopeRefusedCounter.inc({ route, credentialKind });
  } catch {
    // metrics never fail a request
  }
}
