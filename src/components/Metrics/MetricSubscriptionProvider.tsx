import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSignalTopic } from '~/components/Signals/SignalsProvider';
import { SignalTopic } from '~/server/common/enums';
import type { MetricEntityType } from '~/components/Signals/metric-signals.types';

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
  /** Distance from viewport to start subscribing. Default: 200px */
  rootMargin?: string;
}

/**
 * Wraps a component to subscribe to metric updates only when visible.
 * Uses IntersectionObserver to detect visibility.
 */
export function MetricSubscriptionProvider({
  entityType,
  entityId,
  children,
  rootMargin = '200px',
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
  const topic = isVisible
    ? (`${SignalTopic.Metric}:${entityType}:${entityId}` as const)
    : undefined;
  useSignalTopic(topic);

  return (
    <div ref={ref}>
      <MetricSubscriptionContext.Provider value={{ isSubscribed: isVisible }}>
        {children}
      </MetricSubscriptionContext.Provider>
    </div>
  );
}
