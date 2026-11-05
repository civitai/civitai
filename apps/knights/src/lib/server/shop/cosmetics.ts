/** A sticker with no `uses` is unlimited; with `uses`, each purchase is a row holding that many. */
export const stickerUses = (data: unknown): number | null => {
  const uses = (data as { uses?: unknown } | null)?.uses;
  return typeof uses === 'number' && Number.isFinite(uses) && uses > 0 ? Math.floor(uses) : null;
};

export const cosmeticImageKey = (data: unknown): string | null => {
  const url = (data as { url?: unknown } | null)?.url;
  return typeof url === 'string' && url ? url : null;
};

/** Everything but a sticker is bought once; a sticker is bought again for more uses until a holding is unlimited. */
export function holdingBlocksPurchase(
  type: string,
  held: { remaining: number | null }[]
): 'owned' | 'unlimited' | null {
  if (type === 'Sticker') return held.some((row) => row.remaining === null) ? 'unlimited' : null;
  return held.length > 0 ? 'owned' : null;
}
