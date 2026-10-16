import { Badge, Button, Group, Stack } from '@mantine/core';
import { useQueryShopServices } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceRequestModal } from '~/components/CreatorShop/Services/deals/ServiceRequestModal';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { ReportServiceButton } from '~/components/CreatorShop/Services/ReportServiceButton';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function ServicesSection({
  ownerUserId,
  username,
}: {
  ownerUserId: number;
  username: string;
}) {
  const currentUser = useCurrentUser();
  const { offerings } = useQueryShopServices(ownerUserId, ownerUserId > 0);
  if (offerings.length === 0) return null;

  const isOwner = currentUser?.id === ownerUserId;

  return (
    <Stack gap="md">
      <SectionHeader
        icon={sectionIcons.services}
        title="Services"
        subtitle="Commission this creator. Your Buzz is held in escrow and only released when the work is done."
      />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
        {offerings.map((offering) => {
          const full = offering.slotsOpen === 0;
          return (
            <ServiceOfferingCard
              key={offering.id}
              offering={offering}
              footer={
                <Group justify="space-between" mt="sm" wrap="nowrap">
                  {offering.slotsOpen != null && (
                    <Badge color={full ? 'gray' : 'green'} variant="light" radius="sm">
                      {full
                        ? 'Fully booked'
                        : `${offering.slotsOpen} slot${offering.slotsOpen === 1 ? '' : 's'} open`}
                    </Badge>
                  )}
                  {!isOwner && (
                    <Group gap={4} ml="auto" wrap="nowrap">
                      <ReportServiceButton offeringId={offering.id} />
                      <LoginRedirect reason="perform-action">
                        <Button
                          color="yellow"
                          size="xs"
                          disabled={full}
                          onClick={() =>
                            dialogStore.trigger({
                              component: ServiceRequestModal,
                              props: { offering, sellerUsername: username },
                            })
                          }
                        >
                          Request
                        </Button>
                      </LoginRedirect>
                    </Group>
                  )}
                </Group>
              }
            />
          );
        })}
      </div>
    </Stack>
  );
}
