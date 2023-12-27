import {
  Button,
  Chip,
  ChipProps,
  createStyles,
  Divider,
  Group,
  Indicator,
  Popover,
  Stack,
  Drawer,
  PopoverProps,
} from '@mantine/core';
import { CheckpointType, ModelStatus, ModelType, MetricTimeframe } from '@prisma/client';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { IsClient } from '~/components/IsClient/IsClient';
import { ModelQueryParams, useModelQueryParams } from '~/components/Model/model.utils';
import { useCurrentUser, useIsSameUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ModelFilterSchema, useFiltersContext } from '~/providers/FiltersProvider';
import { BaseModel, constants } from '~/server/common/constants';
import { getDisplayName, splitUppercase } from '~/utils/string-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useIsMobile } from '~/hooks/useIsMobile';

const availableStatus = Object.values(ModelStatus).filter((status) =>
  ['Draft', 'Deleted', 'Unpublished'].includes(status)
);
// If any of these is found within the query params, we should clear the filters
// to be able to apply the relevant filters.
const queryFiltersOverwrite: (keyof ModelQueryParams & keyof ModelFilterSchema)[] = [
  'baseModels',
  // 'period',
];

const availableFileFormats = constants.modelFileFormats.filter((format) => format !== 'Other');

const ckptTypeOptions = [{ label: 'All', value: 'all' }].concat(
  Object.values(CheckpointType).map((type) => ({
    label: splitUppercase(type),
    value: type,
  }))
);

export function ModelFiltersDropdown(props: Props) {
  const { set: setQueryFilters, ...queryFilters } = useModelQueryParams();

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.models,
    setFilters: state.setModelFilters,
  }));

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
        followed: false,
        period: MetricTimeframe.AllTime,
      }),
    [setFilters]
  );

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

  return <DumbModelFiltersDropdown {...props} filters={filters} setFilters={setFilters} />;
}

