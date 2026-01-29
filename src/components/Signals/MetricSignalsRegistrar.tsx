import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import type { MetricEntityType, MetricUpdatePayload } from './metric-signals.types';

/**
 * Listens for metric:update signals and applies deltas to the store.
 * The signal payload contains the delta values (not absolute values).
 */
export function useMetricSignalsListener() {
  const applyDelta = useMetricSignalsStore((state) => state.applyDelta);

  const handleMetricUpdate = useCallback(
    (payload: MetricUpdatePayload & { entityType?: MetricEntityType; entityId?: number }) => {
      // The payload structure from event-engine is { [metricType]: delta }
      // But we need entityType and entityId from the topic subscription
      // Since signals are topic-based, the worker should include this info

      if (payload.entityType && payload.entityId) {
        const { entityType, entityId, ...updates } = payload;
        applyDelta(entityType, entityId, updates);
      }
    },
    [applyDelta]
  );

  useSignalConnection(SignalMessages.MetricUpdate, handleMetricUpdate);
}
