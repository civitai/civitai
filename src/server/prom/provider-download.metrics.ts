import client from 'prom-client';

// Downloads made with a per-provider download token, by outcome. `provider` is a provider with a
// live token, or `unknown` for a token that named none, so a caller cannot add series.
// `visibility` is `public` when an anonymous caller could have downloaded the same file, else
// `nonpublic`; `unknown` when the request was refused before the version was read.
//
// 🔴 Same invariant as `http-errors.ts`: import only from the request webpack graph, which is the
// registry `/api/metrics` scrapes.

export type ProviderDownloadResult = 'granted' | 'refused_401' | 'refused_429' | 'refused_gate';
export type ProviderDownloadVisibility = 'public' | 'nonpublic' | 'unknown';

declare global {
  // eslint-disable-next-line no-var
  var __civitaiProviderDownloadCounter: client.Counter<string> | undefined;
}

const providerDownloadCounter: client.Counter<string> =
  globalThis.__civitaiProviderDownloadCounter ??
  (globalThis.__civitaiProviderDownloadCounter = new client.Counter({
    name: 'civitai_provider_download_total',
    help: 'Download route requests carrying a per-provider download token, by provider, result and file visibility. UNSAMPLED.',
    labelNames: ['provider', 'result', 'visibility'],
  }));

/** Never throws. */
export function countProviderDownload(
  provider: string,
  result: ProviderDownloadResult,
  visibility: ProviderDownloadVisibility
) {
  try {
    providerDownloadCounter.inc({ provider, result, visibility });
  } catch {
    // metrics never fail a download
  }
}
