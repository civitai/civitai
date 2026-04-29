import { useEffect } from 'react';
import { useSignalTopic } from '~/components/Signals/SignalsProvider';
import type { MetricEntityType } from '~/components/Signals/metric-signals.types';
import { signalDebug } from '~/components/Signals/signalDebug';
import { SignalTopic } from '~/server/common/enums';
import { useLiveMetricsEnabled } from './useLiveMetricsEnabled';

/**
 * Registers this client to receive live metric deltas for a single entity.
 * Topic format is `Metric:{entityType}:{entityId}`; gated by the
 * `liveMetrics` feature flag.
 *
 * This hook does not observe the DOM or create context. Callers control
 * visibility-gating by *where* they call it:
 *
 * - Call from a component that only mounts while the card is in view
 *   (a descendant of `ElementInView` that is itself conditionally rendered)
 *   → subscription only runs when visible.
 * - Call from a component that is always mounted → subscription runs
 *   whenever that component is mounted (typical for detail pages).
 *
 * @example
 * ```tsx
 * function ImageLiveReactions({ image, ... }) {
 *   useMetricSubscription('Image', image.id);
 *   const metrics = useLiveMetrics('Image', image.id, baseMetrics);
 *   // ...
 * }
 * ```
 */
export function useMetricSubscription(entityType: MetricEntityType, entityId: number) {
  const enabled = useLiveMetricsEnabled();
  const topic = enabled ? (`${SignalTopic.Metric}:${entityType}:${entityId}` as const) : undefined;
  useEffect(() => {
    if (!topic) {
      signalDebug('useMetricSubscription skipped (flag off)', { entityType, entityId });
      return;
    }
    signalDebug('useMetricSubscription effect: subscribe', { topic });
    return () => signalDebug('useMetricSubscription effect: unsubscribe', { topic });
  }, [topic, entityType, entityId]);
  useSignalTopic(topic);
}
