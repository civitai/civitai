import { Badge, Button, Group, Stack } from '@mantine/core';
import { useQueryShopServices } from '~/components/CreatorShop/Services/creator-service.util';
import { openDealsOnOffering } from '~/components/CreatorShop/Services/deals/deal-ui';
import { useMyServiceDeals } from '~/components/CreatorShop/Services/deals/deal.util';
import { ServiceRequestModal } from '~/components/CreatorShop/Services/deals/ServiceRequestModal';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { ReportServiceButton } from '~/components/CreatorShop/Services/ReportServiceButton';
import { sectionIcons, storefrontSectionId } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function ServicesSection({
  ownerUserId,
  username,
  shopPublished,
}: {
  ownerUserId: number;
  username: string;
  /** A draft shop answers "Shop not found" to a buyer's request. A moderator can still see it, so don't offer one. */
  shopPublished: boolean;
}) {
  const currentUser = useCurrentUser();
  const { offerings } = useQueryShopServices(ownerUserId, ownerUserId > 0);
  const isOwner = !!currentUser && currentUser.id === ownerUserId;
  // The seller's own open deals: the same list as Incoming requests on the manage page.
  const {
    deals: openDeals,
    hasNextPage,
    hiddenOffDomain,
  } = useMyServiceDeals({
    role: 'seller',
    status: 'open',
    enabled: isOwner && offerings.length > 0,
  });
  if (offerings.length === 0) return null;

  const manageHref = `/user/${username}/shop/manage?tab=services`;
  const allOpenDealsLoaded = !hasNextPage && hiddenOffDomain === 0;

  return (
    <Stack gap="md" id={storefrontSectionId('services')} className="scroll-mt-20">
      <SectionHeader
        icon={sectionIcons.services}
        title="Services"
        subtitle="Commission this creator. Your Buzz is held in escrow and only released when the work is done."
      />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
        {offerings.map((offering) => {
          const full = offering.slotsOpen === 0;
          const openDeal = isOwner
            ? openDealsOnOffering(openDeals, offering.id, allOpenDealsLoaded)
            : undefined;
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
                  {isOwner && (
                    <Group gap={4} ml="auto" wrap="nowrap">
                      <Button component={NextLink} href={manageHref} size="xs" variant="default">
                        Manage
                      </Button>
                      {openDeal && (
                        <Button
                          component={NextLink}
                          href={openDeal.dealId ? `/services/deals/${openDeal.dealId}` : manageHref}
                          size="xs"
                          color="yellow"
                        >
                          {openDeal.label}
                        </Button>
                      )}
                    </Group>
                  )}
                  {!isOwner && (
                    <Group gap={4} ml="auto" wrap="nowrap">
                      <ReportServiceButton offeringId={offering.id} />
                      {shopPublished && (
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
                      )}
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
