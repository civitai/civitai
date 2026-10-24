import client from 'prom-client';
import { PROM_PREFIX } from '@civitai/telemetry/client';

// Pinned on globalThis so an HMR re-eval reuses the one instance instead of throwing
// prom-client's duplicate-registration error.
declare global {
  // eslint-disable-next-line no-var
  var __civitaiImageDeliveryMetrics: { bustFailures: client.Counter<string> } | undefined;
}

const metrics =
  globalThis.__civitaiImageDeliveryMetrics ??
  (globalThis.__civitaiImageDeliveryMetrics = {
    bustFailures: new client.Counter({
      name: PROM_PREFIX + 'image_delivery_metadata_bust_failures_total',
      help:
        'Image-delivery metadata cache busts that still failed after their retry, so the stale ' +
        'entry lives until its TTL. Monotonic; use increase().',
    }),
  });

/** Never throws — telemetry must not fail the save it follows. */
export function recordImageDeliveryBustFailure(): void {
  try {
    metrics.bustFailures.inc();
  } catch {
    /* swallowed on purpose */
  }
}
