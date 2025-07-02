import type { ButtonProps, PopoverProps } from '@mantine/core';
import {
  Button,
  Chip,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  ScrollArea,
  Stack,
  useComputedColorScheme,
} from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import type { CSSProperties } from 'react';
import { useCallback, useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { PeriodFilter } from '~/components/Filters';
import { FilterChip } from '~/components/Filters/FilterChip';
import { IsClient } from '~/components/IsClient/IsClient';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ModelFilterSchema } from '~/providers/FiltersProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { BaseModel } from '~/server/common/constants';
import { activeBaseModels, constants } from '~/server/common/constants';
import {
  Availability,
  CheckpointType,
  MetricTimeframe,
  ModelStatus,
  ModelType,
} from '~/shared/utils/prisma/enums';
import { getDisplayName, splitUppercase } from '~/utils/string-helpers';

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
  const isModerator = currentUser?.isModerator;
  const colorScheme = useComputedColorScheme('dark');
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
    (mergedFilters.isFeatured ? 1 : 0) +
    (mergedFilters.hidden ? 1 : 0) +
    (mergedFilters.fileFormats?.length ?? 0) +
    (!!mergedFilters.availability ? 1 : 0) +
    (mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0) +
    (mergedFilters.poiOnly ? 1 : 0) +
    (mergedFilters.minorOnly ? 1 : 0) +
    (isModerator && mergedFilters.disablePoi ? 1 : 0) +
    (isModerator && mergedFilters.disableMinor ? 1 : 0);

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
      isFeatured: false,
      period: MetricTimeframe.AllTime,
      availability: undefined,
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
        isFeatured: undefined,
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
      disabled={!filterLength}
      inline
    >
      <FilterButton icon={IconFilter} onClick={() => setOpened((o) => !o)} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdown = (
    <Stack gap={8} p="md">
      <Stack gap={0}>
        <Divider label="Time period" className="text-sm font-bold" mb={4} />
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
      <Stack gap={0}>
        {currentUser?.isModerator && (
          <>
            <Divider label="Model Availability" className="text-sm font-bold" mb={4} />

            <Chip.Group
              value={mergedFilters.availability}
              onChange={(availability) =>
                handleChange({
                  availability: availability as Availability,
                })
              }
            >
              <Group gap={8} mb={4}>
                {Object.values(Availability).map((availability) => (
                  <FilterChip key={availability} value={availability}>
                    <span>{availability}</span>
                  </FilterChip>
                ))}
              </Group>
            </Chip.Group>
          </>
        )}
        <Divider label="Model status" className="text-sm font-bold" mb={4} />
        {currentUser?.isModerator && (
          <Chip.Group
            value={mergedFilters.status ?? []}
            onChange={(status) => handleChange({ status: status as ModelStatus[] })}
            multiple
          >
            <Group gap={8} mb={4}>
              {availableStatus.map((status) => (
                <FilterChip key={status} value={status}>
                  <span>{status}</span>
                </FilterChip>
              ))}
            </Group>
          </Chip.Group>
        )}

        <Group gap={8} mb={4}>
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
          <FilterChip
            checked={mergedFilters.isFeatured}
            onChange={(checked) => handleChange({ isFeatured: checked })}
          >
            <span>Featured</span>
          </FilterChip>
        </Group>
      </Stack>
      <Stack gap={0}>
        <Divider label="Model types" className="text-sm font-bold" mb={4} />
        <Chip.Group
          value={mergedFilters.types ?? []}
          onChange={(types) => handleChange({ types: types as ModelType[] })}
          multiple
        >
          <Group gap={8} mb={4}>
            {Object.values(ModelType).map((type, index) => (
              <FilterChip key={index} value={type}>
                <span>{getDisplayName(type)}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>
      {showCheckpointType ? (
        <>
          <Stack gap={0}>
            <Divider label="Checkpoint type" className="text-sm font-bold" mb={4} />
            <Chip.Group
              value={mergedFilters.checkpointType ?? 'all'}
              onChange={(value) =>
                handleChange({
                  checkpointType: value !== 'all' ? (value as CheckpointType) : undefined,
                })
              }
            >
              <Group gap={8} mb={4}>
                {ckptTypeOptions.map((option, index) => (
                  <FilterChip key={index} value={option.value}>
                    <span>{option.label}</span>
                  </FilterChip>
                ))}
              </Group>
            </Chip.Group>
          </Stack>
          <Stack gap={0}>
            <Divider label="File format" className="text-sm font-bold" mb={4} />
            <Chip.Group
              value={mergedFilters.fileFormats ?? []}
              onChange={(fileFormats) =>
                handleChange({ fileFormats: fileFormats as typeof availableFileFormats })
              }
              multiple
            >
              <Group gap={8} mb={4}>
                {availableFileFormats.map((format, index) => (
                  <FilterChip key={index} value={format}>
                    <span>{format}</span>
                  </FilterChip>
                ))}
              </Group>
            </Chip.Group>
          </Stack>
        </>
      ) : null}
      <Stack gap={0}>
        <Divider label="Base model" className="text-sm font-bold" mb={4} />
        <Chip.Group
          value={(mergedFilters.baseModels as string[]) ?? []}
          onChange={(baseModels) => handleChange({ baseModels: baseModels as BaseModel[] })}
          multiple
        >
          <Group gap={8} mb={4}>
            {activeBaseModels.map((baseModel, index) => (
              <FilterChip key={index} value={baseModel}>
                <span>{getDisplayName(baseModel, { splitNumbers: false })}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>

      <Stack gap={0}>
        <Divider label="Modifiers" className="text-sm font-bold" mb={4} />
        <Group gap={8}>
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

          {currentUser && currentUser?.isModerator && (
            <>
              <FilterChip
                checked={mergedFilters.poiOnly}
                onChange={(checked) => handleChange({ poiOnly: checked })}
              >
                <span>POI</span>
              </FilterChip>
              <FilterChip
                checked={mergedFilters.minorOnly}
                onChange={(checked) => handleChange({ minorOnly: checked })}
              >
                <span>Minor</span>
              </FilterChip>
              <FilterChip
                checked={mergedFilters.poiOnly}
                onChange={(checked) => handleChange({ disablePoi: checked })}
              >
                <span>Disable POI</span>
              </FilterChip>
              <FilterChip
                checked={mergedFilters.minorOnly}
                onChange={(checked) => handleChange({ disableMinor: checked })}
              >
                <span>Disable Minor</span>
              </FilterChip>
            </>
          )}
        </Group>
      </Stack>
      {filterLength > 0 && (
        <Button
          color="gray"
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
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
            content: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
            },
            body: { padding: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
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
            mah={maxPopoverHeight ?? 'calc(90vh - var(--header-height) - 56px)'}
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
