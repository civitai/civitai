import {
  Popover,
  Indicator,
  Button,
  Stack,
  Drawer,
  ScrollArea,
  Group,
  ButtonProps,
} from '@mantine/core';
import { IconFilter, IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useIsClient } from '~/providers/IsClientProvider';
import classes from './AdaptiveFiltersDropdown.module.scss';

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

  const target = (
    <Indicator
      offset={4}
      label={isClient && count ? count : undefined}
      size={16}
      zIndex={10}
      showZero={false}
      dot={false}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant="light"
        rightIcon={<IconChevronDown className={opened ? classes.opened : ''} size={16} />}
        {...buttonProps}
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

  const dropdown = <Stack spacing="lg">{children}</Stack>;

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
            drawer: classes.drawer,
            body: classes.drawerBody,
            header: classes.drawerHeader,
            closeButton: classes.closeButton,
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
      classNames={{ dropdown: classes.popoverDropdown }}
      withinPortal
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468}>
        <ScrollArea.Autosize
          classNames={{ root: `${dropdownProps?.className} ${classes.scrollArea}` }}
          type="hover"
          maxHeight="calc(90vh - var(--header-height) - 56px)"
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

