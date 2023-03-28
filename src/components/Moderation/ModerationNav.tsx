import { ActionIcon, Menu } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconBadge } from '@tabler/icons';
import { useMemo } from 'react';

export function ModerationNav() {
  const menuItems = useMemo(
    () =>
      [
        { label: 'Reports', href: '/moderator/reports' },
        { label: 'Images', href: '/moderator/images' },
        { label: 'Image Tags', href: '/moderator/image-tags' },
      ].map((link) => (
        <Menu.Item key={link.href} component={NextLink} href={link.href}>
          {link.label}
        </Menu.Item>
      )),
    []
  );

  return (
    <Menu>
      <Menu.Target>
        <ActionIcon color="yellow" variant="transparent">
          <IconBadge />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{menuItems}</Menu.Dropdown>
    </Menu>
  );
}
