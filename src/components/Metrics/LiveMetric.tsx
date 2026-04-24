import { Text, type TextProps } from '@mantine/core';
import { useLiveMetric } from './useLiveMetrics';
import { AnimatedCount } from './AnimatedCount';
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
 * Pair with `useMetricSubscription` in the enclosing card body so the value
 * actually receives live updates.
 *
 * @example
 * ```tsx
 * function ModelCardContent({ data }) {
 *   useMetricSubscription('Model', data.id);
 *   return (
 *     <LiveMetric
 *       entityType="Model"
 *       entityId={data.id}
 *       metricType="downloadCount"
 *       baseValue={data.rank?.downloadCount ?? 0}
 *     />
 *   );
 * }
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

  return (
    <Text {...textProps}>
      <AnimatedCount value={liveValue} abbreviate={abbreviate} />
    </Text>
  );
}
