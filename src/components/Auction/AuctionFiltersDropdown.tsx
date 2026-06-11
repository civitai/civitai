import { Chip, Divider, Drawer, Group, Indicator, Popover, Stack } from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { useCallback } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { getDisplayName } from '~/utils/string-helpers';
import classes from './AuctionFiltersDropdown.module.scss';
import type { BaseModel } from '~/shared/constants/basemodel.constants';

export const AuctionFiltersDropdown = ({ baseModels }: { baseModels: BaseModel[] }) => {
  const mobile = useIsMobile();

  const { filters: committedFilters, setFilters } = useFiltersContext((state) => ({
    filters: state.auctions,
    setFilters: state.setAuctionFilters,
  }));

  const handleClear = useCallback(() => setFilters({ baseModels: undefined }), [setFilters]);

  const { opened, toggle, close, mergedFilters, isDirty, patchPending, apply, reset, clearAndClose } =
    useStagedFilters({
      committed: committedFilters,
      onApply: setFilters,
      onClear: handleClear,
    });

  const filterLength = mergedFilters.baseModels?.length ? 1 : 0;

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
      <Stack gap={0}>
        <Divider label="Base model" classNames={{ label: 'font-bold text-sm' }} mb="sm" />
        <Chip.Group
          value={(mergedFilters.baseModels as string[]) ?? []}
          onChange={(baseModels) => patchPending({ baseModels: baseModels as BaseModel[] })}
          multiple
        >
          <Group gap={8} my={4}>
            {baseModels.map((baseModel, index) => (
              <FilterChip key={index} value={baseModel}>
                <span>{getDisplayName(baseModel, { splitNumbers: false })}</span>
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
          classNames={{ ...classes }}
          styles={{
            content: { display: 'flex', flexDirection: 'column' },
            body: {
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              flex: 1,
              minHeight: 0,
            },
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
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p={0} w="100%">
        {dropdownBody}
        {dropdownFooter}
      </Popover.Dropdown>
    </Popover>
  );
};
