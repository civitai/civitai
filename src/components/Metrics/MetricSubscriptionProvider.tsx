import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { useSignalTopic } from '~/components/Signals/SignalsProvider';
import { SignalTopic } from '~/server/common/enums';
import type { MetricEntityType } from '~/components/Signals/metric-signals.types';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * Hook to check if live metrics feature is enabled via feature flags (Flipt-backed).
 */
export function useLiveMetricsEnabled() {
  const { liveMetrics } = useFeatureFlags();
  return liveMetrics;
}

interface MetricSubscriptionContextValue {
  isSubscribed: boolean;
}

const MetricSubscriptionContext = createContext<MetricSubscriptionContextValue>({
  isSubscribed: false,
});

export function useMetricSubscriptionContext() {
  return useContext(MetricSubscriptionContext);
}

interface MetricSubscriptionProviderProps {
  entityType: MetricEntityType;
  entityId: number;
  children: ReactNode;
}

/**
 * Wraps a component to subscribe to metric updates only when visible.
 * Reuses the app-level `IntersectionObserverProvider` for visibility detection
 * (single shared observer across all cards on a page).
 * Controlled by the live-metrics Flipt flag.
 */
export function MetricSubscriptionProvider({
  entityType,
  entityId,
  children,
}: MetricSubscriptionProviderProps) {
  const liveMetricsEnabled = useLiveMetricsEnabled();

  // When feature is disabled, render children directly without any subscription logic
  if (!liveMetricsEnabled) {
    return <>{children}</>;
  }

  return (
    <MetricSubscriptionProviderInner entityType={entityType} entityId={entityId}>
      {children}
    </MetricSubscriptionProviderInner>
  );
}

/**
 * Inner component that handles the actual subscription logic.
 * Only rendered when the feature flag is enabled.
 */
function MetricSubscriptionProviderInner({
  entityType,
  entityId,
  children,
}: MetricSubscriptionProviderProps) {
  const [ref, isVisible] = useInView<HTMLDivElement>();

  // Only subscribe when visible
  const topic = isVisible
    ? (`${SignalTopic.Metric}:${entityType}:${entityId}` as const)
    : undefined;

  useSignalTopic(topic);

  const contextValue = useMemo(() => ({ isSubscribed: isVisible }), [isVisible]);

  return (
    <div ref={ref}>
      <MetricSubscriptionContext.Provider value={contextValue}>
        {children}
      </MetricSubscriptionContext.Provider>
    </div>
  );
}
