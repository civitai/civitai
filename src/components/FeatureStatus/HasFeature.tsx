import { useFeatureStatusContext } from '~/components/FeatureStatus/FeatureStatusProvider';
import type { FeatureStatusLiteral } from '~/server/schema/feature-status.schema';

export function HasFeature({
  children,
  feature,
}: {
  children: React.ReactElement | null;
  feature: FeatureStatusLiteral;
}) {
  const context = useFeatureStatusContext();
  const data = context?.[feature];
  if (data?.disabled) return null;
  return children;
}
