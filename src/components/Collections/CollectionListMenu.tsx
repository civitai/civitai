import { Menu, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconCheck, IconLayoutList, IconList, IconArrowsSort } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { SORT_OPTIONS } from './collection-list.utils';
import type { CollectionListView, CollectionSort } from './collection-list.utils';

export function CollectionListMenu({
  sort,
  setSort,
  view,
  setView,
}: {
  sort: CollectionSort;
  setSort: (value: CollectionSort) => void;
  view: CollectionListView;
  setView: (value: CollectionListView) => void;
}) {
  return (
    // This project inverts Mantine's default to `withinPortal: false` globally
    // (ThemeProvider.tsx), and the sidebar Card is `overflow: hidden` — unportalled the dropdown
    // renders but clips to invisible.
    <Menu position="bottom-end" width={240} withinPortal zIndex={400}>
      <Menu.Target>
        <LegacyActionIcon variant="light" size="sm" aria-label="Sort and view options">
          <IconArrowsSort size={18} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Sort by</Menu.Label>
        {SORT_OPTIONS.map((option) => (
          <Menu.Item
            key={option.value}
            onClick={() => setSort(option.value)}
            rightSection={sort === option.value ? <IconCheck size={14} /> : undefined}
          >
            {option.value === sort ? (
              <Text c="blue" inherit>
                {option.label}
              </Text>
            ) : (
              option.label
            )}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Label>View as</Menu.Label>
        <Stack gap={4} px="xs" pb="xs">
          <SegmentedControl
            size="xs"
            fullWidth
            value={view}
            onChange={(value) => setView(value as CollectionListView)}
            data={[
              {
                value: 'default',
                label: <IconLayoutList size={16} role="img" aria-label="Default view" />,
              },
              {
                value: 'compact',
                label: <IconList size={16} role="img" aria-label="Compact view" />,
              },
            ]}
          />
        </Stack>
      </Menu.Dropdown>
    </Menu>
  );
}
