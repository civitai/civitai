/**
 * Why "Publish shop" is disabled, or undefined when it can be pressed. The server decides for real
 * (`updateCreatorShopSettings`); this only spares an obviously empty shop the round trip.
 *
 * A shop fills with cosmetics, or, for the owner with `creatorServices`, an Active service. The owner's
 * list leaves out offerings this domain may not show (`hiddenOffDomain`); any of those might be Active,
 * so they leave the button enabled and the server answers.
 */
export function shopPublishBlockedReason({
  loading,
  cosmeticCount,
  servicesCount,
  activeServiceCount,
  hiddenServiceCount,
}: {
  loading: boolean;
  cosmeticCount: number;
  /** Whether this viewer's services can fill the shop (the owner, with the services flag). */
  servicesCount: boolean;
  activeServiceCount: number;
  hiddenServiceCount: number;
}): string | undefined {
  if (loading || cosmeticCount > 0) return undefined;
  if (servicesCount && (activeServiceCount > 0 || hiddenServiceCount > 0)) return undefined;
  return servicesCount
    ? 'Add an item or publish a service before publishing your shop.'
    : 'Add at least one item before publishing your shop.';
}
