# Live Metric Signals Implementation Plan

## Overview

Implement real-time metric updates using the existing signals infrastructure. When metrics change (reactions, downloads, comments, etc.), the event-engine sends delta updates via signals that the frontend can subscribe to and apply in real-time.

## Signal Format

**Topic:** `metrics:{entityType}:{entityId}` (e.g., `metrics:Image:12345`)
**Message:** `metric:update`
**Payload:** `{ [metricType]: delta }` (e.g., `{ likeCount: 1 }` or `{ likeCount: -1 }`)

---

## Implementation Steps

### 1. Add Signal Enums

**File:** `src/server/common/enums.ts`

```typescript
// Add to SignalMessages enum
export enum SignalMessages {
  // ... existing
  MetricUpdate = 'metric:update',
}

// Add to SignalTopic enum
export enum SignalTopic {
  // ... existing
  Metric = 'metrics', // with :entityType:entityId
}
```

---

### 2. Create Metric Signal Types

**File:** `src/components/Signals/metric-signals.types.ts`

```typescript
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

export type MetricEntityType =
  | 'User'
  | 'Model'
  | 'ModelVersion'
  | 'Post'
  | 'Image'
  | 'Collection'
  | 'Tag'
  | 'Article'
  | 'Bounty'
  | 'BountyEntry';

export type MetricType =
  | 'followerCount'
  | 'followingCount'
  | 'hiddenCount'
  | 'reactionCount'
  | 'downloadCount'
  | 'collectedCount'
  | 'commentCount'
  | 'imageCount'
  | 'ratingCount'
  | 'thumbsUpCount'
  | 'thumbsDownCount'
  | 'tippedAmount'
  | 'tippedCount'
  | 'likeCount'
  | 'dislikeCount'
  | 'heartCount'
  | 'laughCount'
  | 'cryCount'
  | 'viewCount'
  | 'itemCount'
  | 'contributorCount'
  | 'favoriteCount'
  | 'trackCount'
  | 'entryCount'
  | 'benefactorCount'
  | 'unitAmount';

export type MetricUpdatePayload = Partial<Record<MetricType, number>>;
```

---

### 3. Create Zustand Store for Metric Deltas

**File:** `src/store/metric-signals.store.ts`

This store accumulates deltas and provides the current adjustment for any entity+metric combination.

```typescript
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { MetricEntityType, MetricType, MetricUpdatePayload } from '~/components/Signals/metric-signals.types';

type MetricKey = `${MetricEntityType}:${number}:${MetricType}`;

interface MetricSignalsState {
  deltas: Record<MetricKey, number>;
  applyDelta: (entityType: MetricEntityType, entityId: number, updates: MetricUpdatePayload) => void;
  getDelta: (entityType: MetricEntityType, entityId: number, metricType: MetricType) => number;
  clearDelta: (entityType: MetricEntityType, entityId: number, metricType?: MetricType) => void;
}

export const useMetricSignalsStore = create<MetricSignalsState>()(
  subscribeWithSelector((set, get) => ({
    deltas: {},

    applyDelta: (entityType, entityId, updates) => {
      set((state) => {
        const newDeltas = { ...state.deltas };
        for (const [metricType, delta] of Object.entries(updates)) {
          if (delta === 0) continue;
          const key: MetricKey = `${entityType}:${entityId}:${metricType as MetricType}`;
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
```

---

### 4. Create Hook to Subscribe to Metric Topics

**File:** `src/components/Signals/useMetricSignal.ts`

