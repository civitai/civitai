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
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { BaseModel } from '~/server/common/constants';
import { getDisplayName } from '~/utils/string-helpers';

export const AuctionFiltersDropdown = ({ baseModels }: { baseModels: BaseModel[] }) => {
  const theme = useMantineTheme();
  const mobile = useIsMobile();
  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.auctions,
    setFilters: state.setAuctionFilters,
  }));

  const filterLength = filters.baseModels?.length ? 1 : 0;

  const clearFilters = useCallback(
    () =>
      setFilters({
        baseModels: undefined,
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
      <Stack spacing={0}>
        <Divider label="Base model" labelProps={{ weight: 'bold', size: 'sm' }} mb="sm" />
        <Chip.Group
          spacing={8}
          value={(filters.baseModels as string[]) ?? []}
          onChange={(baseModels: BaseModel[]) => setFilters({ ...filters, baseModels })}
          multiple
          my={4}
        >
          {baseModels.map((baseModel, index) => (
            <FilterChip key={index} value={baseModel}>
              <span>{getDisplayName(baseModel, { splitNumbers: false })}</span>
            </FilterChip>
          ))}
        </Chip.Group>
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
};
