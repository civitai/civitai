import { Chip, Divider, Drawer, Group, Indicator, Popover, Stack } from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconFilter } from '@tabler/icons-react';
import { useCallback } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
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
      comboboxProps={{ withinPortal: false }}
      searchable
      clearable
    />
  );
};

export function ChangelogFiltersDropdown() {
  const mobile = useIsMobile();

  const { filters: committedFilters, setFilters } = useFiltersContext((state) => ({
    filters: state.changelogs,
    setFilters: state.setChangelogFilters,
  }));

  const handleClear = useCallback(
    () =>
      setFilters({
        types: undefined,
        tags: undefined,
        dateBefore: undefined,
        dateAfter: undefined,
      }),
    [setFilters]
  );

  const { opened, toggle, close, mergedFilters, isDirty, patchPending, apply, reset, clearAndClose } =
    useStagedFilters({
      committed: committedFilters,
      onApply: setFilters,
      onClear: handleClear,
    });

  const filterLength =
    (mergedFilters.types?.length ? 1 : 0) +
    (mergedFilters.tags?.length ? 1 : 0) +
    (mergedFilters.dateBefore ? 1 : 0) +
    (mergedFilters.dateAfter ? 1 : 0);

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      inline
    >
      <FilterButton icon={IconFilter} size="md" onClick={toggle} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdownBody = (
    <Stack gap="lg" p="md">
      <Stack gap="md">
        <Divider label="Types" className="text-sm font-bold" />
        <Chip.Group
          multiple
          value={mergedFilters.types ?? []}
          onChange={(types) => patchPending({ types: types as ChangelogType[] })}
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
          value={mergedFilters.tags ?? []}
          onChange={(tags) => patchPending({ tags })}
        />
      </Stack>
      <Stack gap="md">
        <Divider label="Before" className="text-sm font-bold" />
        <DatePickerInput
          placeholder="Choose a date..."
          value={mergedFilters.dateBefore ?? null}
          onChange={(x) => patchPending({ dateBefore: x ?? undefined })}
          clearable
        />
      </Stack>
      <Stack gap="md">
        <Divider label="After" className="text-sm font-bold" />
        <DatePickerInput
          placeholder="Choose a date..."
          value={mergedFilters.dateAfter ?? null}
          onChange={(x) => patchPending({ dateAfter: x ?? undefined })}
          clearable
        />
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
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
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
      middlewares={{ flip: true, shift: true }}
      trapFocus
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p={0} w="100%">
        {dropdownBody}
        {dropdownFooter}
      </Popover.Dropdown>
    </Popover>
  );
}