```typescript
import { useEffect } from 'react';
import { useSignalTopic, useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import type { MetricEntityType, MetricUpdatePayload } from './metric-signals.types';

/**
 * Subscribe to metric updates for a specific entity.
 * Automatically registers the topic and applies deltas to the store.
 */
export function useMetricSignal(entityType: MetricEntityType, entityId: number | undefined) {
  const topic = entityId ? `${SignalTopic.Metric}:${entityType}:${entityId}` : undefined;
  const applyDelta = useMetricSignalsStore((state) => state.applyDelta);

  // Subscribe to the topic
  useSignalTopic(topic);

  // Listen for metric updates
  useEffect(() => {
    if (!entityId) return;

    const handler = (data: { entityType: string; entityId: number; updates: MetricUpdatePayload }) => {
      // Verify this update is for our entity (topic-based routing should handle this, but double-check)
      if (data.entityType === entityType && data.entityId === entityId) {
        applyDelta(entityType, entityId, data.updates);
      }
    };

    // Note: The actual implementation depends on how signals route topic-specific messages
    // This may need adjustment based on how the worker dispatches topic messages

  }, [entityType, entityId, applyDelta]);
}

/**
 * Get the current delta-adjusted value for a metric.
 * Use this in components to get live-updated counts.
 */
export function useLiveMetric(
  entityType: MetricEntityType,
  entityId: number | undefined,
  metricType: MetricType,
  baseValue: number = 0
): number {
  const delta = useMetricSignalsStore((state) =>
    entityId ? state.getDelta(entityType, entityId, metricType) : 0
  );
  return baseValue + delta;
}
```

---

### 5. Create Global Metric Signal Listener

**File:** `src/components/Signals/MetricSignalsRegistrar.tsx`

Register in `SignalsRegistrar.tsx` to handle all incoming metric updates.

```typescript
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import type { MetricEntityType, MetricUpdatePayload } from './metric-signals.types';

interface MetricSignalPayload {
  entityType: MetricEntityType;
  entityId: number;
  updates: MetricUpdatePayload;
}

export function useMetricSignalsListener() {
  const applyDelta = useMetricSignalsStore((state) => state.applyDelta);

  const handleMetricUpdate = useCallback(
    (payload: MetricSignalPayload) => {
      applyDelta(payload.entityType, payload.entityId, payload.updates);
    },
    [applyDelta]
  );

  useSignalConnection(SignalMessages.MetricUpdate, handleMetricUpdate);
}
```

Then add to `SignalsRegistrar.tsx`:
```typescript
import { useMetricSignalsListener } from './MetricSignalsRegistrar';

export function SignalsRegistrar() {
  // ... existing
  useMetricSignalsListener();
  // ...
}
```

---

### 6. Create LiveMetric Display Component

**File:** `src/components/Metrics/LiveMetric.tsx`

A drop-in component that displays a metric with live updates.

```typescript
import { Text, type TextProps } from '@mantine/core';
import { useMetricSignal, useLiveMetric } from '~/components/Signals/useMetricSignal';
import { abbreviateNumber } from '~/utils/number-helpers';
import type { MetricEntityType, MetricType } from '~/components/Signals/metric-signals.types';

interface LiveMetricProps extends Omit<TextProps, 'children'> {
  entityType: MetricEntityType;
  entityId: number;
  metricType: MetricType;
  baseValue: number;
  abbreviate?: boolean;
  subscribe?: boolean; // Whether to subscribe to topic (default: true)
}

export function LiveMetric({
  entityType,
  entityId,
  metricType,
  baseValue,
  abbreviate = true,
  subscribe = true,
  ...textProps
}: LiveMetricProps) {
  // Subscribe to metric updates for this entity
  if (subscribe) {
    useMetricSignal(entityType, entityId);
  }

  // Get live value with delta applied
  const liveValue = useLiveMetric(entityType, entityId, metricType, baseValue);
  const displayValue = abbreviate ? abbreviateNumber(liveValue) : liveValue.toString();

  return <Text {...textProps}>{displayValue}</Text>;
}
```

---

### 7. Create useLiveMetrics Hook for Multiple Metrics

**File:** `src/components/Metrics/useLiveMetrics.ts`

For components that display multiple metrics (like cards).

