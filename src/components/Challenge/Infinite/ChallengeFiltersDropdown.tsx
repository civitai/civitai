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
import { useRouter } from 'next/router';
import { useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { IsClient } from '~/components/IsClient/IsClient';
import { useIsMobile } from '~/hooks/useIsMobile';

const statusFilters = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'upcoming', label: 'Upcoming' },
];

const defaultStatus = ['active', 'completed'];

export function parseStatusQuery(raw: string | string[] | undefined): string[] {
  if (!raw) return defaultStatus;
  return Array.isArray(raw) ? raw : raw.split(',');
}

export function ChallengeFiltersDropdown() {
  const router = useRouter();
  const colorScheme = useComputedColorScheme('dark');
  const mobile = useIsMobile();
  const [opened, setOpened] = useState(false);

  const statusFilter = parseStatusQuery(router.query.status);

  const handleStatusChange = (value: string[]) => {
    // Prevent deselecting all options
    if (value.length === 0) return;
    router.replace(
      { pathname: '/challenges', query: { ...router.query, status: value.join(',') } },
      undefined,
      { shallow: true }
    );
  };

  const clearFilters = () => {
    router.replace(
      { pathname: '/challenges', query: { ...router.query, status: undefined } },
      undefined,
      { shallow: true }
    );
  };

  // Count active filters (excluding defaults)
  const isDefault =
    statusFilter.length === defaultStatus.length &&
    defaultStatus.every((s) => statusFilter.includes(s));
  const filterLength = isDefault ? 0 : 1;

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
        <Divider label="Status" className="text-sm font-bold" mb={4} />
        <Chip.Group multiple value={statusFilter} onChange={handleStatusChange}>
          <Group gap={8} mb={4}>
            {statusFilters.map((option) => (
              <FilterChip key={option.value} value={option.value}>
                <span>{option.label}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
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
        position="bottom-end"
        shadow="md"
        onClose={() => setOpened(false)}
        middlewares={{ flip: true, shift: true }}
        withinPortal
        withArrow
      >
        <Popover.Target>{target}</Popover.Target>
        <Popover.Dropdown maw={468} p={0} w="100%">
          <ScrollArea.Autosize mah="calc(90vh - var(--header-height) - 56px)" type="hover">
            {dropdown}
          </ScrollArea.Autosize>
        </Popover.Dropdown>
      </Popover>
    </IsClient>
  );
}
