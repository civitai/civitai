import { Popover, Indicator, ActionIcon } from '@mantine/core';
import { IconFilter, IconChevronDown } from '@tabler/icons';

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
          showZero={false}
          dot={false}
          size={16}
          inline
          zIndex={10}
        >
          <ActionIcon color="dark" variant="transparent" sx={{ width: 40 }}>
            <IconFilter size={20} stroke={2.5} />
            <IconChevronDown size={16} stroke={3} />
          </ActionIcon>
        </Indicator>
      </Popover.Target>
      <Popover.Dropdown maw={350} w="100%">
        {children}
      </Popover.Dropdown>
    </Popover>
  );
}
