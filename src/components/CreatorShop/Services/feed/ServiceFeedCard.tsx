import { Badge, Button, Group } from '@mantine/core';
import type { ServiceFeedOffering } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { serviceCardId } from '~/components/CreatorShop/section-meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';

export const serviceStorefrontHref = (offering: Pick<ServiceFeedOffering, 'id' | 'seller'>) =>
  `/user/${offering.seller.username}/shop#${serviceCardId(offering.id)}`;

export function ServiceFeedCard({ offering }: { offering: ServiceFeedOffering }) {
  const full = offering.slotsOpen === 0;
  return (
    <ServiceOfferingCard
      offering={offering}
      footer={
        <Group justify="space-between" mt="sm" wrap="nowrap" gap="xs">
          <UserAvatar user={offering.seller} withUsername linkToProfile size="xs" />
          <Group gap={4} wrap="nowrap">
            {full && (
              <Badge color="gray" variant="light" radius="sm">
                Fully booked
              </Badge>
            )}
            <Button component={NextLink} href={serviceStorefrontHref(offering)} size="xs">
              View
            </Button>
          </Group>
        </Group>
      }
    />
  );
}
