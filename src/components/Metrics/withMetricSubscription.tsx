import type { ComponentType } from 'react';
import { MetricSubscriptionProvider } from './MetricSubscriptionProvider';
import type { MetricEntityType } from '~/components/Signals/metric-signals.types';

interface WithMetricSubscriptionProps {
  id: number;
}

/**
 * HOC that wraps a component with MetricSubscriptionProvider.
 * The wrapped component must have an `id` prop.
 *
 * @example
 * ```tsx
 * const ModelCardWithMetrics = withMetricSubscription(ModelCardBase, 'Model');
 * // Now <ModelCardWithMetrics id={123} ... /> will auto-subscribe when visible
 * ```
 */
export function withMetricSubscription<P extends WithMetricSubscriptionProps>(
  WrappedComponent: ComponentType<P>,
  entityType: MetricEntityType
) {
  function WithMetricSubscription(props: P) {
    return (
      <MetricSubscriptionProvider entityType={entityType} entityId={props.id}>
        <WrappedComponent {...props} />
      </MetricSubscriptionProvider>
    );
  }

  WithMetricSubscription.displayName = `withMetricSubscription(${
    WrappedComponent.displayName || WrappedComponent.name || 'Component'
  })`;

  return WithMetricSubscription;
}
