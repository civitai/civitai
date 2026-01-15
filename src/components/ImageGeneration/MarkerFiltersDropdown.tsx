import type { ButtonProps, PopoverProps } from '@mantine/core';
import { Button, Divider, Group, Indicator, Popover, ScrollArea, Stack } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconFilter, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { IsClient } from '~/components/IsClient/IsClient';
import type { GenerationFilterSchema } from '~/providers/FiltersProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { GenerationReactType } from '~/server/common/enums';
import {
  getGenerationBaseModelConfigs,
  baseModelGroupConfig,
  type BaseModelGroup,
} from '~/shared/constants/base-model.constants';
import { WORKFLOW_TAGS, PROCESS_TYPE_OPTIONS } from '~/shared/constants/generation.constants';
import { titleCase } from '~/utils/string-helpers';

// Get all base models dynamically from config
const baseModelGroups = getGenerationBaseModelConfigs();

export function MarkerFiltersDropdown(props: Props) {
  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.generation,
    setFilters: state.setGenerationFilters,
  }));

  return <DumbMarkerFiltersDropdown {...props} filters={filters} setFilters={setFilters} />;
}

export function DumbMarkerFiltersDropdown({
  filters,
  setFilters,
  filterMode = 'local',
  position = 'bottom-start',
  isFeed,
  text,
  hideMediaTypes = false,
  ...buttonProps
}: Props & {
  filters: Partial<GenerationFilterSchema>;
  setFilters: (filters: Partial<GenerationFilterSchema>) => void;
}) {
  const [opened, setOpened] = useState(false);

  const [currentMarker, setMarker] = useState<GenerationReactType | undefined>(filters.marker);

  if (filters.marker !== currentMarker) {
    setMarker(filters.marker);
  }

  // Calculate filter count for badge
  let filterLength = 0;
  if (filters.marker) filterLength += 1;
  if (filters.tags?.length) filterLength += filters.tags.length;
  if (filters.baseModel) filterLength += 1;
  if (filters.processType) filterLength += 1;
  if (filters.fromDate) filterLength += 1;
  if (filters.toDate) filterLength += 1;
  if (filters.excludeFailed) filterLength += 1;

  // Clear all filters function
  const clearAllFilters = () => {
    setMarker(undefined);
    setFilters({
      marker: undefined,
      tags: [],
      baseModel: undefined,
      processType: undefined,
      fromDate: undefined,
      toDate: undefined,
      excludeFailed: undefined,
    });
  };

  return (
    <IsClient>
      <Popover
        zIndex={300}
        position={position}
        shadow="md"
        onClose={() => setOpened(false)}
        withinPortal
      >
        <Indicator
          offset={4}
          label={filterLength ? filterLength : undefined}
          size={14}
          zIndex={10}
          disabled={!filterLength}
          inline
        >
          <Popover.Target>
            <FilterButton icon={IconFilter} active={opened} onClick={() => setOpened((o) => !o)}>
              Filters
            </FilterButton>
          </Popover.Target>
        </Indicator>
        <Popover.Dropdown maw={576} w="100%">
          <ScrollArea.Autosize mah={'calc(90vh - var(--header-height) - 56px)'} type="hover">
            <Stack gap={8} pb="xl">
              {/* Clear all filters button */}
              {filterLength > 0 && (
                <Button
                  variant="subtle"
                  size="xs"
                  leftSection={<IconX size={14} />}
                  onClick={clearAllFilters}
                  className="self-start"
                >
                  Clear all filters
                </Button>
              )}

              <Divider label="Reactions" className="text-sm font-bold" />
              <div className="flex gap-2">
                {Object.values(GenerationReactType).map((marker) => {
                  return (
                    <FilterChip
                      key={marker}
                      checked={marker === filters.marker}
                      onChange={(checked) => {
                        setMarker(checked ? marker : undefined);
                        setFilters({ marker: checked ? marker : undefined });
                      }}
                    >
                      <span>{titleCase(marker)}</span>
                    </FilterChip>
                  );
                })}
              </div>

              {!hideMediaTypes && (
                <>
                  <Divider label="Generation Type" className="text-sm font-bold" />
                  <div className="flex gap-2">
                    <FilterChip
                      checked={!filters.tags?.length}
                      onChange={() => setFilters({ tags: [] })}
                    >
                      All
                    </FilterChip>
                    <FilterChip
                      checked={filters.tags?.includes(WORKFLOW_TAGS.IMAGE) ?? false}
                      onChange={() => setFilters({ tags: [WORKFLOW_TAGS.IMAGE] })}
                    >
                      Images
                    </FilterChip>
                    <FilterChip
                      checked={filters.tags?.includes(WORKFLOW_TAGS.VIDEO) ?? false}
                      onChange={() => setFilters({ tags: [WORKFLOW_TAGS.VIDEO] })}
                    >
                      Videos
                    </FilterChip>
                  </div>
                </>
              )}

              {/* Base Model Filter */}
              <Divider label="Base Model" className="text-sm font-bold" />
              <div className="flex flex-wrap gap-2">
                <FilterChip
                  checked={!filters.baseModel}
                  onChange={() => setFilters({ baseModel: undefined })}
                >
                  All Models
                </FilterChip>
                {baseModelGroups.map((group) => (
                  <FilterChip
                    key={group}
                    checked={filters.baseModel === group}
                    onChange={(checked) => setFilters({ baseModel: checked ? group : undefined })}
                  >
                    {baseModelGroupConfig[group as BaseModelGroup]?.name ?? group}
                  </FilterChip>
                ))}
              </div>

              {/* Process Type Filter */}
              <Divider label="Process Type" className="text-sm font-bold" />
              <div className="flex flex-wrap gap-2">
                <FilterChip
                  checked={!filters.processType}
                  onChange={() => setFilters({ processType: undefined })}
                >
                  All
                </FilterChip>
                {PROCESS_TYPE_OPTIONS.map(({ value, label }) => (
                  <FilterChip
                    key={value}
                    checked={filters.processType === value}
                    onChange={(checked) => setFilters({ processType: checked ? value : undefined })}
                  >
                    {label}
                  </FilterChip>
                ))}
              </div>

              {/* Date Range Filter */}
              <Divider label="Date Range" className="text-sm font-bold" />
              <Group grow>
                <DatePickerInput
                  label="From"
                  placeholder="Start date"
                  value={filters.fromDate}
                  onChange={(date) => setFilters({ fromDate: date ?? undefined })}
                  maxDate={filters.toDate ?? undefined}
                  clearable
                  size="xs"
                />
                <DatePickerInput
                  label="To"
                  placeholder="End date"
                  value={filters.toDate}
                  onChange={(date) => setFilters({ toDate: date ?? undefined })}
                  minDate={filters.fromDate ?? undefined}
                  clearable
                  size="xs"
                />
              </Group>

              {/* Status Filter */}
              <Divider label="Status" className="text-sm font-bold" />
              <div className="flex gap-2">
                <FilterChip
                  checked={filters.excludeFailed ?? false}
                  onChange={(checked) => setFilters({ excludeFailed: checked || undefined })}
                >
                  Hide Failed
                </FilterChip>
              </div>
            </Stack>
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
  text?: ReactNode;
  hideMediaTypes?: boolean;
};
