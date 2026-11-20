import type { ServiceFeedOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { serviceHref } from '~/components/CreatorShop/section-meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function ServiceFeedCard({ offering }: { offering: ServiceFeedOffering }) {
  const features = useFeatureFlags();
  return (
    <ServiceOfferingCard
      offering={offering}
      seller={offering.seller}
      sellerId={offering.seller.id}
      sellerUsername={offering.seller.username ?? ''}
      slotsOpen={offering.slotsOpen}
      href={serviceHref({
        username: offering.seller.username ?? '',
        offering,
        next: features.creatorServicesNext,
      })}
    />
  );
}
