import type { ServiceFeedOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { serviceStorefrontHref } from '~/components/CreatorShop/section-meta';

export function ServiceFeedCard({ offering }: { offering: ServiceFeedOffering }) {
  return (
    <ServiceOfferingCard
      offering={offering}
      seller={offering.seller}
      sellerId={offering.seller.id}
      sellerUsername={offering.seller.username ?? ''}
      slotsOpen={offering.slotsOpen}
      href={serviceStorefrontHref(offering.seller.username ?? '', offering.id)}
    />
  );
}