```typescript
import { useMemo } from 'react';
import { useMetricSignal } from '~/components/Signals/useMetricSignal';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import type { MetricEntityType, MetricType } from '~/components/Signals/metric-signals.types';

type MetricsInput = Partial<Record<MetricType, number>>;

/**
 * Hook for components that display multiple metrics.
 * Subscribes once and returns all metrics with deltas applied.
 */
export function useLiveMetrics<T extends MetricsInput>(
  entityType: MetricEntityType,
  entityId: number | undefined,
  baseMetrics: T
): T {
  // Subscribe to the topic
  useMetricSignal(entityType, entityId);

  // Get all relevant deltas
  const deltas = useMetricSignalsStore((state) => {
    if (!entityId) return {};
    const result: Partial<Record<MetricType, number>> = {};
    for (const metricType of Object.keys(baseMetrics) as MetricType[]) {
      result[metricType] = state.getDelta(entityType, entityId, metricType);
    }
    return result;
  });

  // Apply deltas to base metrics
  return useMemo(() => {
    const result = { ...baseMetrics };
    for (const [key, baseValue] of Object.entries(baseMetrics)) {
      const delta = deltas[key as MetricType] || 0;
      (result as any)[key] = (baseValue || 0) + delta;
    }
    return result;
  }, [baseMetrics, deltas]);
}
```

---

### 8. Integration Examples

#### ModelCard Integration

```typescript
// In ModelCard.tsx
import { useLiveMetrics } from '~/components/Metrics/useLiveMetrics';

function ModelCard({ data }) {
  const liveRank = useLiveMetrics('Model', data.id, {
    downloadCount: data.rank?.downloadCount ?? 0,
    collectedCount: data.rank?.collectedCount ?? 0,
    thumbsUpCount: data.rank?.thumbsUpCount ?? 0,
    commentCount: data.rank?.commentCount ?? 0,
  });

  return (
    // Use liveRank.downloadCount, liveRank.collectedCount, etc.
  );
}
```

#### ImageCard / Reactions Integration

```typescript
// In Reactions.tsx or ImageCard.tsx
import { useLiveMetrics } from '~/components/Metrics/useLiveMetrics';

function Reactions({ entityType, entityId, metrics }) {
  const liveMetrics = useLiveMetrics(entityType, entityId, {
    likeCount: metrics?.likeCount ?? 0,
    dislikeCount: metrics?.dislikeCount ?? 0,
    heartCount: metrics?.heartCount ?? 0,
    laughCount: metrics?.laughCount ?? 0,
    cryCount: metrics?.cryCount ?? 0,
  });

  return (
    // Use liveMetrics.likeCount, etc.
  );
}
```

#### Detail Page Integration

```typescript
// In model detail or image detail pages
import { useMetricSignal, useLiveMetric } from '~/components/Signals/useMetricSignal';

function ModelDetail({ model }) {
  // Subscribe once at the page level
  useMetricSignal('Model', model.id);

  // Use individual live metrics anywhere in the component tree
  const downloadCount = useLiveMetric('Model', model.id, 'downloadCount', model.rank.downloadCount);

  return (
    // ...
  );
}
```

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                        Event Engine                              │
│  (sends delta signals to topic: metrics:{entityType}:{id})      │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SignalR WebSocket                            │
│              (via SharedWorker + SignalsProvider)                │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                  MetricSignalsRegistrar                          │
│   (global listener for metric:update, applies to Zustand store) │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                 useMetricSignalsStore (Zustand)                  │
│     (accumulates deltas: { "Image:123:likeCount": 5, ... })     │
└─────────────────────────────────────────────────────────────────┘
                                │
                   ┌────────────┼────────────┐
                   ▼            ▼            ▼
            ┌──────────┐ ┌──────────┐ ┌──────────────┐
            │LiveMetric│ │useLive   │ │ useLive      │
            │Component │ │Metric()  │ │ Metrics()    │
            └──────────┘ └──────────┘ └──────────────┘
                   │            │            │
                   ▼            ▼            ▼
            ┌──────────────────────────────────────┐
            │         UI Components                 │
            │  (Cards, Reactions, Detail Pages)     │
            └──────────────────────────────────────┘
