import { safeError } from '@civitai/axiom';
import { createFliptClient, type FliptFeatureFlags } from '@civitai/flipt';
import { buildFliptContext } from '@civitai/flipt/context';
import type { SessionUser } from '@civitai/auth';
import { getLogger } from './logger';

// App shim around `@civitai/flipt`. Reads FLIPT_URL + FLIPT_FETCHER_SECRET from process.env (the
// vite.config shim bridges .env → process.env), on the first evaluation rather than at import — an
// unconfigured deploy degrades to every flag off instead of failing to boot. Lazily constructed (so
// `vite build` never instantiates it) and cached on globalThis (dev HMR reuse).
const g = globalThis as unknown as { flipt?: FliptFeatureFlags };

export function getFlipt(): FliptFeatureFlags {
  if (!g.flipt) {
    g.flipt = createFliptClient({
      onInitError: (error) => {
        // logToAxiom rejects when Axiom ingest is degraded; telemetry must not fail the caller.
        getLogger()
          .logToAxiom({ name: 'init-flipt-error', error: safeError(error) })
          .catch(() => undefined);
      },
    });
  }
  return g.flipt;
}

/**
 * 🔴 Every evaluation must pass this. Segment constraints match on context properties, not on the
 * entity id, so a context-less call matches no segment and returns the flag's `enabled` value —
 * `false` for every segmented flag we ship. Omitting it 404'd the whole feature for everyone.
 */
export function fliptContext(user: SessionUser): Record<string, string> {
  return buildFliptContext(user);
}
