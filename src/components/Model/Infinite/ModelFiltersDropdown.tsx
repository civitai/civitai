import {
  ActionIcon,
  Button,
  Chip,
  ChipProps,
  createStyles,
  Divider,
  Group,
  Indicator,
  Popover,
  SegmentedControl,
  Stack,
} from '@mantine/core';
import { CheckpointType, ModelStatus, ModelType } from '@prisma/client';
import { IconChevronDown, IconFilter, IconFilterOff } from '@tabler/icons-react';
import { IsClient } from '~/components/IsClient/IsClient';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ModelFilterSchema, useFiltersContext } from '~/providers/FiltersProvider';
import { BaseModel, constants } from '~/server/common/constants';
import { getDisplayName, splitUppercase } from '~/utils/string-helpers';
import { ModelQueryParams, useModelQueryParams } from '~/components/Model/model.utils';
import { useCallback, useEffect, useMemo } from 'react';

const availableStatus = Object.values(ModelStatus).filter((status) =>
  ['Draft', 'Deleted', 'Unpublished'].includes(status)
);
// If any of these is found within the query params, we should clear the filters
// to be able to apply the relevant filters.
const queryFiltersOverwrite: (keyof ModelQueryParams & keyof ModelFilterSchema)[] = [
  'baseModels',
  'period',
];

export function ModelFiltersDropdown() {
  const user = useCurrentUser();
  const { classes } = useStyles();
  const flags = useFeatureFlags();
  const { set: setQueryFilters, ...queryFilters } = useModelQueryParams();

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.models,
    setFilters: state.setModelFilters,
  }));
  const showCheckpointType = !filters.types?.length || filters.types.includes('Checkpoint');

  const filterLength =
    (filters.types?.length ?? 0) +
    (filters.baseModels?.length ?? 0) +
    (filters.status?.length ?? 0) +
    (showCheckpointType && filters.checkpointType ? 1 : 0) +
    (filters.earlyAccess ? 1 : 0) +
    (filters.supportsGeneration ? 1 : 0);

  const shouldClearFilters = useMemo(
    () =>
      queryFiltersOverwrite.some(
        (key) => !!queryFilters[key] && filters[key] !== queryFilters[key]
      ),
    [queryFilters, filters]
  );

  const clearFilters = useCallback(
    () =>
      setFilters({
        types: undefined,
        baseModels: undefined,
        status: undefined,
        checkpointType: undefined,
        earlyAccess: false,
        supportsGeneration: false,
      }),
    [setFilters]
  );

  const chipProps: Partial<ChipProps> = {
    radius: 'sm',
    size: 'sm',
    classNames: classes,
  };

  useEffect(() => {
    // TODO.filters: If we keep filters in the query string instead of local storage
    // We might be able to bypass all this logic.
    if (shouldClearFilters) {
      const keys = queryFiltersOverwrite.filter((key) => queryFilters[key]);
      const updatedFilters = keys.reduce((acc, key) => {
        acc[key] = queryFilters[key];
        return acc;
      }, {} as any);
      const updatedQueryFilters = keys.reduce((acc, key) => {
        acc[key] = undefined;
        return acc;
      }, {} as any);

      setQueryFilters(updatedQueryFilters);
      clearFilters();
      setFilters(updatedFilters);
    }
  }, [shouldClearFilters, clearFilters, queryFilters, setFilters, setQueryFilters]);

  return (
    <IsClient>
      <Popover withArrow zIndex={200} withinPortal>
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
            <Divider label="Model status" labelProps={{ weight: 'bold' }} mb={4} />
            {user?.isModerator && (
              <Chip.Group
                spacing={4}
                value={filters.status ?? []}
                // TODO: fix type issues
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onChange={(status: ModelStatus[]) => setFilters({ status: status as any })}
                multiple
              >
                {availableStatus.map((status) => (
                  <Chip key={status} value={status} {...chipProps}>
                    {status}
                  </Chip>
                ))}
              </Chip.Group>
            )}
            <Group spacing={4} mb={4}>
              <Chip
                checked={filters.earlyAccess}
                onChange={(checked) => setFilters({ earlyAccess: checked })}
                mt={user?.isModerator ? 4 : undefined}
                {...chipProps}
              >
                Early Access
              </Chip>
              {flags.imageGeneration && (
                <Chip
                  checked={filters.supportsGeneration}
                  onChange={(checked) => setFilters({ supportsGeneration: checked })}
                  mt={user?.isModerator ? 4 : undefined}
                  {...chipProps}
                >
                  Onsite Generation
                </Chip>
              )}
            </Group>
            <Divider label="Model types" labelProps={{ weight: 'bold' }} />
            <Chip.Group
              spacing={4}
              value={filters.types ?? []}
              onChange={(types: ModelType[]) => setFilters({ types })}
              multiple
              my={4}
            >
              {Object.values(ModelType).map((type, index) => (
                <Chip key={index} value={type} {...chipProps}>
                  {getDisplayName(type)}
                </Chip>
              ))}
            </Chip.Group>
            {showCheckpointType ? (
              <>
                <Divider label="Checkpoint type" labelProps={{ weight: 'bold' }} />
                <SegmentedControl
                  my={5}
                  value={filters.checkpointType ?? 'all'}
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
                    setFilters({ checkpointType: value !== 'all' ? value : undefined });
                  }}
                />
              </>
            ) : null}
            <Divider label="Base model" labelProps={{ weight: 'bold' }} />
            <Chip.Group
              spacing={4}
              value={filters.baseModels ?? []}
              onChange={(baseModels: BaseModel[]) => setFilters({ baseModels })}
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
              <Button mt="xs" compact onClick={clearFilters} leftIcon={<IconFilterOff size={20} />}>
                Clear Filters
              </Button>
            )}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </IsClient>
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
