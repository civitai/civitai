// Full-bleed gold band behind the Featured header.
export const GOLD_HEADER_GRADIENT =
  'linear-gradient(135deg, var(--mantine-color-orange-5), var(--mantine-color-yellow-4))';
// Subtler vertical echo used for the per-section accent bar.
export const GOLD_ACCENT_GRADIENT =
  'linear-gradient(180deg, var(--mantine-color-yellow-4), var(--mantine-color-orange-5))';

export type SortKey = 'newest' | 'price-asc' | 'price-desc' | 'name';

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price: Low to high' },
  { value: 'price-desc', label: 'Price: High to low' },
  { value: 'name', label: 'Name' },
];
