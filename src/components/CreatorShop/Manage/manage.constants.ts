import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

export type StatusFilterValue = 'all' | CosmeticShopItemStatus;
export type SortKey = 'newest' | 'best' | 'revenue' | 'price-high' | 'price-low' | 'name';

export const statusMeta: Record<CosmeticShopItemStatus, { label: string; color: string }> = {
  Draft: { label: 'Draft', color: 'gray' },
  PendingReview: { label: 'Pending Review', color: 'yellow' },
  Published: { label: 'Published', color: 'green' },
  RequestedChanges: { label: 'Changes Requested', color: 'orange' },
  Rejected: { label: 'Rejected', color: 'red' },
  Archived: { label: 'Archived', color: 'gray' },
};

export const statusFilters: Array<{ value: StatusFilterValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: CosmeticShopItemStatus.Published, label: 'Published' },
  { value: CosmeticShopItemStatus.PendingReview, label: 'Pending Review' },
  { value: CosmeticShopItemStatus.RequestedChanges, label: 'Changes Requested' },
  { value: CosmeticShopItemStatus.Draft, label: 'Draft' },
  { value: CosmeticShopItemStatus.Rejected, label: 'Rejected' },
  { value: CosmeticShopItemStatus.Archived, label: 'Archived' },
];

export const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'best', label: 'Best selling' },
  { value: 'revenue', label: 'Top revenue' },
  { value: 'price-high', label: 'Price: High to Low' },
  { value: 'price-low', label: 'Price: Low to High' },
  { value: 'name', label: 'Name (A–Z)' },
];
