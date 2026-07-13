import { Chip, Group, Select, TextInput } from '@mantine/core';
import { IconArrowsSort, IconSearch } from '@tabler/icons-react';
import type { SortKey, StatusFilterValue } from '~/components/CreatorShop/Manage/manage.constants';
import { sortOptions, statusFilters } from '~/components/CreatorShop/Manage/manage.constants';

export function ManageToolbar({
  status,
  onStatusChange,
  search,
  onSearchChange,
  sort,
  onSortChange,
}: {
  status: StatusFilterValue;
  onStatusChange: (value: StatusFilterValue) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sort: SortKey;
  onSortChange: (value: SortKey) => void;
}) {
  return (
    <Group justify="space-between" align="center" gap="sm" wrap="wrap">
      <Chip.Group
        multiple={false}
        value={status}
        onChange={(v) => onStatusChange(v as StatusFilterValue)}
      >
        <Group gap={6} wrap="wrap">
          {statusFilters.map((f) => (
            <Chip key={f.value} value={f.value} size="xs" variant="filled">
              {f.label}
            </Chip>
          ))}
        </Group>
      </Chip.Group>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          placeholder="Search items"
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => onSearchChange(e.currentTarget.value)}
          size="xs"
          w={200}
        />
        <Select
          data={sortOptions}
          value={sort}
          onChange={(v) => onSortChange((v as SortKey) ?? 'newest')}
          size="xs"
          w={190}
          allowDeselect={false}
          leftSection={<IconArrowsSort size={16} />}
          comboboxProps={{ withinPortal: true }}
        />
      </Group>
    </Group>
  );
}
