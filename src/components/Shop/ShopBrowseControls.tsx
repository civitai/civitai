import { Group, Pagination } from '@mantine/core';
import { IconLayoutGrid } from '@tabler/icons-react';
import type { Dispatch, SetStateAction } from 'react';
import type { ShopFilters } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { ShopFiltersDropdown } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { CosmeticShopSort } from '~/server/common/enums';
import type { ShopFilterType } from '~/server/schema/creator-shop.schema';
import { COSMETIC_SHOP_PAGE_SIZES } from '~/shared/constants/cosmetic-shop.constants';

const sortOptions = Object.values(CosmeticShopSort).map((value) => ({ label: value, value }));
const pageSizeOptions = COSMETIC_SHOP_PAGE_SIZES.map((value) => ({
  label: `${value} / page`,
  value: value as number,
}));

// Sort + page size + filters, identical on every shop surface. Presentational
// on purpose: /shop drives all its sections from one bar, while each storefront
// section and the community hub own theirs.
export function ShopBrowseControls({
  sort,
  onSortChange,
  pageSize,
  onPageSizeChange,
  filters,
  setFilters,
  availableTypes,
}: {
  sort: CosmeticShopSort;
  onSortChange: (sort: CosmeticShopSort) => void;
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
  filters: ShopFilters;
  setFilters: Dispatch<SetStateAction<ShopFilters>>;
  availableTypes?: ShopFilterType[];
}) {
  return (
    <Group gap={8} justify="flex-end" wrap="nowrap">
      <SelectMenuV2 label={sort} value={sort} options={sortOptions} onClick={onSortChange} />
      <SelectMenuV2
        label={`${pageSize} / page`}
        value={pageSize}
        options={pageSizeOptions}
        icon={IconLayoutGrid}
        onClick={onPageSizeChange}
      />
      <ShopFiltersDropdown
        filters={filters}
        setFilters={setFilters}
        availableTypes={availableTypes}
      />
    </Group>
  );
}

// Rendered only once a grid actually spills, so a six-item section stays a
// six-item section.
export function ShopBrowsePagination({
  page,
  onChange,
  totalPages,
}: {
  page: number;
  onChange: (page: number) => void;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;
  return <Pagination className="mx-auto" value={page} onChange={onChange} total={totalPages} />;
}
