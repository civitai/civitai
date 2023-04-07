import { ActionIcon, Menu } from '@mantine/core';
import { IconBadge } from '@tabler/icons';
import Link from 'next/link';
import { useMemo } from 'react';

export function ModerationNav() {
  const menuItems = useMemo(
    () =>
      [
        { label: 'Reports', href: '/moderator/reports' },
        { label: 'Images', href: '/moderator/images' },
        { label: 'Image Tags', href: '/moderator/image-tags' },
        { label: 'Models', href: '/moderator/models' },
      ].map((link) => (
        <Menu.Item key={link.href} component={Link} href={link.href}>
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
