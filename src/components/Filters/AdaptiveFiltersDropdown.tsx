import {
  Popover,
  Indicator,
  Button,
  Stack,
  Drawer,
  ScrollArea,
  Group,
  createStyles,
  ButtonProps,
} from '@mantine/core';
import { IconFilter, IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useIsClient } from '~/providers/IsClientProvider';
import { containerQuery } from '~/utils/mantine-css-helpers';

const useStyles = createStyles((theme) => ({
  label: {
    fontSize: 12,
    fontWeight: 600,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        // color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        backgroundColor: 'transparent',
      },
    },
  },
  opened: {
    transform: 'rotate(180deg)',
    transition: 'transform 200ms ease',
  },

  actionButton: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',
    },
  },

  indicatorRoot: { lineHeight: 1 },
  indicatorIndicator: { lineHeight: 1.6 },
}));

export function AdaptiveFiltersDropdown({
  children,
  count,
  className,
  dropdownProps,
  ...buttonProps
}: Props) {
  const { classes, theme, cx } = useStyles();
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
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
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
          classNames={{ drawer: dropdownProps?.className }}
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
      classNames={{ dropdown: '!w-full' }}
      withinPortal
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468}>
        <ScrollArea.Autosize
          classNames={{ root: dropdownProps?.className }}
          type="hover"
          maxHeight={'calc(90vh - var(--header-height) - 56px)'}
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
