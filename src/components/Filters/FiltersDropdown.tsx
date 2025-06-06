import { Popover, Indicator, ActionIcon } from '@mantine/core';
import { IconFilter, IconChevronDown } from '@tabler/icons-react';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

export function FiltersDropdown({
  children,
  count,
}: {
  children: React.ReactElement;
  count?: number;
}) {
  return (
    <Popover withArrow>
      <Popover.Target>
        <Indicator
          offset={4}
          label={count ? count : undefined}
          size={16}
          zIndex={10}
          disabled={!count}
          inline
        >
          <LegacyActionIcon color="dark" variant="transparent" style={{ width: 40 }}>
            <IconFilter size={20} stroke={2.5} />
            <IconChevronDown size={16} stroke={3} />
          </LegacyActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown maw={350} w="100%">
        {children}
      </Popover.Dropdown>
    </Popover>
  );
}
