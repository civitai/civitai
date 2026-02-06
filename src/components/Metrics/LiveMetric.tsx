import { Text, type TextProps } from '@mantine/core';
import { useLiveMetric } from './useLiveMetrics';
import { abbreviateNumber } from '~/utils/number-helpers';
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
  const displayValue = abbreviate ? abbreviateNumber(liveValue) : liveValue.toString();

  return <Text {...textProps}>{displayValue}</Text>;
}
