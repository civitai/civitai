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
  ScrollArea,
  ButtonProps,
} from '@mantine/core';
import { CheckpointType, ModelStatus, ModelType, MetricTimeframe } from '@prisma/client';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { IsClient } from '~/components/IsClient/IsClient';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ModelFilterSchema, useFiltersContext } from '~/providers/FiltersProvider';
import { BaseModel, constants, activeBaseModels } from '~/server/common/constants';
import { getDisplayName, splitUppercase } from '~/utils/string-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useIsMobile } from '~/hooks/useIsMobile';

const availableStatus = Object.values(ModelStatus).filter((status) =>
  ['Draft', 'Deleted', 'Unpublished'].includes(status)
);

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

  const jointFilters = { ...filters, ...queryFilters };
  function setFiltersAndQuery(filters: Partial<ModelFilterSchema>) {
    const newQueryFilters: Record<string, any> = { ...queryFilters };
    for (const key in filters) {
      if (newQueryFilters[key]) newQueryFilters[key] = undefined;
    }
    setQueryFilters(newQueryFilters);
    setFilters(filters);
  }

  return (
    <DumbModelFiltersDropdown {...props} filters={jointFilters} setFilters={setFiltersAndQuery} />
  );
}

export function DumbModelFiltersDropdown({
  filters,
  setFilters,
  filterMode = 'local',
  position = 'bottom-end',
  isFeed,
  ...buttonProps
}: Props & {
  filters: Partial<ModelFilterSchema>;
  setFilters: (filters: Partial<ModelFilterSchema>) => void;
}) {
  const currentUser = useCurrentUser();
  const { classes, cx, theme } = useStyles();
  const flags = useFeatureFlags();
  const mobile = useIsMobile();
  const {
    set: setQueryFilters,
    period = MetricTimeframe.AllTime,
    hidden = undefined,
  } = useModelQueryParams();

  const [opened, setOpened] = useState(false);

  const localMode = filterMode === 'local';
  const mergedFilters = localMode ? filters : { ...filters, period, hidden };
  const showCheckpointType =
    !mergedFilters.types?.length || mergedFilters.types.includes('Checkpoint');

  const filterLength =
    (mergedFilters.types?.length ?? 0) +
    (mergedFilters.baseModels?.length ?? 0) +
    (mergedFilters.status?.length ?? 0) +
    (showCheckpointType && mergedFilters.checkpointType ? 1 : 0) +
    (mergedFilters.earlyAccess ? 1 : 0) +
    (mergedFilters.supportsGeneration ? 1 : 0) +
    (mergedFilters.fromPlatform ? 1 : 0) +
    (mergedFilters.archived ? 1 : 0) +
    (mergedFilters.hidden ? 1 : 0) +
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
      hidden: undefined,
      archived: undefined,
      fileFormats: undefined,
      fromPlatform: false,
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
      size={14}
      zIndex={10}
      showZero={false}
      dot={false}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        {...buttonProps}
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
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
          <PeriodFilter
            type="models"
            variant="chips"
            value={filters.period ?? MetricTimeframe.AllTime}
            onChange={(period) => setFilters({ period })}
          />
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
              On-site Generation
            </Chip>
          )}
          <Chip
            checked={mergedFilters.fromPlatform}
            onChange={(checked) => setFilters({ fromPlatform: checked })}
            {...chipProps}
          >
            Made On-site
          </Chip>
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
          {activeBaseModels.map((baseModel, index) => (
            <Chip key={index} value={baseModel} {...chipProps}>
              {baseModel}
            </Chip>
          ))}
        </Chip.Group>
      </Stack>

      <Stack spacing={0}>
        <Divider label="Modifiers" labelProps={{ weight: 'bold', size: 'sm' }} mb={4} />
        <Group spacing={8}>
          {currentUser && isFeed && (
            <>
              <Chip
                checked={mergedFilters.hidden}
                onChange={(checked) => setFilters({ hidden: checked })}
                {...chipProps}
              >
                Hidden
              </Chip>
            </>
          )}
          <Chip
            checked={mergedFilters.archived}
            onChange={(checked) => setFilters({ archived: checked })}
            {...chipProps}
          >
            Include Archived
          </Chip>
        </Group>
      </Stack>
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
          size="90%"
          position="bottom"
          styles={{
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--mantine-header-height))',
            },
            body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            closeButton: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
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
          <ScrollArea.Autosize
            maxHeight={'calc(90vh - var(--mantine-header-height) - 56px)'}
            type="hover"
          >
            {dropdown}
          </ScrollArea.Autosize>
        </Popover.Dropdown>
      </Popover>
    </IsClient>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  filterMode?: 'local' | 'query';
  position?: PopoverProps['position'];
  isFeed?: boolean;
};

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

  indicatorRoot: { lineHeight: 1 },
  indicatorIndicator: { lineHeight: 1.6 },
}));
