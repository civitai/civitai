import { useEffect, useRef, type ReactNode } from 'react';
import type { MetricEntityType, MetricType } from '~/components/Signals/metric-signals.types';
import { signalDebug } from '~/components/Signals/signalDebug';
import { useLiveMetrics } from './useLiveMetrics';
import { useMetricSubscription } from './useMetricSubscription';

type MetricsInput = Partial<Record<MetricType, number | undefined>>;

type MetricsProps<T extends MetricsInput> = {
  entityType: MetricEntityType;
  entityId: number;
  /** Base metric values; live deltas from the store are applied on top. */
  initial: T;
  /**
   * When true (default), subscribes to live updates and applies deltas.
   * When false, renders `children` with `initial` unchanged — no subscription
   * runs. Pair with `useElementInView()` to gate on visibility.
   */
  useLive?: boolean;
  children: (metrics: T) => ReactNode;
};

/**
 * Provides live-metric values to `children` via a render prop. Gates
 * subscription behind `useLive` so off-screen cards (or consumers that don't
 * want live updates) can skip the subscription without conditionally calling
 * hooks.
 *
 * @example
 * ```tsx
 * const inView = useElementInView();
 * <Metrics
 *   entityType="Image"
 *   entityId={image.id}
 *   initial={baseMetrics}
 *   useLive={inView !== false}
 * >
 *   {(metrics) => <Reactions ... metrics={metrics} />}
 * </Metrics>
 * ```
 */
export function Metrics<T extends MetricsInput>({
  entityType,
  entityId,
  initial,
  useLive = true,
  children,
}: MetricsProps<T>) {
  const renders = useRef(0);
  renders.current += 1;
  signalDebug('Metrics render', {
    entityType,
    entityId,
    useLive,
    renderCount: renders.current,
  });
  if (!useLive) return <>{children(initial)}</>;
  return (
    <MetricsLive entityType={entityType} entityId={entityId} initial={initial}>
      {children}
    </MetricsLive>
  );
}

function MetricsLive<T extends MetricsInput>({
  entityType,
  entityId,
  initial,
  children,
}: {
  entityType: MetricEntityType;
  entityId: number;
  initial: T;
  children: (metrics: T) => ReactNode;
}) {
  const renders = useRef(0);
  renders.current += 1;
  useEffect(() => {
    signalDebug('MetricsLive mount', { entityType, entityId });
    return () => signalDebug('MetricsLive unmount', { entityType, entityId });
  }, [entityType, entityId]);
  useMetricSubscription(entityType, entityId);
  const metrics = useLiveMetrics(entityType, entityId, initial);
  signalDebug('MetricsLive render', {
    entityType,
    entityId,
    renderCount: renders.current,
  });
  return <>{children(metrics)}</>;
}
