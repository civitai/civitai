// Every shop grid pages at one of these, so a browser never holds hundreds of
// animated cosmetics at once. Shared by the official /shop sections, the creator
// storefronts, and the (server-paged) community hub.
//
// Kept out of `cosmetic-shop.schema.ts`: that module reaches `image.schema` →
// `constants.ts` → `src/env/client.ts`, which throws without the client env set,
// and importing it from `creator-shop.schema` drags that whole chain into every
// suite that touches a creator-shop service.
export const COSMETIC_SHOP_PAGE_SIZES = [24, 32, 48] as const;
export const COSMETIC_SHOP_DEFAULT_PAGE_SIZE = COSMETIC_SHOP_PAGE_SIZES[0];
