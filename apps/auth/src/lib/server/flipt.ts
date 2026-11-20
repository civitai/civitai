import { createFliptClient, type FliptFeatureFlags } from '@civitai/flipt';
import { logToAxiom } from '$lib/server/axiom';

// The hub's Flipt client: the shared `@civitai/flipt` package, which reads FLIPT_URL and
// FLIPT_FETCHER_SECRET from process.env on first use, as every app using it does. Built on the
// first evaluation, never at module load (`vite build` evaluates modules), and cached on
// globalThis so dev HMR reuses it. An unconfigured or unreachable Flipt evaluates every flag off.
const g = globalThis as unknown as { hubFlipt?: FliptFeatureFlags };

function getFlipt(): FliptFeatureFlags {
  if (!g.hubFlipt) {
    g.hubFlipt = createFliptClient({
      onInitError: (error) => {
        try {
          void logToAxiom({ type: 'error', name: 'init-flipt-error', message: String(error) });
        } catch {
          // Logging must never turn a flag read into a failure.
        }
      },
    });
  }
  return g.hubFlipt;
}

/**
 * A boolean flag with no per-user targeting: `false` when it is off, missing, or Flipt cannot be
 * read. Never throws.
 */
export async function isGlobalFlagOn(flag: string): Promise<boolean> {
  // Unconfigured (local dev, tests): every flag is off, without building a client that would only
  // fail to initialise.
  if (!process.env.FLIPT_URL) return false;
  try {
    return await getFlipt().isEnabled(flag);
  } catch {
    return false;
  }
}
