import {
  Button,
  ButtonProps,
  createPolymorphicComponent,
  Group,
  Menu,
  MenuItemProps,
} from '@mantine/core';
import { IconChevronDown } from '@tabler/icons';
import { forwardRef } from 'react';

const _MultiActionButton = forwardRef<HTMLButtonElement, Props>(
  ({ children, menuItems, variant = 'filled', ...props }, ref) => {
    const hasMenuItems = menuItems.length > 0;

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
                    theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[0],
                    0.5
                  )}`,
                }
              : { flexGrow: 1 }
          }
        >
          {children}
        </Button>

        {hasMenuItems ? (
          <Menu position="bottom-end">
            <Menu.Target>
              <Button
                variant={variant}
                px={4}
                sx={() => ({ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 })}
              >
                <IconChevronDown stroke={1.5} size={18} />
              </Button>
            </Menu.Target>
            <Menu.Dropdown>{menuItems}</Menu.Dropdown>
          </Menu>
        ) : null}
      </Group>
    );
  }
);
_MultiActionButton.displayName = 'MultiActionButton';

type Props = ButtonProps & {
  menuItems: React.ReactElement<MenuItemProps>[];
};

export const MultiActionButton = createPolymorphicComponent<'button', Props>(_MultiActionButton);
