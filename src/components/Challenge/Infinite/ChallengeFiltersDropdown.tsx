import { Chip, Divider, Drawer, Group, Indicator, Popover, ScrollArea, Stack } from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useMemo } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
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

type ChallengeFilterState = {
  status: string[];
  participation: ChallengeParticipation | undefined;
};

export function ChallengeFiltersDropdown() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const mobile = useIsMobile();

  const statusFilter = parseStatusQuery(router.query.status);
  const participationFilter = parseParticipationQuery(router.query.participation);

  const committedFilters = useMemo<ChallengeFilterState>(
    () => ({ status: statusFilter, participation: participationFilter }),
    [statusFilter, participationFilter]
  );

  const handleApply = useCallback(
    (next: ChallengeFilterState) => {
      // Prevent committing an empty status set — matches the legacy
      // handleStatusChange guard that disallowed deselecting all options.
      const status = next.status.length === 0 ? defaultStatus : next.status;
      router.replace(
        {
          pathname: '/challenges',
          query: {
            ...router.query,
            status: status.join(','),
            participation: next.participation || undefined,
          },
        },
        undefined,
        { shallow: true }
      );
    },
    [router]
  );

  const handleClear = useCallback(() => {
    router.replace(
      {
        pathname: '/challenges',
        query: { ...router.query, status: undefined, participation: undefined },
      },
      undefined,
      { shallow: true }
    );
  }, [router]);

  const { opened, toggle, close, mergedFilters, isDirty, patchPending, apply, reset, clearAndClose } =
    useStagedFilters({
      committed: committedFilters,
      onApply: handleApply,
      onClear: handleClear,
    });

  const handleStatusChange = (value: string[]) => {
    // Mirror the legacy guard: never let the pending set go fully empty.
    if (value.length === 0) return;
    patchPending({ status: value });
  };

  const handleParticipationChange = (value: string | string[]) => {
    const selected = Array.isArray(value) ? value[0] : value;
    const newValue =
      selected === mergedFilters.participation
        ? undefined
        : (selected as ChallengeParticipation | undefined);
    patchPending({ participation: newValue });
  };

  const hasStatusDefault =
    mergedFilters.status.length === defaultStatus.length &&
    defaultStatus.every((s) => mergedFilters.status.includes(s));
  const hasParticipation = !!mergedFilters.participation;
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
      <FilterButton icon={IconFilter} onClick={toggle} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdownBody = (
    <Stack gap={8} p="md">
      <Stack gap={0}>
        <Divider label="Status" className="text-sm font-bold" mb={4} />
        <Chip.Group multiple value={mergedFilters.status} onChange={handleStatusChange}>
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
          <Chip.Group
            value={mergedFilters.participation ?? ''}
            onChange={handleParticipationChange}
          >
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
        position="bottom-end"
        shadow="md"
        opened={opened}
        onClose={close}
        middlewares={{ flip: true, shift: true }}
        withinPortal
        withArrow
      >
        <Popover.Target>{target}</Popover.Target>
        <Popover.Dropdown maw={468} p={0} w="100%">
          <ScrollArea.Autosize mah="calc(90vh - var(--header-height) - 156px)" type="hover">
            {dropdownBody}
          </ScrollArea.Autosize>
          {dropdownFooter}
        </Popover.Dropdown>
      </Popover>
    </IsClient>
  );
}
