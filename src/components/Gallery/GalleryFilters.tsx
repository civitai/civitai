import { MetricTimeframe } from '@prisma/client';
import { deleteCookie } from 'cookies-next';
import { useRouter } from 'next/router';
import z from 'zod';
import create from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { galleryFilterSchema, useCookies } from '~/providers/CookiesProvider';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { setCookie } from '~/utils/cookies-helpers';
import { splitUppercase } from '~/utils/string-helpers';

type FilterProps = z.input<typeof galleryFilterSchema>;
type Store = {
  filters: FilterProps;
  setSort: (sort?: ImageSort) => void;
  setPeriod: (period?: MetricTimeframe) => void;
  setHideNsfw: (hide?: boolean) => void;
};

const useFiltersStore = create<Store>()(
  immer((set) => ({
    filters: {},
    setSort: (sort) => {
      set((state) => {
        state.filters.sort = sort;
        !!sort ? setCookie('g_sort', sort) : deleteCookie('g_sort');
      });
    },
    setPeriod: (period) => {
      set((state) => {
        state.filters.period = period;
        !!period ? setCookie('g_period', period) : deleteCookie('g_period');
      });
    },
    setHideNsfw: (hide) => {
      set((state) => {
        state.filters.hideNSFW = hide;
        hide ? setCookie('g_hideNSFW', hide) : deleteCookie('g_hideNSFW');
      });
    },
  }))
);

export const useGalleryFilters = () => {
  const router = useRouter();
  const page = router.query.page ? Number(router.query.page) : 1;
  const limit = constants.imageFilterDefaults.limit;
  const filters = useFiltersStore((state) => state.filters);
  return { ...filters, page, limit };
};

const sortOptions = Object.values(ImageSort);
export function GallerySort() {
  const cookies = useCookies().gallery;
  const setSort = useFiltersStore((state) => state.setSort);
  const sort = useFiltersStore(
    (state) => state.filters.sort ?? cookies.sort ?? constants.imageFilterDefaults.sort
  );

  return (
    <SelectMenu
      label={sort}
      options={sortOptions.map((x) => ({ label: x, value: x }))}
      onClick={(sort) => setSort(sort)}
      value={sort}
    />
  );
}

const periodOptions = Object.values(MetricTimeframe);
export function GalleryPeriod() {
  const cookies = useCookies().gallery;
  const setPeriod = useFiltersStore((state) => state.setPeriod);
  const period = useFiltersStore(
    (state) => state.filters.period ?? cookies.period ?? constants.imageFilterDefaults.period
  );

  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={(period) => setPeriod(period)}
      value={period}
    />
  );
}