```

---

## Key Design Decisions

1. **Zustand Store for Deltas**: Instead of updating React Query cache (which would cause re-renders of entire lists), we store deltas separately and apply them at render time.

2. **Topic-based Subscription**: Components subscribe to entity-specific topics so they only receive relevant updates.

3. **Delta Accumulation**: The store accumulates deltas, so if a user rapidly likes/unlikes, the count stays accurate.

4. **Separation of Concerns**:
   - `useMetricSignal` - handles topic subscription
   - `useLiveMetric` - reads single metric with delta
   - `useLiveMetrics` - reads multiple metrics with deltas
   - `LiveMetric` - ready-to-use display component

5. **Opt-in Subscription**: Cards in feeds can choose whether to subscribe (might want to skip for performance in very long lists).

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/server/common/enums.ts` | Add MetricUpdate to SignalMessages, Metric to SignalTopic |
| `src/components/Signals/metric-signals.types.ts` | Create - type definitions |
| `src/store/metric-signals.store.ts` | Create - Zustand store |
| `src/components/Signals/useMetricSignal.ts` | Create - subscription hooks |
| `src/components/Signals/MetricSignalsRegistrar.tsx` | Create - global listener |
| `src/components/Signals/SignalsRegistrar.tsx` | Modify - add metric listener |
| `src/components/Metrics/LiveMetric.tsx` | Create - display component |
| `src/components/Metrics/useLiveMetrics.ts` | Create - multi-metric hook |

---

## Design Decisions (Confirmed)

