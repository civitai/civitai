import type { Category } from '$lib/server/reactor-lookup.service';

export type CategoryMeta = {
  value: Category;
  label: string;
  heading: string;
  subtitle: string;
  countLabel: string;
  entityLabel: string;
  /**
   * Whether `minCount` reaches this category's query at all. False on collections: that pass takes no
   * floor, so rendering the control and the "over N" suffix there told a moderator who set Min to 50
   * that the unchanged rows below — several of them 1 — had each cleared 50.
   */
  hasFloor: boolean;
};

export const CATEGORIES: CategoryMeta[] = [
  {
    value: 'reactions',
    label: 'Reactions',
    heading: 'Reactors',
    subtitle: 'Concentration is the signal, not the count.',
    countLabel: 'Reactions',
    entityLabel: 'Items',
    hasFloor: true,
  },
  {
    value: 'stickers',
    label: 'Stickers',
    heading: 'Sticker placers',
    subtitle: 'Includes declined and removed placements.',
    countLabel: 'Stickers',
    entityLabel: 'Items',
    hasFloor: true,
  },
  {
    value: 'collections',
    label: 'Collections',
    heading: 'Collection adders',
    subtitle: 'Who has been adding this creator to collections.',
    countLabel: 'Items added',
    entityLabel: 'Collections',
    hasFloor: false,
  },
];

export const LOOKBACKS = [
  { value: '1', label: '1 day' },
  { value: '3', label: '3 days' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];
