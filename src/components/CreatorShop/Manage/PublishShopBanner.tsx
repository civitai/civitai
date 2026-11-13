import { ShopDraftBanner } from '~/components/CreatorShop/Manage/ShopDraftBanner';
import { shopPublishBlockedReason } from '~/components/CreatorShop/Manage/publish-blocked';
import { useQueryMyServices } from '~/components/CreatorShop/Services/creator-service.util';
import { ServiceOfferingStatus } from '~/shared/utils/prisma/enums';

/** The draft banner on the manage page, with "Publish shop" enabled by whatever can fill this shop. */
export function PublishShopBanner({
  cosmeticCount,
  cosmeticsLoading,
  servicesCount,
  onEnable,
  enabling,
}: {
  cosmeticCount: number;
  cosmeticsLoading: boolean;
  /** Whether the viewer's own services can fill the shop: the owner, with the services flag. */
  servicesCount: boolean;
  onEnable: () => void;
  enabling: boolean;
}) {
  const services = useQueryMyServices(servicesCount);
  const disabledReason = shopPublishBlockedReason({
    loading: cosmeticsLoading || (servicesCount && services.isLoading),
    cosmeticCount,
    servicesCount,
    activeServiceCount: services.offerings.filter((o) => o.status === ServiceOfferingStatus.Active)
      .length,
    hiddenServiceCount: services.hiddenOffDomain,
  });
  return (
    <ShopDraftBanner onEnable={onEnable} enabling={enabling} disabledReason={disabledReason} />
  );
}
