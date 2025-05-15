import {
  Button,
  ButtonProps,
  Chip,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  Stack,
  useComputedColorScheme,
} from '@mantine/core';
import { ToolType } from '~/shared/utils/prisma/enums';
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { GetAllToolsSchema } from '~/server/schema/tool.schema';

import { useIsClient } from '~/providers/IsClientProvider';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import styles from './ToolFiltersDropdown.module.scss';

const toolTypes = Object.keys(ToolType);

export function ToolFiltersDropdown({ query, onChange, ...buttonProps }: Props) {
  const colorScheme = useComputedColorScheme('dark');
  const mobile = useIsMobile();
  const isClient = useIsClient();

  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.tools,
    setFilters: state.setToolFilters,
  }));

  const mergedFilters = query || filters;
  const filterLength = mergedFilters.type ? 1 : 0;

  const clearFilters = useCallback(() => {
    const reset = {
      type: undefined,
    };

    if (onChange) onChange(reset);
    else setFilters(reset);
  }, [onChange, setFilters]);

  const handleChange: Props['onChange'] = (value) => {
    onChange ? onChange(value) : setFilters(value);
  };

  const target = (
    <Indicator
      offset={4}
      label={isClient && filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      classNames={{ root: 'leading-none', indicator: 'leading-relaxed	' }}
      inline
    >
      <FilterButton
        {...buttonProps}
        icon={IconFilter}
        onClick={() => setOpened((o) => !o)}
        active={opened}
      >
        Filters
      </FilterButton>
    </Indicator>
  );

  if (!isClient) return target;

  const dropdown = (
    <Stack gap="lg">
      <Stack gap="md">
        <Divider label="Type" classNames={{ label: 'font-bold text-sm' }} />
        <Chip.Group
          value={mergedFilters.type}
          onChange={(type) => handleChange({ type: type as ToolType })}
        >
          <Group gap={8} my={4}>
            {toolTypes.map((tool, index) => (
              <FilterChip key={index} value={tool}>
                <span>{tool}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>
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
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          size="90%"
          position="bottom"
          classNames={{
            content: styles.content,
            body: styles.body,
            header: styles.header,
            close: styles.close,
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
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<GetAllToolsSchema>;
  onChange?: (params: Partial<GetAllToolsSchema>) => void;
};
