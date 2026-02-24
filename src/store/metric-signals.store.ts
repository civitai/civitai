import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  MetricEntityType,
  MetricType,
  MetricUpdatePayload,
} from '~/components/Signals/metric-signals.types';

type MetricKey = `${MetricEntityType}:${number}:${MetricType}`;

interface MetricSignalsState {
  deltas: Record<MetricKey, number>;
  applyDelta: (
    entityType: MetricEntityType,
    entityId: number,
    updates: MetricUpdatePayload
  ) => void;
  getDelta: (entityType: MetricEntityType, entityId: number, metricType: MetricType) => number;
  clearDelta: (entityType: MetricEntityType, entityId: number, metricType?: MetricType) => void;
}

export const useMetricSignalsStore = create<MetricSignalsState>()(
  subscribeWithSelector((set, get) => ({
    deltas: {},

    applyDelta: (entityType, entityId, updates) => {
      set((state) => {
        const newDeltas = { ...state.deltas };
        for (const [metricType, delta] of Object.entries(updates) as [MetricType, number][]) {
          if (delta === 0 || delta === undefined) continue;
          const key: MetricKey = `${entityType}:${entityId}:${metricType}`;
          newDeltas[key] = (newDeltas[key] || 0) + delta;
        }
        return { deltas: newDeltas };
      });
    },

    getDelta: (entityType, entityId, metricType) => {
      const key: MetricKey = `${entityType}:${entityId}:${metricType}`;
      return get().deltas[key] || 0;
    },

    clearDelta: (entityType, entityId, metricType) => {
      set((state) => {
        const newDeltas = { ...state.deltas };
        if (metricType) {
          const key: MetricKey = `${entityType}:${entityId}:${metricType}`;
          delete newDeltas[key];
        } else {
          // Clear all deltas for this entity
          const prefix = `${entityType}:${entityId}:`;
          for (const key of Object.keys(newDeltas)) {
            if (key.startsWith(prefix)) {
              delete newDeltas[key as MetricKey];
            }
          }
        }
        return { deltas: newDeltas };
      });
    },
  }))
);