export function DumbModelFiltersDropdown({
  filters,
  setFilters,
  filterMode = 'local',
  position = 'bottom-end',
}: Props & {
  filters: Partial<ModelFilterSchema>;
  setFilters: (filters: Partial<ModelFilterSchema>) => void;
}) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const isSameUser = useIsSameUser(router.query.username);
  const { classes, cx, theme } = useStyles();
  const flags = useFeatureFlags();
  const mobile = useIsMobile();
  const { set: setQueryFilters, period = MetricTimeframe.AllTime } = useModelQueryParams();

  const [opened, setOpened] = useState(false);

  const localMode = filterMode === 'local';
  const mergedFilters = localMode ? filters : { ...filters, period };
  const showCheckpointType =
    !mergedFilters.types?.length || mergedFilters.types.includes('Checkpoint');

  const filterLength =
    (mergedFilters.types?.length ?? 0) +
    (mergedFilters.baseModels?.length ?? 0) +
    (mergedFilters.status?.length ?? 0) +
    (showCheckpointType && mergedFilters.checkpointType ? 1 : 0) +
    (mergedFilters.earlyAccess ? 1 : 0) +
    (mergedFilters.supportsGeneration ? 1 : 0) +
    (mergedFilters.followed ? 1 : 0) +
    (mergedFilters.fileFormats?.length ?? 0) +
    (mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0);

  const clearFilters = useCallback(() => {
    const reset = {
      types: undefined,
      baseModels: undefined,
      status: undefined,
      checkpointType: undefined,
      earlyAccess: false,
      supportsGeneration: false,
      followed: false,
      fileFormats: undefined,
      period: MetricTimeframe.AllTime,
    };

    if (!localMode) setQueryFilters({ period: MetricTimeframe.AllTime });
    setFilters(reset);
  }, [localMode, setFilters, setQueryFilters]);

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
    tt: 'capitalize',
  };

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      showZero={false}
      dot={false}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
      >
        <Group spacing={4} noWrap>
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = (
    <Stack spacing={8}>
      <Stack spacing={0}>
        <Divider label="Time period" labelProps={{ weight: 'bold', size: 'sm' }} mb={4} />
        {!localMode ? (
          <PeriodFilter
            type="models"
            variant="chips"
            value={period}
            onChange={(period) => setQueryFilters({ period })}
          />
        ) : (
          <PeriodFilter type="models" variant="chips" />
        )}
      </Stack>
      <Stack spacing={0}>
        <Divider label="Model status" labelProps={{ weight: 'bold', size: 'sm' }} mb={4} />
        {currentUser?.isModerator && (
          <Chip.Group
            spacing={8}
            value={mergedFilters.status ?? []}
            mb={8}
            onChange={(status: ModelStatus[]) => setFilters({ status })}
            multiple
          >
            {availableStatus.map((status) => (
              <Chip key={status} value={status} {...chipProps}>
                {status}
              </Chip>
            ))}
          </Chip.Group>
        )}
        <Group spacing={8} mb={4}>
          <Chip
            checked={mergedFilters.earlyAccess}
            onChange={(checked) => setFilters({ earlyAccess: checked })}
            {...chipProps}
          >
            Early Access
          </Chip>
          {flags.imageGeneration && (
            <Chip
              checked={mergedFilters.supportsGeneration}
              onChange={(checked) => setFilters({ supportsGeneration: checked })}
              {...chipProps}
            >
              Onsite Generation
            </Chip>
          )}
        </Group>
      </Stack>
      <Stack spacing={0}>
        <Divider label="Model types" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={mergedFilters.types ?? []}
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
      </Stack>
      {showCheckpointType ? (
        <>
          <Stack spacing={0}>
            <Divider label="Checkpoint type" labelProps={{ weight: 'bold', size: 'sm' }} />
            <Chip.Group
              my={4}
              spacing={8}
              value={mergedFilters.checkpointType ?? 'all'}
              onChange={(value: CheckpointType | 'all') =>
                setFilters({ checkpointType: value !== 'all' ? value : undefined })
              }
            >
              {ckptTypeOptions.map((option, index) => (
                <Chip key={index} value={option.value} {...chipProps}>
                  {option.label}
                </Chip>
              ))}
            </Chip.Group>
          </Stack>
          <Stack spacing={0}>
            <Divider label="File format" labelProps={{ weight: 'bold', size: 'sm' }} />
            <Chip.Group
              spacing={8}
              value={mergedFilters.fileFormats ?? []}
              onChange={(fileFormats: typeof availableFileFormats) => setFilters({ fileFormats })}
              multiple
              my={4}
            >
              {availableFileFormats.map((format, index) => (
                <Chip key={index} value={format} {...chipProps}>
                  {format}
                </Chip>
              ))}
            </Chip.Group>
          </Stack>
        </>
      ) : null}
      <Stack spacing={0}>
        <Divider label="Base model" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={(mergedFilters.baseModels as string[]) ?? []}
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
      </Stack>

      {currentUser && !isSameUser && (
        <Stack spacing={0}>
          <Divider label="Modifiers" labelProps={{ weight: 'bold', size: 'sm' }} mb={4} />
          <Group>
            <Chip
              checked={mergedFilters.followed}
              onChange={(checked) => setFilters({ followed: checked })}
              {...chipProps}
            >
              Followed Only
            </Chip>
          </Group>
        </Stack>
      )}
      {filterLength > 0 && (
        <Button
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={clearFilters}
          fullWidth
        >
          Clear all filters
        </Button>
      )}
    </Stack>
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          withCloseButton={false}
          size="90%"
          position="bottom"
          styles={{
            body: { padding: 16, overflowY: 'auto' },
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--mantine-header-height))',
            },
          }}
        >
          {dropdown}
        </Drawer>
      </>
    );

  return (
    <IsClient>
      <Popover
        zIndex={200}
        position={position}
        shadow="md"
        onClose={() => setOpened(false)}
        middlewares={{ flip: true, shift: true }}
        withinPortal
        withArrow
      >
        <Popover.Target>{target}</Popover.Target>
        <Popover.Dropdown maw={576} w="100%">
          {dropdown}
        </Popover.Dropdown>
      </Popover>
    </IsClient>
  );
}

type Props = { filterMode?: 'local' | 'query'; position?: PopoverProps['position'] };

const useStyles = createStyles((theme, _params, getRef) => ({
  label: {
    fontSize: 12,
    fontWeight: 600,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        backgroundColor: 'transparent',
      },
    },
  },

  iconWrapper: {
    ref: getRef('iconWrapper'),
  },
  opened: {
    transform: 'rotate(180deg)',
    transition: 'transform 200ms ease',
  },

  actionButton: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',
    },
  },
}));
