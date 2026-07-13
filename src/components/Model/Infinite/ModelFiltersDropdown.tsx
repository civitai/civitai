import type { ButtonProps, PopoverProps } from '@mantine/core';
import {
  Chip,
  Divider,
  Drawer,
  Group,
  Indicator,
  MultiSelect,
  Popover,
  ScrollArea,
  Stack,
} from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import type { CSSProperties } from 'react';
import { useCallback, useMemo } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { PeriodFilter } from '~/components/Filters';
import { FilterChip } from '~/components/Filters/FilterChip';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { IsClient } from '~/components/IsClient/IsClient';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isMobileDevice, useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ModelFilterSchema } from '~/providers/FiltersProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { baseModelSelectData } from '~/shared/constants/basemodel.constants';
import { constants } from '~/server/common/constants';
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
  hideEarlyAccess = false,
  ...buttonProps
}: Props & {
  filters: Partial<ModelFilterSchema>;
  setFilters: (filters: Partial<ModelFilterSchema>) => void;
}) {
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator;
  const flags = useFeatureFlags();
  const mobile = useIsMobile();
  const {
    set: setQueryFilters,
    period = MetricTimeframe.AllTime,
    hidden = undefined,
    ...query
  } = useModelQueryParams();

  const localMode = filterMode === 'local';
  const committedFilters = useMemo<Partial<ModelFilterSchema>>(
    () => (localMode ? filters : { ...query, period, hidden }),
    [localMode, filters, query, period, hidden]
  );

  const handleApply = useCallback(
    (next: Partial<ModelFilterSchema>) => {
      if (localMode) setFilters(next);
      else setQueryFilters(next);
    },
    [localMode, setFilters, setQueryFilters]
  );

  const handleClear = useCallback(() => {
    const reset = {
      types: undefined,
      baseModels: undefined,
      status: undefined,
      checkpointType: undefined,
      earlyAccess: undefined,
      supportsGeneration: false,
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
        hidden: undefined,
        fileFormats: undefined,
        fromPlatform: undefined,
        isFeatured: undefined,
        period: MetricTimeframe.AllTime,
      });
    setFilters(reset);
  }, [localMode, setFilters, setQueryFilters]);

  const {
    opened,
    toggle,
    close,
    mergedFilters,
    isDirty,
    patchPending,
    apply,
    reset,
    clearAndClose,
  } = useStagedFilters({
    committed: committedFilters,
    onApply: handleApply,
    onClear: handleClear,
  });

  const showCheckpointType =
    !mergedFilters.types?.length || mergedFilters.types.includes('Checkpoint');

  const filterLength =
    (mergedFilters.types?.length ?? 0) +
    (mergedFilters.baseModels?.length ?? 0) +
    (mergedFilters.status?.length ?? 0) +
    (showCheckpointType && mergedFilters.checkpointType ? 1 : 0) +
    (!hideEarlyAccess && mergedFilters.earlyAccess ? 1 : 0) +
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

  const filterButton = (
    <FilterButton icon={IconFilter} onClick={toggle} active={opened}>
      Filters
    </FilterButton>
  );

  // Active-filter count badge. Keep the Indicator as a purely visual wrapper:
  // in the desktop path Popover.Target must clone the inner <button> (which
  // forwards the aria-haspopup/expanded/controls it injects), NOT the
  // Indicator's role-less <div> — putting aria-expanded on a <div> trips the
  // aria-allowed-attr a11y rule.
  const indicatorProps = {
    offset: 4,
    label: filterLength ? filterLength : undefined,
    size: 14,
    zIndex: 10,
    disabled: !filterLength,
    inline: true,
  };

  const target = <Indicator {...indicatorProps}>{filterButton}</Indicator>;

  const dropdownBody = (
    <Stack gap={8} p="md">
      <Stack gap={0}>
        <Divider label="Time period" className="text-sm font-bold" mb={4} />
        <PeriodFilter
          type="models"
          variant="chips"
          value={mergedFilters.period ?? MetricTimeframe.AllTime}
          onChange={(period) => patchPending({ period })}
        />
      </Stack>
      <Stack gap={0}>
        {currentUser?.isModerator && (
          <>
            <Divider label="Model Availability" className="text-sm font-bold" mb={4} />

            <Chip.Group
              value={mergedFilters.availability}
              onChange={(availability) =>
                patchPending({
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
            onChange={(status) => patchPending({ status: status as ModelStatus[] })}
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
          {!hideEarlyAccess && (
            <FilterChip
              checked={mergedFilters.earlyAccess}
              onChange={(checked) => patchPending({ earlyAccess: checked })}
            >
              <span>Early Access</span>
            </FilterChip>
          )}
          {flags.imageGeneration && (
            <FilterChip
              checked={mergedFilters.supportsGeneration}
              onChange={(checked) => patchPending({ supportsGeneration: checked })}
            >
              <span>On-site Generation</span>
            </FilterChip>
          )}
          <FilterChip
            checked={mergedFilters.fromPlatform}
            onChange={(checked) => patchPending({ fromPlatform: checked })}
          >
            <span>Made On-site</span>
          </FilterChip>
          <FilterChip
            checked={mergedFilters.isFeatured}
            onChange={(checked) => patchPending({ isFeatured: checked })}
          >
            <span>Featured</span>
          </FilterChip>
        </Group>
      </Stack>
      <Stack gap={0}>
        <Divider label="Model types" className="text-sm font-bold" mb={4} />
        <Chip.Group
          value={mergedFilters.types ?? []}
          onChange={(types) => patchPending({ types: types as ModelType[] })}
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
                patchPending({
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
                patchPending({ fileFormats: fileFormats as typeof availableFileFormats })
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
        <MultiSelect
          data={baseModelSelectData}
          value={(mergedFilters.baseModels as string[]) ?? []}
          onChange={(baseModels) => patchPending({ baseModels: baseModels as BaseModel[] })}
          placeholder="All Base Models"
          searchable={!isMobileDevice()}
          clearable
          comboboxProps={{ withinPortal: false }}
        />
      </Stack>

      <Stack gap={0}>
        <Divider label="Modifiers" className="text-sm font-bold" mb={4} />
        <Group gap={8}>
          {currentUser && isFeed && (
            <>
              <FilterChip
                checked={mergedFilters.hidden}
                onChange={(checked) => patchPending({ hidden: checked })}
              >
                <span>Hidden</span>
              </FilterChip>
            </>
          )}

          {currentUser && currentUser?.isModerator && (
            <>
              <FilterChip
                checked={mergedFilters.poiOnly}
                onChange={(checked) => patchPending({ poiOnly: checked })}
              >
                <span>POI</span>
              </FilterChip>
              <FilterChip
                checked={mergedFilters.minorOnly}
                onChange={(checked) => patchPending({ minorOnly: checked })}
              >
                <span>Minor</span>
              </FilterChip>
              <FilterChip
                checked={mergedFilters.poiOnly}
                onChange={(checked) => patchPending({ disablePoi: checked })}
              >
                <span>Disable POI</span>
              </FilterChip>
              <FilterChip
                checked={mergedFilters.minorOnly}
                onChange={(checked) => patchPending({ disableMinor: checked })}
              >
                <span>Disable Minor</span>
              </FilterChip>
            </>
          )}
        </Group>
      </Stack>
    </Stack>
  );

  const dropdownFooter = (
    <StagedFiltersFooter
      isDirty={isDirty}
      onApply={apply}
      onReset={reset}
      filterLength={filterLength}
      onClear={clearAndClose}
    />
  );

  if (mobile)
    return (
      <IsClient>
        {target}
        <Drawer
          opened={opened}
          onClose={close}
          size="90%"
          position="bottom"
          styles={{
            content: {
              maxHeight: 'calc(100dvh - var(--header-height))',
              display: 'flex',
              flexDirection: 'column',
            },
            body: {
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              flex: 1,
              minHeight: 0,
            },
            header: { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">{dropdownBody}</div>
          {dropdownFooter}
        </Drawer>
      </IsClient>
    );

  return (
    <IsClient>
      <Popover
        zIndex={200}
        position={position}
        shadow="md"
        opened={opened}
        onClose={close}
        middlewares={{ flip: true, shift: true }}
        withinPortal
        withArrow
      >
        <Indicator {...indicatorProps}>
          <Popover.Target>{filterButton}</Popover.Target>
        </Indicator>
        <Popover.Dropdown maw={576} p={0} w="100%">
          <ScrollArea.Autosize
            mah={maxPopoverHeight ?? 'calc(90vh - var(--header-height) - 156px)'}
            type="hover"
          >
            {dropdownBody}
          </ScrollArea.Autosize>
          {dropdownFooter}
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
  // Hide the Early Access toggle when the caller locks it on (e.g. Creator Shop).
  hideEarlyAccess?: boolean;
};
