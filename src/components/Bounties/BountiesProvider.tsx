import { Popover, Indicator, ActionIcon, Stack, Checkbox } from '@mantine/core';
import { MetricTimeframe, ModelType } from '@prisma/client';
import { IconFilter } from '@tabler/icons';
import { deleteCookie, setCookie as sc } from 'cookies-next';
import { immer } from 'zustand/middleware/immer';
import createContext from 'zustand/context';
import { z } from 'zod';
import create from 'zustand';

import { bountiesFilterSchema, useCookies } from '~/providers/CookiesProvider';
import { BountySort } from '~/server/common/enums';
import { addToDate } from '~/utils/date-helpers';
import { constants } from '~/server/common/constants';
import { useRouter } from 'next/router';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { splitUppercase } from '~/utils/string-helpers';

const setCookie = (key: string, data: unknown) =>
  sc(key, data, {
    expires: addToDate(new Date(), 1, 'year').toDate(),
  });

type FilterProps = z.input<typeof bountiesFilterSchema>;
type Store = {
  filters: FilterProps;
  setSort: (sort?: BountySort) => void;
  setPeriod: (period?: MetricTimeframe) => void;
  setTypes: (types?: ModelType[]) => void;
};

const { Provider, useStore } = createContext<ReturnType<typeof createMyStore>>();
const createMyStore = (initialState: FilterProps) => {
  return create<Store>()(
    immer((set) => {
      return {
        filters: { ...initialState },
        setSort: (sort) => {
          set((state) => {
            state.filters.sort = sort;
            !!sort ? setCookie('b_sort', sort) : deleteCookie('b_sort');
          });
        },
        setPeriod: (period) => {
          set((state) => {
            state.filters.period = period;
            !!period ? setCookie('b_period', period) : deleteCookie('b_period');
          });
        },
        setTypes: (types) => {
          set((state) => {
            state.filters.types = types;
            !!types?.length ? setCookie('b_types', types) : deleteCookie('b_types');
          });
        },
      };
    })
  );
};

export function Bounties({ children }: { children: React.ReactNode }) {
  const {
    sort = constants.bountyFilterDefaults.sort,
    period = constants.bountyFilterDefaults.period,
    types,
  } = useCookies().bounties;
  return <Provider createStore={() => createMyStore({ sort, period, types })}>{children}</Provider>;
}

export const useBountyFilters = () => {
  const router = useRouter();
  const page = router.query.page ? Number(router.query.page) : 1;
  const limit = constants.questionFilterDefaults.limit;
  const filters = useStore((state) => state.filters);

  return { ...filters, page, limit };
};

const sortOptions = Object.values(BountySort);
function BountiesSort() {
  const setSort = useStore((state) => state.setSort);
  const sort = useStore((state) => state.filters.sort);

  return (
    <SelectMenu
      label={sort && splitUppercase(sort)}
      options={sortOptions.map((x) => ({ label: splitUppercase(x), value: x }))}
      onClick={(sort) => setSort(sort)}
      value={sort}
    />
  );
}

const periodOptions = Object.values(MetricTimeframe);
function BountiesPeriod() {
  const setPeriod = useStore((state) => state.setPeriod);
  const period = useStore((state) => state.filters.period);

  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={(period) => setPeriod(period)}
      value={period}
    />
  );
}

function BountiesFilter() {
  const setTypes = useStore((state) => state.setTypes);
  const types = useStore((state) => state.filters.types ?? []);

  const filterLength = types.length;

  return (
    <Popover withArrow>
      <Popover.Target>
        <Indicator
          offset={4}
          label={filterLength ? filterLength : undefined}
          showZero={false}
          dot={false}
          size={16}
          inline
          zIndex={10}
        >
          <ActionIcon color="dark" variant="transparent">
            <IconFilter size={24} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack>
          <Checkbox.Group
            value={types}
            label="Model types"
            orientation="vertical"
            spacing="xs"
            size="md"
            onChange={(types: ModelType[]) => setTypes(types)}
          >
            {Object.values(ModelType).map((type, index) => (
              <Checkbox key={index} value={type} label={splitUppercase(type)} />
            ))}
          </Checkbox.Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

Bounties.Sort = BountiesSort;
Bounties.Period = BountiesPeriod;
Bounties.Filter = BountiesFilter;
