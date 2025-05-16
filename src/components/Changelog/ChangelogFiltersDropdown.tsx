import {
  Button,
  Chip,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  Stack,
  useComputedColorScheme,
} from '@mantine/core';
import { DatePicker } from '@mantine/dates';
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { useIsMobile } from '~/hooks/useIsMobile';
import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { ChangelogType } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const ChangelogTagSelect = ({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) => {
  const { data = [], isLoading } = trpc.changelog.getAllTags.useQuery();

  return (
    <MultiSelectWrapper
      value={value}
      onChange={onChange}
      loading={isLoading}
      placeholder="Select tags..."
      data={data}
      searchable
      clearable
    />
  );
};

export function ChangelogFiltersDropdown() {
  const mobile = useIsMobile();
  const [opened, setOpened] = useState(false);
  const colorScheme = useComputedColorScheme('dark');

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.changelogs,
    setFilters: state.setChangelogFilters,
  }));

  const filterLength =
    (filters.types?.length ? 1 : 0) +
    (filters.tags?.length ? 1 : 0) +
    (filters.dateBefore ? 1 : 0) +
    (filters.dateAfter ? 1 : 0);

  const clearFilters = useCallback(
    () =>
      setFilters({
        types: undefined,
        tags: undefined,
        dateBefore: undefined,
        dateAfter: undefined,
      }),
    [setFilters]
  );

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      inline
    >
      <FilterButton
        icon={IconFilter}
        size="md"
        onClick={() => setOpened((o) => !o)}
        active={opened}
      >
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdown = (
    <Stack gap="lg">
      <Stack gap="md">
        <Divider label="Types" className="text-sm font-bold" />
        <Chip.Group
          multiple
          value={filters.types ?? []}
          onChange={(types) => {
            setFilters({
              ...filters,
              types: types as ChangelogType[],
            });
          }}
        >
          <Group gap={8}>
            {Object.values(ChangelogType).map((type, index) => (
              <FilterChip key={index} value={type}>
                <span>{getDisplayName(type)}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>
      <Stack gap="md">
        <Divider label="Tags" className="text-sm font-bold" />
        <ChangelogTagSelect
          value={filters.tags ?? []}
          onChange={(tags) => setFilters({ ...filters, tags })}
        />
      </Stack>
      <Stack gap="md">
        <Divider label="Before" className="text-sm font-bold" />
        <DatePicker
          placeholder="Choose a date..."
          value={filters.dateBefore ?? null}
          onChange={(x) => {
            setFilters({
              ...filters,
              dateBefore: x ?? undefined,
            });
          }}
        />
      </Stack>
      <Stack gap="md">
        <Divider label="After" className="text-sm font-bold" />
        <DatePicker
          placeholder="Choose a date..."
          value={filters.dateAfter ?? null}
          onChange={(x) => {
            setFilters({
              ...filters,
              dateAfter: x ?? undefined,
            });
          }}
        />
      </Stack>
      {filterLength > 0 && (
        <Button
          color="gray"
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={clearFilters}
          fullWidth
        >
          Clear all
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
            content: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              overflowY: 'auto',
            },
            body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          {dropdown}
        </Drawer>
      </>
    );

  return (
    <Popover
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      onClose={() => setOpened(false)}
      middlewares={{ flip: true, shift: true }}
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p="md" w="100%">
        {dropdown}
      </Popover.Dropdown>
    </Popover>
  );
}
