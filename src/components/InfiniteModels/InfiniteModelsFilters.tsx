import { ModelType, MetricTimeframe, CheckpointType } from '@prisma/client';
import {
  Popover,
  ActionIcon,
  Stack,
  Checkbox,
  Indicator,
  Divider,
  SegmentedControl,
  Button,
} from '@mantine/core';
import { IconChevronDown, IconFilter, IconFilterOff } from '@tabler/icons';
import { deleteCookie } from 'cookies-next';
import { z } from 'zod';
import create from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { modelFilterSchema, useCookies } from '~/providers/CookiesProvider';
import { BaseModel, constants } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';
import { setCookie } from '~/utils/cookies-helpers';
import { splitUppercase } from '~/utils/string-helpers';

type FilterProps = z.input<typeof modelFilterSchema>;

export const useFilters = create<{
  filters: FilterProps;
  setSort: (sort?: ModelSort) => void;
  setPeriod: (period?: MetricTimeframe) => void;
  setTypes: (types?: ModelType[]) => void;
  setCheckpointType: (checkpointType?: CheckpointType) => void;
  setBaseModels: (baseModels?: BaseModel[]) => void;
  setHideNSFW: (includeNSFW?: boolean) => void;
}>()(
  immer((set) => ({
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
    setCheckpointType: (type) => {
      set((state) => {
        state.filters.checkpointType = type;
        !!type ? setCookie('f_ckptType', type) : deleteCookie('f_ckptType');
      });
    },
    setBaseModels: (baseModels) => {
      set((state) => {
        state.filters.baseModels = baseModels;
        !!baseModels?.length ? setCookie('f_baseModels', baseModels) : deleteCookie('f_baseModels');
      });
    },
    setHideNSFW: (hideNSFW) => {
      set((state) => {
        state.filters.hideNSFW = hideNSFW;
        hideNSFW ? setCookie('f_hideNSFW', hideNSFW) : deleteCookie('f_hideNSFW');
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
    hideNSFW,
  } = useCookies().models;

  const filters = useFilters((state) => state.filters);
  return { limit: 100, sort, period, types, baseModels, hideNSFW, ...filters };
};

const sortOptions = Object.values(ModelSort);
export function InfiniteModelsSort() {
  const cookies = useCookies().models;
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
  const cookies = useCookies().models;
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
  const cookies = useCookies().models;
  const user = useCurrentUser();
  const setTypes = useFilters((state) => state.setTypes);
  const types = useFilters((state) => state.filters.types ?? cookies.types ?? []);
  const setBaseModels = useFilters((state) => state.setBaseModels);
  const baseModels = useFilters((state) => state.filters.baseModels ?? cookies.baseModels ?? []);
  const hideNSFW = useFilters((state) => state.filters.hideNSFW ?? cookies.hideNSFW ?? false);
  const setHideNSFW = useFilters((state) => state.setHideNSFW);
  const setCheckpointType = useFilters((state) => state.setCheckpointType);
  const checkpointType = useFilters(
    (state) => state.filters.checkpointType ?? cookies.checkpointType ?? 'all'
  );
  const showNSFWToggle = !user || user.showNsfw;
  const showCheckpointType = !types?.length || types.includes('Checkpoint');

  const filterLength =
    types.length +
    baseModels.length +
    (showNSFWToggle && hideNSFW ? 1 : 0) +
    (showCheckpointType && checkpointType !== 'all' ? 1 : 0);
  const handleClear = () => {
    setTypes([]);
    setBaseModels([]);
    setHideNSFW(false);
    setCheckpointType(undefined);
  };

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
          <ActionIcon color="dark" variant="transparent" sx={{ width: 40 }}>
            <IconFilter size={20} stroke={2.5} />
            <IconChevronDown size={16} stroke={3} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack spacing={0}>
          {showNSFWToggle && (
            <>
              <Divider label="Browsing Mode" labelProps={{ weight: 'bold' }} />
              <SegmentedControl
                my={5}
                value={!hideNSFW ? 'nsfw' : 'sfw'}
                size="xs"
                color="blue"
                styles={(theme) => ({
                  root: {
                    border: `1px solid ${
                      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                    }`,
                    background: 'none',
                  },
                })}
                data={[
                  { label: 'Safe', value: 'sfw' },
                  { label: 'Adult', value: 'nsfw' },
                ]}
                onChange={(value) => {
                  setHideNSFW(value === 'sfw');
                }}
              />
            </>
          )}
          <Divider label="Model types" labelProps={{ weight: 'bold' }} />
          <Checkbox.Group
            value={types}
            orientation="vertical"
            spacing="xs"
            size="md"
            onChange={(types: ModelType[]) => setTypes(types)}
          >
            {Object.values(ModelType).map((type, index) => (
              <Checkbox key={index} value={type} label={splitUppercase(type)} />
            ))}
          </Checkbox.Group>
          {showCheckpointType ? (
            <>
              <Divider label="Checkpoint type" labelProps={{ weight: 'bold' }} />
              <SegmentedControl
                my={5}
                value={checkpointType}
                size="xs"
                color="blue"
                styles={(theme) => ({
                  root: {
                    border: `1px solid ${
                      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                    }`,
                    background: 'none',
                  },
                })}
                data={[{ label: 'All', value: 'all' }].concat(
                  Object.values(CheckpointType).map((type) => ({
                    label: splitUppercase(type),
                    value: type,
                  }))
                )}
                onChange={(value: CheckpointType | 'all') => {
                  setCheckpointType(value !== 'all' ? value : undefined);
                }}
              />
            </>
          ) : null}
          <Divider label="Base model" labelProps={{ weight: 'bold' }} />
          <Checkbox.Group
            value={baseModels}
            orientation="vertical"
            spacing="xs"
            size="md"
            onChange={(baseModels: BaseModel[]) => setBaseModels(baseModels)}
          >
            {constants.baseModels.map((baseModel, index) => (
              <Checkbox key={index} value={baseModel} label={baseModel} />
            ))}
          </Checkbox.Group>
          {filterLength > 0 && (
            <Button mt="xs" compact onClick={handleClear} leftIcon={<IconFilterOff size={20} />}>
              Clear Filters
            </Button>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
