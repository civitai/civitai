import { Chip, Divider, Drawer, Group, Indicator, Popover, Stack } from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import type { CrucibleFilterState } from '~/components/Crucible/crucible.utils';
import {
  defaultCrucibleStatus,
  isDefaultCrucibleStatus,
  toCrucibleFilterPatch,
  useCrucibleFilters,
  useCrucibleQueryParams,
} from '~/components/Crucible/crucible.utils';
import { FilterChip } from '~/components/Filters/FilterChip';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { CrucibleContentType } from '~/shared/constants/crucible.constants';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';

const contentTypeOptions: { value?: CrucibleContentType; label: string }[] = [
  { label: 'All' },
  { value: MediaType.image, label: 'Images' },
  { value: MediaType.video, label: 'Videos' },
];

const statusOptions = [
  { value: CrucibleStatus.Active, label: 'Active' },
  { value: CrucibleStatus.Pending, label: 'Upcoming' },
  { value: CrucibleStatus.Completed, label: 'Completed' },
];

export function CrucibleFiltersDropdown() {
  const mobile = useIsMobile();
  const filters = useCrucibleFilters();
  const setFilters = useFiltersContext((state) => state.setCrucibleFilters);
  const { query, replace } = useCrucibleQueryParams();

  const committedFilters = useMemo<CrucibleFilterState>(
    () => ({
      status: filters.status?.length ? filters.status : defaultCrucibleStatus,
      contentType: filters.contentType,
    }),
    [filters.status, filters.contentType]
  );

  // The choice is saved to the store so it survives leaving the page. URL params win over the
  // store, so a shared link's params are dropped once the viewer picks their own.
  const hasUrlFilters = !!query.status || !!query.contentType;
  const handleApply = useCallback(
    (next: CrucibleFilterState) => {
      setFilters(toCrucibleFilterPatch(next));
      if (hasUrlFilters) replace({ status: undefined, contentType: undefined });
    },
    [setFilters, replace, hasUrlFilters]
  );

  const handleClear = useCallback(
    () => handleApply({ status: defaultCrucibleStatus, contentType: undefined }),
    [handleApply]
  );

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
    committed: committedFilters,
    onApply: handleApply,
    onClear: handleClear,
  });

  const filterLength =
    (isDefaultCrucibleStatus(mergedFilters.status) ? 0 : 1) + (mergedFilters.contentType ? 1 : 0);

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
    <Stack gap="lg" p="md">
      <Stack gap="md">
        <Divider label="Content type" className="text-sm font-bold" />
        <Group gap={8}>
          {contentTypeOptions.map(({ value, label }) => (
            <FilterChip
              key={label}
              checked={mergedFilters.contentType === value}
              onChange={() => patchPending({ contentType: value })}
            >
              <span>{label}</span>
            </FilterChip>
          ))}
        </Group>
      </Stack>
      <Stack gap="md">
        <Divider label="Status" className="text-sm font-bold" />
        <Chip.Group
          multiple
          value={mergedFilters.status}
          onChange={(value) => {
            if (value.length) patchPending({ status: value as CrucibleStatus[] });
          }}
        >
          <Group gap={8}>
            {statusOptions.map(({ value, label }) => (
              <FilterChip key={value} value={value}>
                <span>{label}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>
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
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">{dropdownBody}</div>
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
      onChange={(next) => {
        if (!next) close();
      }}
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
