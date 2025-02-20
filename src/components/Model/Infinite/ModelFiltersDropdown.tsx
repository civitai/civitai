import {
  Button,
  ButtonProps,
  Chip,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  PopoverProps,
  ScrollArea,
  Stack,
  useMantineTheme,
} from '@mantine/core';
import {
  CheckpointType,
  MetricTimeframe,
  ModelStatus,
  ModelType,
} from '~/shared/utils/prisma/enums';
import { IconFilter } from '@tabler/icons-react';
import { CSSProperties, useCallback, useState } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { IsClient } from '~/components/IsClient/IsClient';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ModelFilterSchema, useFiltersContext } from '~/providers/FiltersProvider';
import { activeBaseModels, BaseModel, constants } from '~/server/common/constants';
import { getDisplayName, splitUppercase } from '~/utils/string-helpers';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';

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
  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.models,
    setFilters: state.setModelFilters,
  }));

  return <DumbModelFiltersDropdown {...props} filters={filters} setFilters={setFilters} />;
}

export function DumbModelFiltersDropdown({
  filters,
  setFilters,
  filterMode = 'local',
  position = 'bottom-end',
  isFeed,
  maxPopoverHeight,
  ...buttonProps
}: Props & {
  filters: Partial<ModelFilterSchema>;
  setFilters: (filters: Partial<ModelFilterSchema>) => void;
}) {
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const flags = useFeatureFlags();
  const mobile = useIsMobile();
  const {
    set: setQueryFilters,
    period = MetricTimeframe.AllTime,
    hidden = undefined,
    ...query
  } = useModelQueryParams();

  const [opened, setOpened] = useState(false);

  const localMode = filterMode === 'local';
  const mergedFilters = localMode ? filters : { ...query, period, hidden };
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
    (mergedFilters.hidden ? 1 : 0) +
    (mergedFilters.fileFormats?.length ?? 0) +
    (mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0);

  const clearFilters = useCallback(() => {
    const reset = {
      types: undefined,
      baseModels: undefined,
      status: undefined,
      checkpointType: undefined,
      earlyAccess: undefined,
      supportsGeneration: false,
      followed: false,
      hidden: undefined,
      fileFormats: undefined,
      fromPlatform: false,
      period: MetricTimeframe.AllTime,
    };

    if (!localMode)
      setQueryFilters({
        types: undefined,
        baseModels: undefined,
        status: undefined,
        checkpointType: undefined,
        earlyAccess: undefined,
        supportsGeneration: undefined,
        followed: undefined,
        hidden: undefined,
        fileFormats: undefined,
        fromPlatform: undefined,
        period: MetricTimeframe.AllTime,
      });
    setFilters(reset);
  }, [localMode, setFilters, setQueryFilters]);

  const handleChange = (value: Partial<ModelFilterSchema>) => {
    if (localMode) setFilters(value);
    else setQueryFilters(value);
  };

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={14}
      zIndex={10}
      showZero={false}
      dot={false}
      inline
    >
      <FilterButton icon={IconFilter} onClick={() => setOpened((o) => !o)} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdown = (
    <Stack spacing={8} p="md">
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
            onChange={(period) => handleChange({ period })}
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
            onChange={(status: ModelStatus[]) => handleChange({ status })}
            multiple
          >
            {availableStatus.map((status) => (
              <FilterChip key={status} value={status}>
                <span>{status}</span>
              </FilterChip>
            ))}
          </Chip.Group>
        )}
        <Group spacing={8} mb={4}>
          <FilterChip
            checked={mergedFilters.earlyAccess}
            onChange={(checked) => handleChange({ earlyAccess: checked })}
          >
            <span>Early Access</span>
          </FilterChip>
          {flags.imageGeneration && (
            <FilterChip
              checked={mergedFilters.supportsGeneration}
              onChange={(checked) => handleChange({ supportsGeneration: checked })}
            >
              <span>On-site Generation</span>
            </FilterChip>
          )}
          <FilterChip
            checked={mergedFilters.fromPlatform}
            onChange={(checked) => handleChange({ fromPlatform: checked })}
          >
            <span>Made On-site</span>
          </FilterChip>
        </Group>
      </Stack>
      <Stack spacing={0}>
        <Divider label="Model types" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={mergedFilters.types ?? []}
          onChange={(types: ModelType[]) => handleChange({ types })}
          multiple
          my={4}
        >
          {Object.values(ModelType).map((type, index) => (
            <FilterChip key={index} value={type}>
              <span>{getDisplayName(type)}</span>
            </FilterChip>
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
                handleChange({ checkpointType: value !== 'all' ? value : undefined })
              }
            >
              {ckptTypeOptions.map((option, index) => (
                <FilterChip key={index} value={option.value}>
                  <span>{option.label}</span>
                </FilterChip>
              ))}
            </Chip.Group>
          </Stack>
          <Stack spacing={0}>
            <Divider label="File format" labelProps={{ weight: 'bold', size: 'sm' }} />
            <Chip.Group
              spacing={8}
              value={mergedFilters.fileFormats ?? []}
              onChange={(fileFormats: typeof availableFileFormats) => handleChange({ fileFormats })}
              multiple
              my={4}
            >
              {availableFileFormats.map((format, index) => (
                <FilterChip key={index} value={format}>
                  <span>{format}</span>
                </FilterChip>
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
          onChange={(baseModels: BaseModel[]) => handleChange({ baseModels })}
          multiple
          my={4}
        >
          {activeBaseModels.map((baseModel, index) => (
            <FilterChip key={index} value={baseModel}>
              <span>{getDisplayName(baseModel, { splitNumbers: false })}</span>
            </FilterChip>
          ))}
        </Chip.Group>
      </Stack>

      <Stack spacing={0}>
        <Divider label="Modifiers" labelProps={{ weight: 'bold', size: 'sm' }} mb={4} />
        <Group spacing={8}>
          {currentUser && isFeed && (
            <>
              <FilterChip
                checked={mergedFilters.hidden}
                onChange={(checked) => handleChange({ hidden: checked })}
              >
                <span>Hidden</span>
              </FilterChip>
            </>
          )}
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
      <IsClient>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          size="90%"
          position="bottom"
          styles={{
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
            },
            body: { padding: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            closeButton: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          {dropdown}
        </Drawer>
      </IsClient>
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
        <Popover.Dropdown maw={576} p={0} w="100%">
          <ScrollArea.Autosize
            maxHeight={maxPopoverHeight ?? 'calc(90vh - var(--header-height) - 56px)'}
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
  maxPopoverHeight?: CSSProperties['maxHeight'];
};
