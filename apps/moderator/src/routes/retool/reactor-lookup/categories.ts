import type { Category } from '$lib/server/reactor-lookup.service';

export type CategoryMeta = {
  value: Category;
  label: string;
  heading: string;
  subtitle: string;
  countLabel: string;
  entityLabel: string;
};

export const CATEGORIES: CategoryMeta[] = [
  {
    value: 'reactions',
    label: 'Reactions',
    heading: 'Reactors',
    subtitle: 'Concentration is the signal, not the count.',
    countLabel: 'Reactions',
    entityLabel: 'Items',
  },
  {
    value: 'stickers',
    label: 'Stickers',
    heading: 'Sticker placers',
    subtitle: 'Includes declined and removed placements.',
    countLabel: 'Stickers',
    entityLabel: 'Items',
  },
  {
    value: 'collections',
    label: 'Collections',
    heading: 'Collection adders',
    subtitle: 'Who has been adding this creator to collections.',
    countLabel: 'Items added',
    entityLabel: 'Collections',
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
