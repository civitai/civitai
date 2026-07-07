import { useMemo, useState } from 'react';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import type { SortKey, StatusFilterValue } from '~/components/CreatorShop/Manage/manage.constants';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

const revenueOf = (item: CreatorShopManageItem) => item.purchases * item.unitAmount;

const comparators: Record<SortKey, (a: CreatorShopManageItem, b: CreatorShopManageItem) => number> =
  {
    newest: (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
    best: (a, b) => b.purchases - a.purchases,
    revenue: (a, b) => revenueOf(b) - revenueOf(a),
    'price-high': (a, b) => b.unitAmount - a.unitAmount,
    'price-low': (a, b) => a.unitAmount - b.unitAmount,
    name: (a, b) => a.title.localeCompare(b.title),
  };

export type ManageStats = {
  published: number;
  pending: number;
  units: number;
  revenue: number;
};

// Owns the toolbar control state and derives the filtered/sorted list + headline
// stats, keeping the page body declarative.
export function useManageItems(items: CreatorShopManageItem[]) {
  const [status, setStatus] = useState<StatusFilterValue>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = items.filter((i) => {
      const statusMatch = status === 'all' || i.status === status;
      const titleMatch = !q || i.title.toLowerCase().includes(q);
      return statusMatch && titleMatch;
    });
    result.sort(comparators[sort] ?? comparators.newest);
    return result;
  }, [items, status, search, sort]);

  const stats = useMemo<ManageStats>(() => {
    const by = (s: CosmeticShopItemStatus) => items.filter((i) => i.status === s).length;
    return {
      published: by(CosmeticShopItemStatus.Published),
      pending: by(CosmeticShopItemStatus.PendingReview),
      units: items.reduce((sum, i) => sum + i.purchases, 0),
      revenue: items.reduce((sum, i) => sum + revenueOf(i), 0),
    };
  }, [items]);

  return { status, setStatus, search, setSearch, sort, setSort, filtered, stats };
}
