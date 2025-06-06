import type { ButtonProps } from '@mantine/core';
import {
  Popover,
  Indicator,
  Button,
  Stack,
  Drawer,
  ScrollArea,
  Group,
  useComputedColorScheme,
} from '@mantine/core';
import { IconFilter, IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useIsClient } from '~/providers/IsClientProvider';
import classes from './AdaptiveFiltersDropdown.module.scss';
import clsx from 'clsx';

export function AdaptiveFiltersDropdown({
  children,
  count,
  className,
  dropdownProps,
  ...buttonProps
}: Props) {
  const mobile = useIsMobile();
  const isClient = useIsClient();
  const [opened, setOpened] = useState(false);
  const colorScheme = useComputedColorScheme('dark');

  const target = (
    <Indicator
      offset={4}
      label={isClient && count ? count : undefined}
      size={16}
      zIndex={10}
      disabled={!count}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        rightSection={<IconChevronDown className={clsx({ [classes.opened]: opened })} size={16} />}
        {...buttonProps}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
      >
        <Group gap={4} wrap="nowrap">
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = <Stack gap="lg">{children}</Stack>;

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          size="90%"
          position="bottom"
          classNames={{ root: dropdownProps?.className }}
          styles={{
            content: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              overflowY: 'auto',
            },
            body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
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
      classNames={{ dropdown: '!w-full' }}
      withinPortal
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468}>
        <ScrollArea.Autosize
          classNames={{ root: dropdownProps?.className }}
          type="hover"
          mah={'calc(90vh - var(--header-height) - 56px)'}
        >
          {dropdown}
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  children: React.ReactElement;
  count?: number;
  dropdownProps?: { className?: string };
};
