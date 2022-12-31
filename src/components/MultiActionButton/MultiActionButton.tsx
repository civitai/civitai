import {
  Button,
  ButtonProps,
  createPolymorphicComponent,
  Group,
  Menu,
  MenuItemProps,
  Tooltip,
} from '@mantine/core';
import { IconChevronDown } from '@tabler/icons';
import { forwardRef } from 'react';

const _MultiActionButton = forwardRef<HTMLButtonElement, Props>(
  ({ children, menuItems, menuTooltip, variant = 'filled', ...props }, ref) => {
    const hasMenuItems = menuItems.length > 0;

    let menuButton = (
      <Button
        variant={variant}
        px={4}
        sx={() => ({ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 })}
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
      <Menu position="bottom-end">
        <Menu.Target>{menuButton}</Menu.Target>
        <Menu.Dropdown>{menuItems}</Menu.Dropdown>
      </Menu>
    );

    return (
      <Group spacing={0} noWrap>
        <Button
          ref={ref}
          variant={variant}
          {...props}
          sx={(theme) =>
            hasMenuItems
              ? {
                  borderTopRightRadius: 0,
                  borderBottomRightRadius: 0,
                  flexGrow: 1,
                  borderRight: `2px solid ${theme.fn.rgba(
                    theme.colorScheme === 'dark' ? theme.colors.dark[9] : '#fff',
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
