import client from 'prom-client';
import { PROM_PREFIX } from '@civitai/telemetry/client';

// Pinned on globalThis so an HMR re-eval reuses the one instance instead of throwing
// prom-client's duplicate-registration error.
declare global {
  // eslint-disable-next-line no-var
  var __civitaiFeatureToggleMetrics: { toggles: client.Counter<string> } | undefined;
}

const metrics =
  globalThis.__civitaiFeatureToggleMetrics ??
  (globalThis.__civitaiFeatureToggleMetrics = {
    toggles: new client.Counter({
      name: PROM_PREFIX + 'user_feature_toggle_total',
      help:
        'Cumulative changes a user made to one of their toggleable feature flags, by `feature` ' +
        'and the `value` it was changed to. Counts changes, not users, and only writes that ' +
        'actually changed the effective value. Monotonic; use increase(). ' +
        '`feature="trainingStudioUi", value="false"` is the Training Studio opt-back count.',
      labelNames: ['feature', 'value'],
    }),
  });

/** Never throws — telemetry must not fail the settings write it follows. */
export function recordUserFeatureToggle(feature: string, value: boolean): void {
  try {
    metrics.toggles.inc({ feature, value: String(value) });
  } catch {
    /* swallowed on purpose */
  }
}
