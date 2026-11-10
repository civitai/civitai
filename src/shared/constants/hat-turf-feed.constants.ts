/** The image feed's Hat Turf sorts: by counted hats, highest or lowest first. */
export const HAT_SORTS = ['most', 'fewest'] as const;
export type HatSort = (typeof HAT_SORTS)[number];

export const HAT_SORT_LABELS: Record<HatSort, string> = {
  most: 'Most hats',
  fewest: 'Fewest hats',
};
