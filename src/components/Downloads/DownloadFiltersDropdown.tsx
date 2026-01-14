import {
  ActionIcon,
  Badge,
  Button,
  CloseButton,
  Divider,
  Group,
  Paper,
  Popover,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconBox,
  IconCheck,
  IconClock,
  IconCpu,
  IconFileCode,
  IconSearch,
  IconTag,
  IconTrash,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { getDisplayName } from '~/utils/string-helpers';
import type { DownloadFilters, DownloadPeriod } from './download.utils';
import { periodLabels } from './download.utils';

type FilterOption = {
  value: string;
  label: string;
};

type FilterBarProps = {
  filters: DownloadFilters;
  availableOptions: {
    modelTypes: string[];
    fileTypes: string[];
    formats: string[];
    baseModels: string[];
  };
  onFiltersChange: (filters: Partial<DownloadFilters>) => void;
};

type ActiveFiltersProps = {
  filters: DownloadFilters;
  onFiltersChange: (filters: Partial<DownloadFilters>) => void;
  onClearFilters: () => void;
  onClearHistory: () => void;
  hasActiveFilters: boolean;
};

function FilterButton({
  icon,
  label,
  isActive,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  children: React.ReactNode;
}) {
  return (
    <Popover position="bottom-start" withArrow shadow="md" withinPortal>
      <Popover.Target>
        <Tooltip label={label} color="dark" withArrow withinPortal>
          <ActionIcon
            variant={isActive ? 'light' : 'subtle'}
            color={isActive ? 'blue' : 'gray'}
            size="lg"
            radius="md"
          >
            {icon}
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown maw={280} p="sm">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb="xs">
          {label}
        </Text>
        {children}
      </Popover.Dropdown>
    </Popover>
  );
}

function ChipSelector({
  options,
  selected,
  onChange,
}: {
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const toggleValue = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  return (
    <Group gap={6}>
      {options.map((option) => {
        const isSelected = selected.includes(option.value);
        return (
          <Button
            key={option.value}
            size="xs"
            radius="xl"
            variant={isSelected ? 'filled' : 'light'}
            color={isSelected ? 'blue' : 'gray'}
            onClick={() => toggleValue(option.value)}
            classNames={{
              root: clsx(
                'transition-colors',
                !isSelected && 'border border-gray-3 dark:border-dark-4'
              ),
            }}
          >
            {option.label}
          </Button>
        );
      })}
    </Group>
  );
}

function PeriodSelector({
  selected,
  onChange,
}: {
  selected: DownloadPeriod | undefined;
  onChange: (value: DownloadPeriod | undefined) => void;
}) {
  const periods: DownloadPeriod[] = ['all', 'day', 'week', 'month', 'year'];
  const currentValue = selected ?? 'all';

  return (
    <Stack gap={4}>
      {periods.map((period) => {
        const isActive = period === currentValue;
        return (
          <Button
            key={period}
            size="xs"
            variant={isActive ? 'light' : 'subtle'}
            color={isActive ? 'blue' : 'gray'}
            justify="space-between"
            fullWidth
            rightSection={isActive ? <IconCheck size={14} /> : null}
            onClick={() => onChange(period === 'all' ? undefined : period)}
          >
            {periodLabels[period]}
          </Button>
        );
      })}
    </Stack>
  );
}

/** Search bar with filter buttons - can be placed next to title */
export function DownloadFilterBar({ filters, availableOptions, onFiltersChange }: FilterBarProps) {
  // Local state for search input with debouncing
  const [searchValue, setSearchValue] = useState(filters.query ?? '');
  const [debouncedSearch] = useDebouncedValue(searchValue, 300);

  // Update filters when debounced value changes
  useEffect(() => {
    const newQuery = debouncedSearch || undefined;
    if (newQuery !== filters.query) {
      onFiltersChange({ query: newQuery });
    }
  }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync local state when filters.query changes externally (e.g., URL navigation or clear filters)
  useEffect(() => {
    setSearchValue(filters.query ?? '');
  }, [filters.query]);

  const modelTypeOptions: FilterOption[] = useMemo(
    () =>
      availableOptions.modelTypes.map((type) => ({
        value: type,
        label: getDisplayName(type),
      })),
    [availableOptions.modelTypes]
  );

  const fileTypeOptions: FilterOption[] = useMemo(
    () =>
      availableOptions.fileTypes.map((type) => ({
        value: type,
        label: type,
      })),
    [availableOptions.fileTypes]
  );

  const formatOptions: FilterOption[] = useMemo(
    () =>
      availableOptions.formats.map((format) => ({
        value: format,
        label: format,
      })),
    [availableOptions.formats]
  );

  const baseModelOptions: FilterOption[] = useMemo(
    () =>
      availableOptions.baseModels.map((model) => ({
        value: model,
        label: model,
      })),
    [availableOptions.baseModels]
  );

  return (
    <Paper radius="xl" withBorder shadow="sm" p="xs" className="bg-white dark:bg-dark-6">
      <Group gap="xs" wrap="nowrap">
        {/* Search Input */}
        <TextInput
          placeholder="Search downloads..."
          leftSection={<IconSearch size={18} />}
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          variant="unstyled"
          className="flex-1"
          classNames={{
            input: 'pl-9',
          }}
        />

        {/* Separator */}
        <Divider orientation="vertical" className="h-8" />

        {/* Filter Buttons */}
        <Group gap={4}>
          {/* Model Type */}
          <FilterButton
            icon={<IconBox size={20} />}
            label="Model Type"
            isActive={Boolean(filters.modelTypes?.length)}
          >
            <ChipSelector
              options={modelTypeOptions}
              selected={filters.modelTypes ?? []}
              onChange={(values) =>
                onFiltersChange({ modelTypes: values.length ? values : undefined })
              }
            />
          </FilterButton>

          {/* File Type */}
          <FilterButton
            icon={<IconTag size={20} />}
            label="File Type"
            isActive={Boolean(filters.fileTypes?.length)}
          >
            <ChipSelector
              options={fileTypeOptions}
              selected={filters.fileTypes ?? []}
              onChange={(values) =>
                onFiltersChange({ fileTypes: values.length ? values : undefined })
              }
            />
          </FilterButton>

          {/* Format */}
          <FilterButton
            icon={<IconFileCode size={20} />}
            label="Format"
            isActive={Boolean(filters.formats?.length)}
          >
            <ChipSelector
              options={formatOptions}
              selected={filters.formats ?? []}
              onChange={(values) =>
                onFiltersChange({ formats: values.length ? values : undefined })
              }
            />
          </FilterButton>

          {/* Base Model */}
          <FilterButton
            icon={<IconCpu size={20} />}
            label="Base Model"
            isActive={Boolean(filters.baseModels?.length)}
          >
            <ChipSelector
              options={baseModelOptions}
              selected={filters.baseModels ?? []}
              onChange={(values) =>
                onFiltersChange({ baseModels: values.length ? values : undefined })
              }
            />
          </FilterButton>

          {/* Time Period */}
          <FilterButton
            icon={<IconClock size={20} />}
            label="Time Period"
            isActive={Boolean(filters.period && filters.period !== 'all')}
          >
            <PeriodSelector
              selected={filters.period}
              onChange={(value) => onFiltersChange({ period: value })}
            />
          </FilterButton>
        </Group>
      </Group>
    </Paper>
  );
}

/** Active filter badges and clear history button */
export function DownloadActiveFilters({
  filters,
  onFiltersChange,
  onClearFilters,
  onClearHistory,
  hasActiveFilters,
}: ActiveFiltersProps) {
  const activeFilters: { type: string; value: string; icon: React.ReactNode }[] = [];

  // Collect active filters for display
  if (filters.modelTypes?.length) {
    for (const type of filters.modelTypes) {
      activeFilters.push({
        type: 'modelTypes',
        value: type,
        icon: <IconBox size={14} />,
      });
    }
  }
  if (filters.fileTypes?.length) {
    for (const type of filters.fileTypes) {
      activeFilters.push({
        type: 'fileTypes',
        value: type,
        icon: <IconTag size={14} />,
      });
    }
  }
  if (filters.formats?.length) {
    for (const format of filters.formats) {
      activeFilters.push({
        type: 'formats',
        value: format,
        icon: <IconFileCode size={14} />,
      });
    }
  }
  if (filters.baseModels?.length) {
    for (const model of filters.baseModels) {
      activeFilters.push({
        type: 'baseModels',
        value: model,
        icon: <IconCpu size={14} />,
      });
    }
  }
  if (filters.period && filters.period !== 'all') {
    activeFilters.push({
      type: 'period',
      value: periodLabels[filters.period],
      icon: <IconClock size={14} />,
    });
  }

  const removeFilter = (type: string, value: string) => {
    if (type === 'period') {
      onFiltersChange({ period: undefined });
    } else {
      const currentValues = filters[type as keyof DownloadFilters] as string[] | undefined;
      if (currentValues) {
        onFiltersChange({
          [type]: currentValues.filter((v) => v !== value),
        });
      }
    }
  };

  return (
    <Group gap="xs" justify="space-between" wrap="wrap">
      <Group gap="xs" wrap="wrap">
        {activeFilters.length > 0 && (
          <>
            <Text size="sm" c="dimmed">
              Filters:
            </Text>
            {activeFilters.map((filter, index) => (
              <Badge
                key={`${filter.type}-${filter.value}-${index}`}
                variant="light"
                color="blue"
                radius="xl"
                leftSection={filter.icon}
                rightSection={
                  <CloseButton
                    size="xs"
                    variant="transparent"
                    onClick={() => removeFilter(filter.type, filter.value)}
                  />
                }
                classNames={{ root: 'pr-1' }}
              >
                {filter.type === 'modelTypes' ? getDisplayName(filter.value) : filter.value}
              </Badge>
            ))}
            <Button variant="subtle" size="compact-xs" color="gray" onClick={onClearFilters}>
              Clear filters
            </Button>
          </>
        )}
      </Group>

      {/* Clear History Button with Confirmation */}
      <PopConfirm
        message="Are you sure you want to clear your entire download history? This action cannot be undone."
        onConfirm={onClearHistory}
        confirmButtonColor="red"
        width={250}
        withArrow
        withinPortal
      >
        <Button
          variant="subtle"
          size="compact-sm"
          color="gray"
          leftSection={<IconTrash size={16} />}
        >
          Clear History
        </Button>
      </PopConfirm>
    </Group>
  );
}

/** Combined component for backwards compatibility - use DownloadFilterBar and DownloadActiveFilters separately for more control */
export function DownloadFiltersDropdown({
  filters,
  availableOptions,
  onFiltersChange,
  onClearFilters,
  onClearHistory,
  hasActiveFilters,
}: FilterBarProps & Omit<ActiveFiltersProps, 'filters' | 'onFiltersChange'>) {
  return (
    <div className="space-y-4">
      <DownloadFilterBar
        filters={filters}
        availableOptions={availableOptions}
        onFiltersChange={onFiltersChange}
      />
      <DownloadActiveFilters
        filters={filters}
        onFiltersChange={onFiltersChange}
        onClearFilters={onClearFilters}
        onClearHistory={onClearHistory}
        hasActiveFilters={hasActiveFilters}
      />
    </div>
  );
}
