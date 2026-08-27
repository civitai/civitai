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
// A rank limit, not a distance cutoff. It earned that shape at 64 bits, where a
// cutoff loose enough to reach a known imitation returned a median of 39
// neighbours and up to 192 — the distance that found it was also the 1st
// percentile of *unrelated* artwork. The 256-bit lane no longer needs the
// protection (median 0, max 3 at the close ratio), but the nearest few stay
// bounded whatever the corpus does, and an exact re-upload still sorts first.
export const COSMETIC_SIMILARITY_LIMIT = 10;

// Fraction of the hash width below which artwork is near-identical rather than
// merely alike — 32 bits at the current 256. Every cross-creator pair at or under
// it is a real re-upload, including three clones of official badges that the
// submission-time sha256 cannot see because official cosmetics carry no
// `imageHash`. A fraction rather than a constant so it survives a width upgrade,
// and it did: the same 0.125 selects the same five cross-creator pairs anywhere
// between 8 and 40 of 256, so the value sits on a plateau rather than on an edge.
export const COSMETIC_SIMILARITY_CLOSE_RATIO = 0.125;
