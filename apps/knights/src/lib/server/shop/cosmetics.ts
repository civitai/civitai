/** A sticker with no `uses` is unlimited; with `uses`, each purchase is a row holding that many. */
export const stickerUses = (data: unknown): number | null => {
  const uses = (data as { uses?: unknown } | null)?.uses;
  return typeof uses === 'number' && Number.isFinite(uses) && uses > 0 ? Math.floor(uses) : null;
};

/** The CDN key of a cosmetic's image, when it has one. */
export const cosmeticImageKey = (data: unknown): string | null => {
  const url = (data as { url?: unknown } | null)?.url;
  return typeof url === 'string' && url ? url : null;
};

/**
 * Why a player cannot buy a cosmetic they already hold, or null when they can. Everything but a sticker is bought once;
 * a sticker is bought again for more uses until a holding is unlimited. One rule for the card and for the purchase.
 */
export function holdingBlocksPurchase(
  type: string,
  held: { remaining: number | null }[]
): 'owned' | 'unlimited' | null {
  if (type === 'Sticker') return held.some((row) => row.remaining === null) ? 'unlimited' : null;
  return held.length > 0 ? 'owned' : null;
}
