import {
  Button,
  Chip,
  Divider,
  Drawer,
  Indicator,
  Popover,
  Stack,
  useMantineTheme,
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
  const theme = useMantineTheme();
  const mobile = useIsMobile();
  const [opened, setOpened] = useState(false);

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
      showZero={false}
      dot={false}
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
    <Stack spacing="lg">
      <Stack spacing="md">
        <Divider label="Types" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          multiple
          value={filters.types ?? []}
          onChange={(types: ChangelogType[]) => {
            setFilters({
              ...filters,
              types,
            });
          }}
        >
          {Object.values(ChangelogType).map((type, index) => (
            <FilterChip key={index} value={type}>
              <span>{getDisplayName(type)}</span>
            </FilterChip>
          ))}
        </Chip.Group>
      </Stack>
      <Stack spacing="md">
        <Divider label="Tags" labelProps={{ weight: 'bold', size: 'sm' }} />
        <ChangelogTagSelect
          value={filters.tags ?? []}
          onChange={(tags) => setFilters({ ...filters, tags })}
        />
      </Stack>
      <Stack spacing="md">
        <Divider label="Before" labelProps={{ weight: 'bold', size: 'sm' }} />
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
      <Stack spacing="md">
        <Divider label="After" labelProps={{ weight: 'bold', size: 'sm' }} />
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
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
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
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              overflowY: 'auto',
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
