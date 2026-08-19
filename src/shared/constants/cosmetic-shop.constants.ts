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

// How many nearest cosmetics the creator-shop review panel lists.
//
// A rank limit, not a distance cutoff. Measured over the 950 hashed cosmetics on
// 2026-08-14: a cutoff loose enough to reach the two badges reported as
// imitations of official artwork (Hamming 17 and 22 of 64) returns a median of 39
// neighbours and up to 192, because those distances sit at the 1st and 5th
// percentile of *unrelated* artwork. The nearest few are bounded whatever the
// corpus does, and an exact re-upload still sorts first.
export const COSMETIC_SIMILARITY_LIMIT = 10;

// Fraction of the hash width below which artwork is near-identical rather than
// merely alike — 8 bits at the current 64. Every cross-creator pair at or under
// it in the corpus is a real re-upload, including two clones of official badges
// that the submission-time sha256 cannot see because official cosmetics carry no
// `imageHash`. A fraction rather than a constant so it survives a width upgrade.
export const COSMETIC_SIMILARITY_CLOSE_RATIO = 0.125;
