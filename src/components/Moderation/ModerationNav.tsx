import { ActionIcon, Menu } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconBadge } from '@tabler/icons-react';
import { useMemo } from 'react';
import { constants } from '~/server/common/constants';

export function ModerationNav() {
  const menuItems = useMemo(
    () =>
      [
        { label: 'Reports', href: '/moderator/reports' },
        { label: 'Images', href: '/moderator/images' },
        { label: 'Image Tags', href: '/moderator/image-tags' },
        { label: 'Models', href: '/moderator/models' },
        { label: 'Tags', href: '/moderator/tags' },
        { label: 'Generation', href: '/moderator/generation' },
        { label: 'Auditor', href: '/testing/auditor' },
        { label: 'Metadata Tester', href: '/testing/metadata-test' },
      ].map((link) => (
        <Menu.Item key={link.href} component={NextLink} href={link.href}>
          {link.label}
        </Menu.Item>
      )),
    []
  );

  return (
    <Menu zIndex={constants.imageGeneration.drawerZIndex + 1} withinPortal>
      <Menu.Target>
        <ActionIcon color="yellow" variant="transparent">
          <IconBadge />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{menuItems}</Menu.Dropdown>
    </Menu>
  );
}
