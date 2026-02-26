import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import type { MetricEntityType, MetricType, MetricUpdatePayload } from './metric-signals.types';

/**
 * Maps raw reaction names from the metric-event-watcher (e.g. 'Like')
 * to the MetricType format used on the frontend (e.g. 'likeCount').
 */
const reactionToMetricType: Record<string, MetricType> = {
  Like: 'likeCount',
  Dislike: 'dislikeCount',
  Heart: 'heartCount',
  Laugh: 'laughCount',
  Cry: 'cryCount',
};

function normalizeMetricPayload(raw: Record<string, number>): MetricUpdatePayload {
  const normalized: MetricUpdatePayload = {};
  for (const [key, value] of Object.entries(raw)) {
    const metricType = (reactionToMetricType[key] ?? key) as MetricType;
    normalized[metricType] = (normalized[metricType] ?? 0) + value;
  }
  return normalized;
}

/**
 * Listens for metric:update signals and applies deltas to the store.
 * The signal payload contains the delta values (not absolute values).
 */
export function useMetricSignalsListener() {
  const applyDelta = useMetricSignalsStore((state) => state.applyDelta);

  const handleMetricUpdate = useCallback(
    (payload: Record<string, any> & { entityType?: MetricEntityType; entityId?: number }) => {
      if (!payload.entityType || !payload.entityId) {
        console.warn('MetricSignalsRegistrar: missing entityType or entityId in payload', payload);
        return;
      }

      const { entityType, entityId, ...rawUpdates } = payload;
      const updates = normalizeMetricPayload(rawUpdates);
      applyDelta(entityType, entityId, updates);
    },
    [applyDelta]
  );

  useSignalConnection(SignalMessages.MetricUpdate, handleMetricUpdate);
}
