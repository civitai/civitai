import { Divider, Drawer, Group, Indicator, Popover, Stack } from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { useMemo } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { useIsMobile } from '~/hooks/useIsMobile';

export const STORYLINE_FEED_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'complete', label: 'Complete' },
  { value: 'open', label: 'Open for continuations' },
] as const;
export type StorylineFeedFilter = (typeof STORYLINE_FEED_FILTERS)[number]['value'];

/**
 * The feed's one filter. Single select across all four: the server takes one value, so "open"
 * cannot be combined with a status.
 */
export function StorylineFiltersDropdown({
  value,
  onChange,
}: {
  value: StorylineFeedFilter;
  onChange: (value: StorylineFeedFilter) => void;
}) {
  const mobile = useIsMobile();
  const committed = useMemo(() => ({ filter: value }), [value]);
  const {
    opened,
    toggle,
    close,
    mergedFilters,
    isDirty,
    patchPending,
    apply,
    reset,
    clearAndClose,
  } = useStagedFilters({
    committed,
    onApply: (next) => onChange(next.filter),
    onClear: () => onChange('all'),
  });

  const filterLength = mergedFilters.filter === 'all' ? 0 : 1;

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
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
    <Stack gap="md" p="md">
      <Divider label="Show" className="text-sm font-bold" />
      <Group gap={8}>
        {STORYLINE_FEED_FILTERS.map(({ value, label }) => (
          <FilterChip
            key={value}
            checked={mergedFilters.filter === value}
            onChange={() => patchPending({ filter: value })}
          >
            <span>{label}</span>
          </FilterChip>
        ))}
      </Group>
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
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={close}
          size="auto"
          position="bottom"
          styles={{ body: { padding: 0 }, header: { padding: '4px 8px' } }}
        >
          {dropdownBody}
          {dropdownFooter}
        </Drawer>
      </>
    );

  return (
    <Popover
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      opened={opened}
      onClose={close}
      middlewares={{ flip: true, shift: true }}
      withinPortal
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p={0} w="100%">
        {dropdownBody}
        {dropdownFooter}
      </Popover.Dropdown>
    </Popover>
  );
}
