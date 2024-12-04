import { ActionIcon, Menu } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconBadge } from '@tabler/icons-react';
import { useMemo } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';

export function ModerationNav() {
  const features = useFeatureFlags();
  const menuItems = useMemo(
    () =>
      [
        { label: 'Reports', href: '/moderator/reports' },
        { label: 'Images', href: '/moderator/images' },
        { label: 'Image Tags', href: '/moderator/image-tags' },
        { label: 'Models', href: '/moderator/models' },
        { label: 'Tags', href: '/moderator/tags' },
        { label: 'Generation', href: '/moderator/generation' },
        { label: 'Withdrawal Requests', href: '/moderator/buzz-withdrawal-requests' },
        { label: 'Rewards', href: '/moderator/rewards' },
        { label: 'Auditor', href: '/moderator/auditor' },
        { label: 'Rater', href: '/research/rater' },
        { label: 'Sanity Images', href: '/moderator/research/rater-sanity' },
        { label: 'Metadata Tester', href: '/testing/metadata-test' },
        { label: 'Ratings Review', href: '/moderator/image-rating-review' },
        { label: 'Cosmetic Shop', href: '/moderator/cosmetic-store' },
        {
          label: 'Paddle Adjustments',
          href: '/moderator/paddle/adjustments',
          hidden: !features.paddleAdjustments,
        },
        {
          label: 'Announcements',
          href: '/moderator/announcements',
          hidden: !features.announcements,
        },
        {
          label: 'Blocklists',
          href: '/moderator/blocklists',
          hidden: !features.blocklists,
        },
      ]
        .filter((i) => !i.hidden)
        .map((link) => (
          <Menu.Item key={link.href} component={Link} href={link.href}>
            {link.label}
          </Menu.Item>
        )),
    [features]
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
