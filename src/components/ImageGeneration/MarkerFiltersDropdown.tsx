import type { ButtonProps, ComboboxItem, PopoverProps } from '@mantine/core';
import {
  Button,
  Divider,
  Group,
  Indicator,
  Popover,
  ScrollArea,
  Select,
  Stack,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconFilter, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { IsClient } from '~/components/IsClient/IsClient';
import { isMobileDevice } from '~/hooks/useIsMobile';
import type { GenerationFilterSchema } from '~/providers/FiltersProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { GenerationReactType } from '~/server/common/enums';
import {
  ecosystemFamilyById,
  ecosystems,
  getEcosystemSupport,
} from '~/shared/constants/basemodel.constants';
import { workflowConfigsArray } from '~/shared/data-graph/generation/config/workflows';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { titleCase } from '~/utils/string-helpers';

// Get workflow options split by category (exclude utility workflows)
const allWorkflowOptions = workflowConfigsArray.filter((w) => !w.noSubmit);

// Build grouped workflow select data
const workflowSelectData = (() => {
  const imageWorkflows = allWorkflowOptions.filter((w) => w.category === 'image');
  const videoWorkflows = allWorkflowOptions.filter((w) => w.category === 'video');
  const groups: { group: string; items: ComboboxItem[] }[] = [];
  if (imageWorkflows.length) {
    groups.push({
      group: 'Image',
      items: imageWorkflows.map((w) => ({ value: w.key, label: w.label })),
    });
  }
  if (videoWorkflows.length) {
    groups.push({
      group: 'Video',
      items: videoWorkflows.map((w) => ({ value: w.key, label: w.label })),
    });
  }
  return groups;
})();

// Build grouped ecosystem select data
const ecosystemSelectData = (() => {
  const genEcosystems = ecosystems
    .filter((e) => getEcosystemSupport(e.id, 'generation'))
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

  const familyGroups = new Map<string, ComboboxItem[]>();
  for (const eco of genEcosystems) {
    const family = eco.familyId ? ecosystemFamilyById.get(eco.familyId) : undefined;
    const groupName = family?.name ?? 'Other';
    if (!familyGroups.has(groupName)) familyGroups.set(groupName, []);
    familyGroups.get(groupName)!.push({ value: eco.key, label: eco.displayName });
  }

  return Array.from(familyGroups.entries()).map(([group, items]) => ({ group, items }));
})();

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
              <Divider label="Ecosystem" className="text-sm font-bold" />
              <Select
                data={ecosystemSelectData}
                value={filters.baseModel ?? null}
                onChange={(value) => setFilters({ baseModel: value ?? undefined })}
                placeholder="All Models"
                searchable={!isMobileDevice()}
                clearable
                comboboxProps={{ withinPortal: false }}
              />

              {/* Workflow Filter */}
              <Divider label="Workflow" className="text-sm font-bold" />
              <Select
                data={workflowSelectData}
                value={filters.processType ?? null}
                onChange={(value) => setFilters({ processType: value ?? undefined })}
                placeholder="All Workflows"
                searchable={!isMobileDevice()}
                clearable
                comboboxProps={{ withinPortal: false }}
              />

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
                />
                <DatePickerInput
                  label="To"
                  placeholder="End date"
                  value={filters.toDate}
                  onChange={(date) => setFilters({ toDate: date ?? undefined })}
                  minDate={filters.fromDate ?? undefined}
                  clearable
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
