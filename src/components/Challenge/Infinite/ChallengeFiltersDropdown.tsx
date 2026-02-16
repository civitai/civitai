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
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ChallengeParticipation } from '~/server/schema/challenge.schema';

const statusFilters = [
  { value: 'active', label: 'Active' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Completed' },
];

const participationFilters = [
  { value: ChallengeParticipation.Entered, label: 'Entered' },
  { value: ChallengeParticipation.NotEntered, label: 'Not Entered' },
  { value: ChallengeParticipation.Won, label: 'Won' },
];

const defaultStatus = ['active', 'upcoming'];

export function parseStatusQuery(raw: string | string[] | undefined): string[] {
  if (!raw) return defaultStatus;
  return Array.isArray(raw) ? raw : raw.split(',');
}

export function parseParticipationQuery(
  raw: string | string[] | undefined
): ChallengeParticipation | undefined {
  if (!raw) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (
    value === ChallengeParticipation.Entered ||
    value === ChallengeParticipation.NotEntered ||
    value === ChallengeParticipation.Won
  )
    return value;
  return undefined;
}

export function ChallengeFiltersDropdown() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const colorScheme = useComputedColorScheme('dark');
  const mobile = useIsMobile();
  const [opened, setOpened] = useState(false);

  const statusFilter = parseStatusQuery(router.query.status);
  const participationFilter = parseParticipationQuery(router.query.participation);

  const handleStatusChange = (value: string[]) => {
    // Prevent deselecting all options
    if (value.length === 0) return;
    router.replace(
      { pathname: '/challenges', query: { ...router.query, status: value.join(',') } },
      undefined,
      { shallow: true }
    );
  };

  const handleParticipationChange = (value: string | string[]) => {
    const selected = Array.isArray(value) ? value[0] : value;
    // Toggle: clicking the same chip deselects it
    const newValue = selected === participationFilter ? undefined : selected;
    router.replace(
      { pathname: '/challenges', query: { ...router.query, participation: newValue || undefined } },
      undefined,
      { shallow: true }
    );
  };

  const clearFilters = () => {
    router.replace(
      {
        pathname: '/challenges',
        query: { ...router.query, status: undefined, participation: undefined },
      },
      undefined,
      { shallow: true }
    );
  };

  // Count active filters (excluding defaults)
  const hasStatusDefault =
    statusFilter.length === defaultStatus.length &&
    defaultStatus.every((s) => statusFilter.includes(s));
  const hasParticipation = !!participationFilter;
  const filterLength = (hasStatusDefault ? 0 : 1) + (hasParticipation ? 1 : 0);

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

      {currentUser && (
        <Stack gap={0}>
          <Divider label="My Challenges" className="text-sm font-bold" mb={4} />
          <Chip.Group value={participationFilter ?? ''} onChange={handleParticipationChange}>
            <Group gap={8} mb={4}>
              {participationFilters.map((option) => (
                <FilterChip key={option.value} value={option.value}>
                  <span>{option.label}</span>
                </FilterChip>
              ))}
            </Group>
          </Chip.Group>
        </Stack>
      )}

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
