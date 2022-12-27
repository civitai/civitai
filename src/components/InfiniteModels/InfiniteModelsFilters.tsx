import create from 'zustand';
import { ModelType, MetricTimeframe } from '@prisma/client';
import { ModelSort } from '~/server/common/enums';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { splitUppercase } from '~/utils/string-helpers';
import { deleteCookie, setCookie as sc } from 'cookies-next';
import { immer } from 'zustand/middleware/immer';
import { modelFilterSchema, useCookies } from '~/providers/CookiesProvider';
import { Popover, ActionIcon, Stack, Checkbox, Indicator, Divider } from '@mantine/core';
import { IconFilter } from '@tabler/icons';
import { z } from 'zod';
import { BaseModel, constants } from '~/server/common/constants';
import dayjs from 'dayjs';

const setCookie = (key: string, data: any) => // eslint-disable-line
  sc(key, data, {
    expires: dayjs().add(1, 'year').toDate(),
  });

type FilterProps = z.input<typeof modelFilterSchema>;

export const useFilters = create<{
  filters: FilterProps;
  setSort: (sort?: ModelSort) => void;
  setPeriod: (period?: MetricTimeframe) => void;
  setTypes: (types?: ModelType[]) => void;
  setBaseModels: (baseModels?: BaseModel[]) => void;
}>()(
  immer((set, get) => ({//eslint-disable-line
    filters: {},
    setSort: (sort) => {
      set((state) => {
        state.filters.sort = sort;
        !!sort ? setCookie('f_sort', sort) : deleteCookie('f_sort');
      });
    },
    setPeriod: (period) => {
      set((state) => {
        state.filters.period = period;
        !!period ? setCookie('f_period', period) : deleteCookie('f_period');
      });
    },
    setTypes: (types) => {
      set((state) => {
        state.filters.types = types;
        !!types?.length ? setCookie('f_types', types) : deleteCookie('f_types');
      });
    },
    setBaseModels: (baseModels) => {
      set((state) => {
        state.filters.baseModels = baseModels;
        !!baseModels?.length ? setCookie('f_baseModels', baseModels) : deleteCookie('f_baseModels');
      });
    },
  }))
);

export const useInfiniteModelsFilters = () => {
  const {
    sort = constants.modelFilterDefaults.sort,
    period = constants.modelFilterDefaults.period,
    baseModels,
    types,
  } = useCookies();

  const filters = useFilters((state) => state.filters);
  return { limit: 100, sort, period, types, baseModels, ...filters };
};

const sortOptions = Object.values(ModelSort);
export function InfiniteModelsSort() {
  const cookies = useCookies();
  const setSort = useFilters((state) => state.setSort);
  const sort = useFilters(
    (state) => state.filters.sort ?? cookies.sort ?? constants.modelFilterDefaults.sort
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
export function InfiniteModelsPeriod() {
  const cookies = useCookies();
  const setPeriod = useFilters((state) => state.setPeriod);
  const period = useFilters(
    (state) => state.filters.period ?? cookies.period ?? constants.modelFilterDefaults.period
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

export function InfiniteModelsFilter() {
  const cookies = useCookies();
  const setTypes = useFilters((state) => state.setTypes);
  const types = useFilters((state) => state.filters.types ?? cookies.types ?? []);
  const setBaseModels = useFilters((state) => state.setBaseModels);
  const baseModels = useFilters((state) => state.filters.baseModels ?? cookies.baseModels ?? []);

  const filterLength = types.length + baseModels.length;

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
          <Divider />
          <Checkbox.Group
            value={baseModels}
            label="Base model"
            orientation="vertical"
            spacing="xs"
            size="md"
            onChange={(baseModels: BaseModel[]) => setBaseModels(baseModels)}
          >
            {constants.baseModels.map((baseModel, index) => (
              <Checkbox key={index} value={baseModel} label={baseModel} />
            ))}
          </Checkbox.Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
