export type CoverSlot = 'cover' | 'banner';

/**
 * Tiles are drawn in the crop the pick will show, so a banner is chosen from wide tiles and not
 * from slices of a portrait one.
 */
export function coverPickerTile(slot: CoverSlot, bannerPosition: number) {
  return slot === 'banner'
    ? { ratio: '16/6' as const, columnsClass: 'grid-cols-2 sm:grid-cols-3', focusY: bannerPosition }
    : {
        ratio: '3/4' as const,
        columnsClass: 'grid-cols-3 sm:grid-cols-4',
        focusY: undefined as number | undefined,
      };
}
