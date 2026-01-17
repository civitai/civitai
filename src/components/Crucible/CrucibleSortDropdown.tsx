import { Button, Menu, Text } from '@mantine/core';
import { IconChevronDown, IconSortDescending, IconCheck } from '@tabler/icons-react';
import { useCrucibleFilters, useCrucibleQueryParams } from '~/components/Crucible/crucible.utils';
import { CrucibleSort } from '~/server/common/enums';

const sortOptions = [
  { label: 'Prize Pool', value: CrucibleSort.PrizePool },
  { label: 'Ending Soon', value: CrucibleSort.EndingSoon },
  { label: 'Newest', value: CrucibleSort.Newest },
  { label: 'Most Entries', value: CrucibleSort.MostEntries },
];

/**
 * Sort dropdown for the crucible discovery page
 *
 * Displays a dropdown menu with sort options that syncs with URL query parameters.
 * Options: Prize Pool (default), Ending Soon, Newest, Most Entries
 */
export function CrucibleSortDropdown() {
  const filters = useCrucibleFilters();
  const { replace } = useCrucibleQueryParams();

  const currentSort = filters.sort || CrucibleSort.PrizePool;
  const currentLabel = sortOptions.find((opt) => opt.value === currentSort)?.label ?? 'Prize Pool';

  const handleSortChange = (value: CrucibleSort) => {
    // If selecting the default (PrizePool), clear the sort param from URL
    if (value === CrucibleSort.PrizePool) {
      replace({ sort: undefined });
    } else {
      replace({ sort: value });
    }
  };

  return (
    <Menu position="bottom-end" withArrow>
      <Menu.Target>
        <Button
          variant="default"
          leftSection={<IconSortDescending size={16} />}
          rightSection={<IconChevronDown size={14} />}
        >
          {currentLabel}
        </Button>
      </Menu.Target>

      <Menu.Dropdown miw={180}>
        {sortOptions.map((option) => (
          <Menu.Item
            key={option.value}
            onClick={() => handleSortChange(option.value)}
            rightSection={currentSort === option.value ? <IconCheck size={14} /> : undefined}
          >
            <Text size="sm" fw={currentSort === option.value ? 600 : 400}>
              {option.label}
            </Text>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
