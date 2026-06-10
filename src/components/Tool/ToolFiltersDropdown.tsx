import type { ButtonProps } from '@mantine/core';
import { Chip, Divider, Drawer, Group, Indicator, Popover, Stack } from '@mantine/core';
import { ToolType } from '~/shared/utils/prisma/enums';
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { GetAllToolsSchema } from '~/server/schema/tool.schema';

import { useIsClient } from '~/providers/IsClientProvider';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import styles from './ToolFiltersDropdown.module.scss';

const toolTypes = Object.keys(ToolType);

export function ToolFiltersDropdown({ query, onChange, ...buttonProps }: Props) {
  const mobile = useIsMobile();
  const isClient = useIsClient();

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.tools,
    setFilters: state.setToolFilters,
  }));

  const committedFilters = useMemo(() => query || filters, [query, filters]);

  const handleApply = useCallback(
    (next: typeof committedFilters) => {
      if (onChange) onChange(next);
      else setFilters(next);
    },
    [onChange, setFilters]
  );

  const handleClear = useCallback(() => {
    const reset = { type: undefined };
    if (onChange) onChange(reset);
    else setFilters(reset);
  }, [onChange, setFilters]);

  const { opened, toggle, close, mergedFilters, isDirty, patchPending, apply, reset, clearAndClose } =
    useStagedFilters({
      committed: committedFilters,
      onApply: handleApply,
      onClear: handleClear,
    });

  const filterLength = mergedFilters.type ? 1 : 0;

  const target = (
    <Indicator
      offset={4}
      label={isClient && filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      classNames={{ root: 'leading-none', indicator: 'leading-relaxed	' }}
      inline
    >
      <FilterButton {...buttonProps} icon={IconFilter} onClick={toggle} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  if (!isClient) return target;

  const dropdownBody = (
    <Stack gap="lg" p="md">
      <Stack gap="md">
        <Divider label="Type" classNames={{ label: 'font-bold text-sm' }} />
        <Chip.Group
          value={mergedFilters.type}
          onChange={(type) => patchPending({ type: type as ToolType })}
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
          classNames={{
            content: styles.content,
            header: styles.header,
            close: styles.close,
          }}
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
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon' | 'style'> & {
  query?: Partial<GetAllToolsSchema>;
  onChange?: (params: Partial<GetAllToolsSchema>) => void;
};
