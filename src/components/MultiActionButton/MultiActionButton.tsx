import type { ButtonProps, MenuItemProps } from '@mantine/core';
import {
  Button,
  createPolymorphicComponent,
  Group,
  Menu,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
  alpha,
} from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { forwardRef } from 'react';

const _MultiActionButton = forwardRef<HTMLButtonElement, Props>(
  ({ children, menuItems, menuTooltip, variant = 'filled', ...props }, ref) => {
    const hasMenuItems = menuItems.length > 0;
    const theme = useMantineTheme();
    const colorScheme = useComputedColorScheme('dark');

    let menuButton = (
      <Button
        variant={variant}
        px={4}
        style={() => ({ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 })}
      >
        <IconChevronDown stroke={1.5} size={18} />
      </Button>
    );
    if (menuTooltip)
      menuButton = (
        <Tooltip label={menuTooltip} position="top" withArrow>
          {menuButton}
        </Tooltip>
      );

    const menu = hasMenuItems && (
      <Menu
        position="bottom-end"
        styles={{
          itemSection: { display: 'flex', marginLeft: theme.spacing.xs },
        }}
      >
        <Menu.Target>{menuButton}</Menu.Target>
        <Menu.Dropdown>{menuItems}</Menu.Dropdown>
      </Menu>
    );

    return (
      <Group gap={0} wrap="nowrap">
        <Button
          ref={ref}
          variant={variant}
          {...props}
          style={
            hasMenuItems
              ? {
                  borderTopRightRadius: 0,
                  borderBottomRightRadius: 0,
                  flexGrow: 1,
                  borderRight: `2px solid ${alpha(
                    colorScheme === 'dark' ? theme.colors.dark[9] : '#fff',
                    0.5
                  )}`,
                }
              : { flexGrow: 1 }
          }
        >
          {children}
        </Button>

        {menu}
      </Group>
    );
  }
);
_MultiActionButton.displayName = 'MultiActionButton';

type Props = ButtonProps & {
  menuItems: React.ReactElement<MenuItemProps>[];
  menuTooltip?: React.ReactNode;
};

export const MultiActionButton = createPolymorphicComponent<'button', Props>(_MultiActionButton);
