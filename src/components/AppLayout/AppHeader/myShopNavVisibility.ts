/**
 * Whether the user menu shows "Shop".
 *
 * Same rule as the shop itself: every Creator Shop endpoint sits behind the `creatorShop`
 * feature flag (`creatorShopProcedure`), so anyone holding it (testers, Creator Program,
 * moderators) can open their shop. The menu used to ALSO require the CreatorProgram
 * onboarding bit, which hid the entry from flag holders who could use the shop.
 */
export const myShopNavVisible = (features: { creatorShop?: boolean }) => !!features.creatorShop;
