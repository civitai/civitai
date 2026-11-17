import { Button, Stack } from '@mantine/core';
import { useQueryShopServices } from '~/components/CreatorShop/Services/creator-service.util';
import { openDealsOnOffering } from '~/components/CreatorShop/Services/deals/deal-ui';
import { useMyServiceDeals } from '~/components/CreatorShop/Services/deals/deal.util';
import { ServiceOfferingCard } from '~/components/CreatorShop/Services/ServiceOfferingCard';
import { sectionIcons, storefrontSectionId } from '~/components/CreatorShop/section-meta';
import { ServiceCardAnchor } from '~/components/CreatorShop/Storefront/ServiceCardAnchor';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
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
          const openDeal = isOwner
            ? openDealsOnOffering(openDeals, offering.id, allOpenDealsLoaded)
            : undefined;
          return (
            <ServiceCardAnchor key={offering.id} offeringId={offering.id}>
              <ServiceOfferingCard
                offering={offering}
                sellerId={ownerUserId}
                sellerUsername={username}
                slotsOpen={offering.slotsOpen}
                canRequest={shopPublished}
                extra={
                  openDeal && (
                    <Button
                      component={NextLink}
                      href={openDeal.dealId ? `/services/deals/${openDeal.dealId}` : manageHref}
                      color="yellow"
                      fullWidth
                    >
                      {openDeal.label}
                    </Button>
                  )
                }
              />
            </ServiceCardAnchor>
          );
        })}
      </div>
    </Stack>
  );
}
