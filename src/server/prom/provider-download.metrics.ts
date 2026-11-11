import client from 'prom-client';
import { getLiveProviderTokens } from '~/server/services/provider-download/provider-token.store';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

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

const SEED_DEADLINE_MS = 1_000;

/** Every (result, visibility) pair `countProviderDownload` is called with. */
const REACHABLE: ReadonlyArray<[ProviderDownloadResult, ProviderDownloadVisibility]> = [
  ['granted', 'public'],
  ['granted', 'nonpublic'],
  ['refused_401', 'unknown'],
  ['refused_429', 'unknown'],
  ['refused_gate', 'unknown'],
];

/**
 * Publishes every series a download can reach at 0, for each live provider and for `unknown`.
 * `increase()` cannot see a series whose first scraped value is above 0, so unseeded, every download
 * a pod served before that series' first scrape went uncounted. Called on every scrape, so what is
 * still missed is the downloads before a pod's first scrape, and those of a provider before the
 * first scrape after it was minted. Never throws.
 */
export async function seedProviderDownloadMetrics() {
  try {
    providerDownloadCounter.inc(
      { provider: 'unknown', result: 'refused_401', visibility: 'unknown' },
      0
    );
    // Bounded: a stalled token read must not stall the scrape.
    const live = await withTimeoutFallback(getLiveProviderTokens(), SEED_DEADLINE_MS, []);
    for (const provider of new Set(live.map((entry) => entry.provider)))
      for (const [result, visibility] of REACHABLE)
        providerDownloadCounter.inc({ provider, result, visibility }, 0);
  } catch {
    // seeding never fails a scrape
  }
}
