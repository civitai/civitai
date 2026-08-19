import { Menu } from '@mantine/core';
import { IconBadge, IconExternalLink } from '@tabler/icons-react';
import { useMemo } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { isMigratedModeratorHref } from '~/shared/constants/migrated-moderator-routes';

export function ModerationNav() {
  const features = useFeatureFlags();
  const menuItems = useMemo(
    () =>
      [
        { label: 'Strikes', href: '/moderator/strikes', hidden: !features.strikes },
        { label: 'Images', href: '/moderator/images' },
        { label: 'Image Tags', href: '/moderator/image-tags' },
        {
          label: 'Comics Review',
          href: '/moderator/comics-review',
          hidden: !features.comicCreator,
        },
        { label: 'Models', href: '/moderator/models' },
        { label: 'Training Models', href: '/moderator/training-models' },
        { label: 'Training Data Review', href: '/moderator/review/training-data' },
        // Migrated to the moderator app — the /moderator/* route redirects there (see the moderator
        // catchall page). Kept in nav during the transition.
        { label: 'Articles', href: '/moderator/articles' },
        // { label: 'Tags', href: '/moderator/tags' },
        {
          label: 'Service Status',
          href: '/moderator/service-status',
          hidden: !features.serviceStatus,
        },
        // { label: 'Withdrawal Requests', href: '/moderator/buzz-withdrawal-requests' },
        {
          label: 'Cash Management',
          href: '/moderator/cash-management',
          hidden: !features.cashManagement,
        },
        // { label: 'Rewards', href: '/moderator/rewards' },
        { label: 'Auditor', href: '/moderator/auditor' },
        // { label: 'Sanity Images', href: '/moderator/research/rater-sanity' },
        { label: 'Metadata Tester', href: '/testing/metadata-test' },
        { label: 'Ratings Review', href: '/moderator/image-rating-review' },
        // Migrated to the moderator app (redirects via the moderator catchall page).
        { label: 'Article Ratings Review', href: '/moderator/article-rating-review' },
        { label: 'Downleveled Review', href: '/moderator/downleveled-review' },
        { label: 'Ingestion Errors', href: '/moderator/ingestion-error-review' },
        { label: 'Minor Hash Matches', href: '/moderator/minor-hash-matches' },
        { label: 'Cosmetic Shop', href: '/moderator/cosmetic-store' },
        {
          label: 'Creator Shop Review',
          href: '/moderator/creator-shop',
          hidden: !features.creatorShop,
        },
        { label: 'Grant Cosmetics', href: '/moderator/cosmetics/grant' },
        // {
        //   label: 'Paddle Adjustments',
        //   href: '/moderator/paddle/adjustments',
        //   hidden: !features.paddleAdjustments,
        // },
        {
          label: 'Announcements',
          href: '/moderator/announcements',
          hidden: !features.announcements,
        },
        {
          label: 'Featured Collections',
          href: '/moderator/home-blocks/featured-collections',
        },
        {
          label: 'Rewards & Bonus Events',
          href: '/moderator/rewards-bonus-events',
        },
        {
          label: 'Code Gifts',
          href: '/moderator/code-gifts',
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
          label: 'Auctions',
          href: '/moderator/auctions',
          hidden: !features.auctionsMod,
        },
        {
          label: 'Generator Restrictions',
          href: '/moderator/generation-restrictions',
          hidden: !features.csamReports,
        },
        {
          label: 'Prompt Audit Test',
          href: '/moderator/prompt-audit-test',
          hidden: !features.csamReports,
        },
        {
          label: 'External CSAM Report',
          href: '/moderator/csam/external',
          hidden: !features.csamReports,
        },
        {
          label: 'Scanner Audit',
          href: '/moderator/scanner-audit',
        },
      ]
        .filter((i) => !i.hidden)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((link) => {
          // These no longer render here — the catchall bounces them to the moderator app. Marked from
          // the SAME map that does the bouncing, so a page migrating cannot leave the nav lying.
          const migrated = isMigratedModeratorHref(link.href);
          return (
            // Without break-inside-avoid an item can split across a column boundary,
            // putting its label in one column and its padding in the next.
            <Menu.Item
              key={link.href}
              component={Link}
              href={link.href}
              className="break-inside-avoid"
              color={migrated ? 'blue' : undefined}
              // Colour alone would carry this for nobody using a screen reader, and is easy to read as
              // decoration; the title says what the colour means.
              title={migrated ? 'Opens in the moderator app' : undefined}
              rightSection={
                migrated ? <IconExternalLink size={14} className="ml-2 opacity-70" /> : undefined
              }
            >
              {link.label}
            </Menu.Item>
          );
        }),
    [features]
  );

  return (
    <Menu zIndex={imageGenerationDrawerZIndex + 1} withinPortal>
      <Menu.Target>
        <LegacyActionIcon color="yellow" variant="transparent">
          <IconBadge />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown
        className="max-w-[calc(100vw-2rem)] columns-1 overflow-y-auto sm:columns-2 md:columns-3"
        style={{ maxHeight: 'calc(100dvh - 80px)' }}
      >
        {menuItems}
      </Menu.Dropdown>
    </Menu>
  );
}
