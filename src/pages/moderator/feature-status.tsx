import { FeatureStatusList } from '~/components/FeatureStatus/FeatureStatusList';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { trpc } from '~/utils/trpc';
import { sortBy } from 'lodash-es';

export default function FeatureStatusPage() {
  const { data, isLoading } = trpc.featureStatus.getFeatureStatusesDistinct.useQuery();

  if (isLoading) return <PageLoader />;

  return (
    <div className="container">
      <FeatureStatusList data={sortBy(data, 'feature')} />
    </div>
  );
}