1. **In-view subscriptions only**: Use IntersectionObserver to subscribe only when cards are visible
2. **Session persistence**: Deltas persist during the session (don't clear on navigation)
3. **Trust accumulated deltas**: On WebSocket reconnect, trust the accumulated deltas without re-fetching

---

## 9. In-View Subscription with IntersectionObserver

**File:** `src/components/Metrics/MetricSubscriptionProvider.tsx`

Wraps cards/components to only subscribe when visible.

```typescript
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSignalTopic } from '~/components/Signals/SignalsProvider';
import { SignalTopic } from '~/server/common/enums';
import type { MetricEntityType } from '~/components/Signals/metric-signals.types';

interface MetricSubscriptionContextValue {
  isSubscribed: boolean;
}

const MetricSubscriptionContext = createContext<MetricSubscriptionContextValue>({ isSubscribed: false });

export function useMetricSubscriptionContext() {
  return useContext(MetricSubscriptionContext);
}

interface MetricSubscriptionProviderProps {
  entityType: MetricEntityType;
  entityId: number;
  children: ReactNode;
  rootMargin?: string; // e.g., "100px" to subscribe slightly before visible
}

export function MetricSubscriptionProvider({
  entityType,
  entityId,
  children,
  rootMargin = '200px', // Subscribe when within 200px of viewport
}: MetricSubscriptionProviderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { rootMargin }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin]);

  // Only subscribe when visible
  const topic = isVisible ? `${SignalTopic.Metric}:${entityType}:${entityId}` : undefined;
  useSignalTopic(topic);

  return (
    <div ref={ref}>
      <MetricSubscriptionContext.Provider value={{ isSubscribed: isVisible }}>
        {children}
      </MetricSubscriptionContext.Provider>
    </div>
  );
}
```

---

## 10. Updated useLiveMetrics with Optional Auto-Subscribe

**File:** `src/components/Metrics/useLiveMetrics.ts` (updated)

```typescript
import { useMemo } from 'react';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import { useMetricSubscriptionContext } from './MetricSubscriptionProvider';
import type { MetricEntityType, MetricType } from '~/components/Signals/metric-signals.types';

type MetricsInput = Partial<Record<MetricType, number>>;

/**
 * Hook for components that display multiple metrics.
 * Works with MetricSubscriptionProvider for in-view subscription,
 * or can be used standalone if subscription is handled elsewhere.
 *
 * Deltas are always applied regardless of subscription state
 * (they persist in the store from when the card was visible).
 */
export function useLiveMetrics<T extends MetricsInput>(
  entityType: MetricEntityType,
  entityId: number | undefined,
  baseMetrics: T
): T {
  // Get all relevant deltas from store
  const deltas = useMetricSignalsStore((state) => {
    if (!entityId) return {};
    const result: Partial<Record<MetricType, number>> = {};
    for (const metricType of Object.keys(baseMetrics) as MetricType[]) {
      result[metricType] = state.getDelta(entityType, entityId, metricType);
    }
    return result;
  });

  // Apply deltas to base metrics
  return useMemo(() => {
    const result = { ...baseMetrics };
    for (const [key, baseValue] of Object.entries(baseMetrics)) {
      const delta = deltas[key as MetricType] || 0;
      (result as any)[key] = (baseValue || 0) + delta;
    }
    return result;
  }, [baseMetrics, deltas]);
}
```

---

## 11. Card Integration Pattern

Example of how to integrate with existing cards:

```tsx
// In a card component (e.g., ModelCard.tsx)
import { MetricSubscriptionProvider } from '~/components/Metrics/MetricSubscriptionProvider';
import { useLiveMetrics } from '~/components/Metrics/useLiveMetrics';

function ModelCard({ data }: { data: ModelCardData }) {
  return (
    <MetricSubscriptionProvider entityType="Model" entityId={data.id}>
      <ModelCardContent data={data} />
    </MetricSubscriptionProvider>
  );
}

function ModelCardContent({ data }: { data: ModelCardData }) {
  // Deltas applied automatically, subscription handled by provider
  const liveRank = useLiveMetrics('Model', data.id, {
    downloadCount: data.rank?.downloadCount ?? 0,
    collectedCount: data.rank?.collectedCount ?? 0,
    thumbsUpCount: data.rank?.thumbsUpCount ?? 0,
    commentCount: data.rank?.commentCount ?? 0,
    tippedAmountCount: data.rank?.tippedAmountCount ?? 0,
  });

  return (
    <Card>
      {/* Use liveRank.downloadCount, etc. */}
      <Text>{abbreviateNumber(liveRank.downloadCount)}</Text>
    </Card>
  );
}
```

---

## 12. Alternative: HOC Pattern for Cleaner Integration

**File:** `src/components/Metrics/withMetricSubscription.tsx`

```tsx
import { ComponentType } from 'react';
import { MetricSubscriptionProvider } from './MetricSubscriptionProvider';
import type { MetricEntityType } from '~/components/Signals/metric-signals.types';

interface WithMetricSubscriptionProps {
  id: number;
}

export function withMetricSubscription<P extends WithMetricSubscriptionProps>(
  WrappedComponent: ComponentType<P>,
  entityType: MetricEntityType
) {
  return function WithMetricSubscription(props: P) {
    return (
      <MetricSubscriptionProvider entityType={entityType} entityId={props.id}>
        <WrappedComponent {...props} />
      </MetricSubscriptionProvider>
    );
  };
}

// Usage:
// export const ModelCard = withMetricSubscription(ModelCardBase, 'Model');
```

---

## Updated Files to Create/Modify

| File | Action |
|------|--------|
| `src/server/common/enums.ts` | Add MetricUpdate to SignalMessages, Metric to SignalTopic |
| `src/components/Signals/metric-signals.types.ts` | Create - type definitions |
| `src/store/metric-signals.store.ts` | Create - Zustand store (session-persistent) |
| `src/components/Signals/useMetricSignal.ts` | Create - subscription hooks |
| `src/components/Signals/MetricSignalsRegistrar.tsx` | Create - global listener |
| `src/components/Signals/SignalsRegistrar.tsx` | Modify - add metric listener |
| `src/components/Metrics/MetricSubscriptionProvider.tsx` | Create - IntersectionObserver wrapper |
| `src/components/Metrics/LiveMetric.tsx` | Create - display component |
| `src/components/Metrics/useLiveMetrics.ts` | Create - multi-metric hook |
| `src/components/Metrics/withMetricSubscription.tsx` | Create - HOC for easy integration |
| `src/components/Cards/ModelCard.tsx` | Modify - wrap with subscription provider |
| `src/components/Cards/ImageCard.tsx` | Modify - wrap with subscription provider |
| `src/components/Cards/ArticleCard.tsx` | Modify - wrap with subscription provider |
| `src/components/Cards/PostCard.tsx` | Modify - wrap with subscription provider |
| `src/components/Reaction/Reactions.tsx` | Modify - use useLiveMetrics |
