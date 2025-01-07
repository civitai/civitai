import { Alert, AlertProps } from '@mantine/core';
import { useFeatureStatusContext } from '~/components/FeatureStatus/FeatureStatusProvider';
import { FeatureStatusLiteral } from '~/server/schema/feature-status.schema';

export function FeatureStatus({
  feature,
  ...props
}: Omit<AlertProps, 'children' | 'color'> & { feature: FeatureStatusLiteral }) {
  const context = useFeatureStatusContext();
  const data = context?.[feature];
  return data ? (
    <Alert title="System Message" color="yellow" {...props}>
      {data.message}
    </Alert>
  ) : null;
}
