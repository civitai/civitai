import { Button, Group } from '@mantine/core';
import type { ServiceFeedOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { ServiceSlotsBadge } from '~/components/CreatorShop/Services/ServiceSlotsBadge';
import { serviceStorefrontHref } from '~/components/CreatorShop/section-meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';

export function ServiceFeedCard({ offering }: { offering: ServiceFeedOffering }) {
  return (
    <ServiceOfferingCard
      offering={offering}
      footer={
        <Group justify="space-between" mt="sm" wrap="nowrap" gap="xs">
          <UserAvatar user={offering.seller} withUsername linkToProfile size="xs" />
          <Group gap={4} wrap="nowrap">
            <ServiceSlotsBadge slotsOpen={offering.slotsOpen} />
            <Button
              component={NextLink}
              href={serviceStorefrontHref(offering.seller.username ?? '', offering.id)}
              size="xs"
            >
              View
            </Button>
          </Group>
        </Group>
      }
    />
  );
}
