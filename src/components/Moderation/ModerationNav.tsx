import { Menu } from '@mantine/core';
import { IconBadge } from '@tabler/icons-react';
import { useMemo } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';

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
        {
          label: 'Contests',
          href: '/moderator/contests',
        },
        {
          label: 'Generator Flagged',
          href: '/moderator/orchestrator/flagged',
          hidden: !features.csamReports,
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
    <Menu zIndex={imageGenerationDrawerZIndex + 1} withinPortal>
      <Menu.Target>
        <LegacyActionIcon color="yellow" variant="transparent">
          <IconBadge />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{menuItems}</Menu.Dropdown>
    </Menu>
  );
}
