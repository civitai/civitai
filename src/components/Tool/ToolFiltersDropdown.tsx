import {
  Button,
  ButtonProps,
  Chip,
  ChipProps,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  Stack,
  useMantineTheme,
} from '@mantine/core';
import { ToolType } from '~/shared/utils/prisma/enums';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { GetAllToolsSchema } from '~/server/schema/tool.schema';
import classes from './ToolFiltersDropdown.module.scss';
import cx from 'clsx';
import { useIsClient } from '~/providers/IsClientProvider';

const toolTypes = Object.keys(ToolType);

export function ToolFiltersDropdown({ query, onChange, ...buttonProps }: Props) {
  const theme = useMantineTheme();
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

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
    tt: 'capitalize',
  };

  const handleChange: Props['onChange'] = (value) => {
    onChange ? onChange(value) : setFilters(value);
  };

  const target = (
    <Indicator
      offset={4}
      label={isClient && filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      showZero={false}
      dot={false}
      classNames={{ root: 'leading-none', indicator: 'leading-relaxed	' }}
      inline
    >
      <Button
        className="@max-sm:w-full"
        color="gray"
        radius="xl"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        {...buttonProps}
        rightIcon={
          <IconChevronDown
            className={cx({ ['rotate-180 transition-transform']: opened })}
            size={16}
          />
        }
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
      >
        <Group spacing={4} noWrap>
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  if (!isClient) return target;

  const dropdown = (
    <Stack spacing="lg">
      <Stack spacing="md">
        <Divider label="Type" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={mergedFilters.type}
          onChange={(type: ToolType) => handleChange({ type })}
          my={4}
        >
          {toolTypes.map((tool, index) => (
            <Chip key={index} value={tool} {...chipProps}>
              <span>{tool}</span>
            </Chip>
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
          styles={{
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--mantine-header-height))',
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
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<GetAllToolsSchema>;
  onChange?: (params: Partial<GetAllToolsSchema>) => void;
};
