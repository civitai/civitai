import { Stack } from '@mantine/core';
import { useQueryShopServices } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';

export function ServicesSection({ ownerUserId }: { ownerUserId: number }) {
  const { offerings } = useQueryShopServices(ownerUserId, ownerUserId > 0);
  if (offerings.length === 0) return null;

  return (
    <Stack gap="md">
      <SectionHeader
        icon={sectionIcons.services}
        title="Services"
        subtitle="Commission this creator. Your Buzz is held in escrow and only released when you approve the work."
      />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
        {offerings.map((offering) => (
          <ServiceOfferingCard key={offering.id} offering={offering} />
        ))}
      </div>
    </Stack>
  );
}
