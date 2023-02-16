import create from 'zustand';
import { ModelType, MetricTimeframe, CheckpointType, ModelStatus } from '@prisma/client';
import { ModelSort } from '~/server/common/enums';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { splitUppercase } from '~/utils/string-helpers';
import { deleteCookie } from 'cookies-next';
import { immer } from 'zustand/middleware/immer';
import { modelFilterSchema, useCookies } from '~/providers/CookiesProvider';
import {
  Popover,
  ActionIcon,
  Stack,
  Indicator,
  Divider,
  SegmentedControl,
  Button,
  Chip,
  createStyles,
  ChipProps,
} from '@mantine/core';
import { IconChevronDown, IconFilter, IconFilterOff } from '@tabler/icons';
import { z } from 'zod';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { BaseModel, constants } from '~/server/common/constants';
import { setCookie } from '~/utils/cookies-helpers';

type FilterProps = z.input<typeof modelFilterSchema>;

export const useFilters = create<{
  filters: FilterProps;
  setSort: (sort?: ModelSort) => void;
  setPeriod: (period?: MetricTimeframe) => void;
  setTypes: (types?: ModelType[]) => void;
  setCheckpointType: (checkpointType?: CheckpointType) => void;
  setBaseModels: (baseModels?: BaseModel[]) => void;
  setHideNSFW: (includeNSFW?: boolean) => void;
  setStatus: (status?: ModelStatus[]) => void;
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
    setStatus: (status) => {
      set((state) => {
        state.filters.status = status;
        !!status?.length ? setCookie('f_status', status) : deleteCookie('f_status');
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
    status,
    checkpointType,
  } = useCookies().models;

  const filters = useFilters((state) => state.filters);
  return {
    limit: 100,
    sort,
    period,
    types,
    baseModels,
    hideNSFW,
    status,
    checkpointType,
    ...filters,
  };
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

const availableStatus = Object.values(ModelStatus).filter((status) =>
  ['Draft', 'Deleted', 'Unpublished'].includes(status)
);

export function InfiniteModelsFilter() {
  const { classes } = useStyles();
  const cookies = useCookies().models;
  const user = useCurrentUser();
  const setTypes = useFilters((state) => state.setTypes);
  const types = useFilters((state) => state.filters.types ?? cookies.types ?? []);
  const setStatus = useFilters((state) => state.setStatus);
  const status = useFilters((state) => state.filters.status ?? cookies.status ?? []);
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
    status.length +
    (showNSFWToggle && hideNSFW ? 1 : 0) +
    (showCheckpointType && checkpointType !== 'all' ? 1 : 0);
  const handleClear = () => {
    setTypes([]);
    setBaseModels([]);
    setStatus([]);
    setHideNSFW(false);
    setCheckpointType(undefined);
  };

  const chipProps: Partial<ChipProps> = {
    radius: 'sm',
    size: 'sm',
    classNames: classes,
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
      <Popover.Dropdown maw={350} w="100%">
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
          {user?.isModerator && (
            <>
              <Divider label="Model status" labelProps={{ weight: 'bold' }} />
              <Chip.Group
                spacing={4}
                value={status}
                onChange={(status: ModelStatus[]) => setStatus(status)}
                multiple
                my={4}
              >
                {availableStatus.map((status) => (
                  <Chip key={status} value={status} {...chipProps}>
                    {status}
                  </Chip>
                ))}
              </Chip.Group>
            </>
          )}
          <Divider label="Model types" labelProps={{ weight: 'bold' }} />
          <Chip.Group
            spacing={4}
            value={types}
            onChange={(types: ModelType[]) => setTypes(types)}
            multiple
            my={4}
          >
            {Object.values(ModelType).map((type, index) => (
              <Chip key={index} value={type} {...chipProps}>
                {splitUppercase(type)}
              </Chip>
            ))}
          </Chip.Group>
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
          <Chip.Group
            spacing={4}
            value={baseModels}
            onChange={(baseModels: BaseModel[]) => setBaseModels(baseModels)}
            multiple
            my={4}
          >
            {constants.baseModels.map((baseModel, index) => (
              <Chip key={index} value={baseModel} {...chipProps}>
                {baseModel}
              </Chip>
            ))}
          </Chip.Group>
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

const useStyles = createStyles((theme, _params, getRef) => ({
  label: {
    fontSize: 12,
    fontWeight: 500,
    '&[data-checked]': {
      '&, &:hover': {
        backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
        color: theme.white,
      },

      [`& .${getRef('iconWrapper')}`]: {
        color: theme.white,
      },
    },
  },

  iconWrapper: {
    ref: getRef('iconWrapper'),
  },
}));
