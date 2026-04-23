import { Text, type TextProps } from '@mantine/core';
import { useLiveMetric } from './useLiveMetrics';
import { AnimatedCount } from './AnimatedCount';
import { useMetricSubscriptionContext } from './MetricSubscriptionProvider';
import type { MetricEntityType, MetricType } from '~/components/Signals/metric-signals.types';

interface LiveMetricProps extends Omit<TextProps, 'children'> {
  entityType: MetricEntityType;
  entityId: number;
  metricType: MetricType;
  baseValue: number;
  /** Whether to abbreviate large numbers (e.g., 1000 -> 1k). Default: true */
  abbreviate?: boolean;
}

/**
 * A component that displays a metric value with live updates applied.
 * Use within a MetricSubscriptionProvider for automatic topic subscription.
 *
 * @example
 * ```tsx
 * <MetricSubscriptionProvider entityType="Model" entityId={data.id}>
 *   <LiveMetric
 *     entityType="Model"
 *     entityId={data.id}
 *     metricType="downloadCount"
 *     baseValue={data.rank?.downloadCount ?? 0}
 *   />
 * </MetricSubscriptionProvider>
 * ```
 */
export function LiveMetric({
  entityType,
  entityId,
  metricType,
  baseValue,
  abbreviate = true,
  ...textProps
}: LiveMetricProps) {
  const liveValue = useLiveMetric(entityType, entityId, metricType, baseValue);
  // Only animate while the surrounding MetricSubscriptionProvider reports the
  // card is visible. Offscreen cards render a plain formatted number — avoids
  // hundreds of NumberFlow shadow roots + the 60Hz rAF loop they drive.
  const { isSubscribed } = useMetricSubscriptionContext();

  return (
    <Text {...textProps}>
      <AnimatedCount value={liveValue} abbreviate={abbreviate} animate={isSubscribed} />
    </Text>
  );
}
