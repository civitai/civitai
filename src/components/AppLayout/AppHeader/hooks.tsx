import { useMantineTheme, getPrimaryShade, useComputedColorScheme } from '@mantine/core';
import {
  type Icon,
  type IconProps,
  IconBarbell,
  IconBook,
  IconBookmark,
  IconBookmarkEdit,
  IconBrush,
  IconChartHistogram,
  IconCloudLock,
  IconCube,
  IconCrown,
  IconGift,
  IconGavel,
  IconHistory,
  IconLink,
  IconMoneybag,
  IconPhotoUp,
  IconPlayerPlayFilled,
  IconPlugConnected,
  IconProgressBolt,
  IconSword,
  IconShoppingBag,
  IconSticker,
  IconThumbUp,
  IconTrophy,
  IconUpload,
  IconUser,
  IconUserCircle,
  IconUsers,
  IconVideoPlus,
  IconWriting,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { appsNavVisibility } from '~/components/AppLayout/AppHeader/appsNavVisibility';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import { PLACEMENT_QUEUE_URL } from '~/components/Placement/queue-routes';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { OnboardingSteps } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';
import type { LoginRedirectReason } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';
import type { CollectionType } from '~/shared/utils/prisma/enums';
import { useMemo } from 'react';

export type UserMenuItem = {
  label: string;
  icon: React.ForwardRefExoticComponent<IconProps & React.RefAttributes<Icon>>;
  color?: string;
  visible?: boolean;
  href?: string;
  as?: string;
  rel?: 'nofollow';
  onClick?: () => void;
  currency?: boolean;
  redirectReason?: LoginRedirectReason;
  newUntil?: Date;
  /**
   * A count rendered as a filled badge after the label. Zero and undefined both
   * render nothing — a badge that says "0" reads as a broken badge, not as an
   * empty queue.
   *
   * Anything supplying this must come from a query the header already makes.
   * The menu mounts on every page for every signed-in user, so a number here
   * that costs a request is a request on every page.
   */
  badge?: number;
};

type UserMenuItemGroup = {
  visible?: boolean;
  items: UserMenuItem[];
};

const FeatureIntroductionModal = dynamic(
  () => import('~/components/FeatureIntroduction/FeatureIntroduction')
);

export function useGetMenuItems(): UserMenuItemGroup[] {
  const router = useRouter();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const {
    groupedCollections: {
      Article: bookmarkedArticlesCollection,
      Model: bookmarkedModelsCollection,
    },
  } = useSystemCollections();

  // App Blocks nav entries: public get-started vs mod-only marketplace. Pure
  // helper (unit-tested in appsNavVisibility.test.ts) is the source of truth.
  const appsNav = appsNavVisibility(features);

  // Already in flight for the notification bell — one request per session,
  // `staleTime: Infinity`. Reading it here adds no round trip.
  const { pendingPlacements } = useQueryNotificationsCount();

  return [
    {
      visible: !!currentUser,
      items: [
        {
          href: `/user/${currentUser?.username as string}`,
          icon: IconUser,
          color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Your Profile',
        },
        {
          href: `/user/${currentUser?.username as string}/shop`,
          // Only Creator Program members qualify to run a shop.
          visible:
            features.creatorShop &&
            Flags.hasFlag(currentUser?.onboarding ?? 0, OnboardingSteps.CreatorProgram),
          icon: IconShoppingBag,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'My Shop',
        },
        {
          // The creator's own review queues — stickers AND remixes, one page.
          // Their only other routes are four levels deep in account settings
          // and the approve/decline drawn on a single image, so a creator with
          // anything waiting had nowhere to go and find it — which is most of
          // why 96 placements sat pending against 251 approved while the
          // feature was selling. The count is both surfaces, because the entry
          // now points at both.
          href: PLACEMENT_QUEUE_URL,
          // `stickerPlacement` gates PLACING a sticker, not receiving one, and
          // the page itself asks only for a signed-in unbanned user. Gating the
          // entry on the flag alone would hide it from exactly the owners
          // holding a queue — someone with the flag placed on their image, they
          // never had it. So: the flag, or a queue that is actually waiting.
          visible: !!currentUser && (features.stickerPlacement || pendingPlacements > 0),
          icon: IconSticker,
          color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Placements',
          badge: pendingPlacements,
          newUntil: new Date('2026-09-20'),
        },
        {
          href: `/user/${currentUser?.username as string}/models?section=training`,
          visible: !!currentUser && features.imageTrainingResults,
          icon: IconBarbell,
          color: theme.colors.green[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Training',
        },
        {
          href: `/collections`,
          icon: IconBookmark,
          color: theme.colors.green[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'My Collections',
        },
        {
          href: `/collections/${bookmarkedModelsCollection?.id}`,
          icon: IconThumbUp,
          color: theme.colors.green[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Liked Models',
        },
        {
          href: `/collections/${bookmarkedArticlesCollection?.id}`,
          visible: !!bookmarkedArticlesCollection,
          icon: IconBookmarkEdit,
          color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Bookmarked Articles',
        },
        {
          href: '/bounties?engagement=favorite',
          as: '/bounties',
          visible: features.bounties,
          icon: IconMoneybag,
          color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'My Bounties',
        },
        {
          href: '/challenges?engagement=created',
          visible: features.challengePlatform && features.userChallenges,
          icon: IconTrophy,
          color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Your Challenges',
          newUntil: new Date('2026-08-15'),
        },
        {
          href: '/user/buzz-dashboard',
          visible: features.buzz,
          icon: IconProgressBolt,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Buzz Dashboard',
        },
        {
          // The Creator Studio spoke (creator-studio.civitai.com) — earnings/analytics + per-version
          // licensing-fee and paid-access management. Shared session, so a plain cross-subdomain link.
          href: 'https://creator-studio.civitai.com',
          visible: !!currentUser,
          icon: IconChartHistogram,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Creator Studio',
          newUntil: new Date('2026-09-01'),
        },
        {
          href: '/user/vault',
          visible: features.vault,
          icon: IconCloudLock,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'My Vault',
        },
        {
          href: '/user/referrals',
          visible: features.referralProgramV2,
          icon: IconGift,
          color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Referrals',
          newUntil: new Date('2026-07-20'),
        },
        {
          // 🔴 ONE `/apps*` DROPDOWN ENTRY, TWO DESTINATIONS. This used to be two
          // adjacent entries — "Build apps" → `/apps/get-started` and "Apps" →
          // `/apps` — which meant a moderator (who holds both flags) saw two
          // near-identical rows for one product. "Build apps" now lives in the
          // shared `/apps/*` sub-nav (`SUB_NAV_LINKS` in `~/components/Apps/
          // AppsSubNav`) instead, so the dropdown carries a single door.
          //
          // WHICH door depends on what the viewer is entitled to, and the fallback
          // is NOT cosmetic:
          //   • store access (`appsNav.marketplace` = `hasAppsStoreAccess`) → `/apps`.
          //     The marketplace is the richer landing, and "Build apps" is one click
          //     away in the sub-nav.
          //   • get-started ONLY (`appsNav.getStarted`) → `/apps/get-started`.
          //     Such a viewer CANNOT load `/apps` at all: its `getServerSideProps`
          //     gates on `resolveAppsPageAccess`, which returns `notFound` without a
          //     store flag. Sending them to `/apps` would be a menu entry into a 404,
          //     so they land directly on the one page they are entitled to.
          //
          // Both booleans still come from the pure `appsNavVisibility` helper
          // (unit-tested), and `marketplace` still routes through the shared
          // `hasAppsStoreAccess` predicate (#3907) — gating it on `appBlocks` alone
          // hid the store from the catalog-only and external-only cohorts.
          //
          // 🔴 THE LABEL AND ICON DO *NOT* FOLLOW THE HREF, AND THAT IS A DECISION,
          // NOT AN OVERSIGHT. On the get-started-only branch this row reads "Apps"
          // with a plug glyph while navigating to developer onboarding. Accepted,
          // for three reasons: (1) "Apps" names the PRODUCT AREA, which both
          // destinations are inside — the row is a door into `/apps*`, not a
          // description of the landing page; (2) branching the label AND the icon
          // (`IconPlugConnected` vs the sub-nav's `IconCode`) re-splits one row into
          // two presentations, which is the duplication this consolidation removed;
          // (3) the cohort is EMPTY today — `appBlocksGetStarted` is
          // `availability: ['mod']` and every moderator holds a store flag, so no
          // real viewer takes this branch. RE-DECIDE IT when that stops being true:
          // the trigger is `app-blocks-get-started` being widened past `['mod']`
          // (in Flipt, or in `feature-flags.service.ts`). Until then a conditional
          // label would be untestable-in-production copy.
          href: appsNav.marketplace ? '/apps' : '/apps/get-started',
          visible: appsNav.marketplace || appsNav.getStarted,
          icon: IconPlugConnected,
          color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Apps',
          newUntil: new Date('2026-07-01'),
        },
      ],
    },
    {
      visible: !!currentUser,
      items: [
        {
          href: '/leaderboard/overall',
          icon: IconCrown,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Leaderboard',
        },
        {
          href: '/auctions',
          visible: features.auctions,
          icon: IconGavel,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Auctions',
          newUntil: new Date('2025-04-07'),
        },
        {
          href: '/games/knights-of-new-order',
          visible: features.newOrderGame,
          icon: IconSword,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Knights of New',
          newUntil: new Date('2025-06-15'),
        },
        {
          href: '/product/link',
          icon: IconLink,
          label: 'Download Link App',
        },
        {
          href: `/user/${currentUser?.username as string}/following`,
          icon: IconUsers,
          label: 'Creators You Follow',
        },
        {
          href: '/user/downloads',
          icon: IconHistory,
          label: 'Download History',
        },
        {
          icon: IconPlayerPlayFilled,
          label: 'Getting Started',
          onClick: () => {
            dialogStore.trigger({
              component: FeatureIntroductionModal,
              props: {
                feature: 'getting-started',
                contentSlug: ['feature-introduction', 'welcome'],
              },
            });
          },
        },
      ],
    },
    {
      visible: !currentUser,
      items: [
        {
          href: '/leaderboard/overall',
          icon: IconCrown,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Leaderboard',
        },
        {
          href: '/auctions',
          visible: features.auctions,
          icon: IconGavel,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Auctions',
          newUntil: new Date('2025-04-07'),
        },
        {
          href: '/product/link',
          icon: IconLink,
          label: 'Download Link App',
        },
        {
          href: `/login?returnUrl=${router.asPath}`,
          rel: 'nofollow',
          icon: IconUserCircle,
          label: 'Sign In/Sign up',
        },
      ],
    },
  ];
}

export function useGetActionMenuItems(): Array<Omit<UserMenuItem, 'href'> & { href: string }> {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const isMuted = currentUser?.muted ?? false;
  const canCreate = features.canWrite;

  return [
    {
      href: '/generate',
      visible: !isMuted,
      rel: 'nofollow',
      icon: IconBrush,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Generate',
    },
    {
      href: '/posts/create',
      visible: !isMuted && canCreate,
      redirectReason: 'post-images',
      rel: 'nofollow',
      icon: IconPhotoUp,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Post Images',
    },
    {
      href: '/posts/create?video=true',
      visible: !isMuted && canCreate,
      redirectReason: 'post-images',
      rel: 'nofollow',
      icon: IconVideoPlus,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Post Videos',
    },
    {
      href: '/models/create',
      visible: !isMuted && canCreate,
      redirectReason: 'upload-model',
      rel: 'nofollow',
      icon: IconUpload,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: ' Upload a Model',
    },
    {
      // Opens the generation panel with the 3D Model tab selected. The
      // Model3D generator surface is gated separately by `model3dGenerator`.
      href: '/generate?type=model3d',
      visible: !isMuted && features.model3dGenerator,
      rel: 'nofollow',
      icon: IconCube,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Generate 3D Model',
    },
    {
      href: '/models/train',
      visible: !isMuted && features.imageTraining,
      redirectReason: 'train-model',
      rel: 'nofollow',
      icon: IconBarbell,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Train a LoRA',
      currency: true,
    },
    {
      href: '/articles/create',
      visible: !isMuted && canCreate && features.articles,
      redirectReason: 'create-article',
      rel: 'nofollow',
      icon: IconWriting,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Write an Article',
    },
    {
      href: '/comics/create',
      visible: !isMuted && canCreate && features.comicCreator,
      redirectReason: 'post-images',
      rel: 'nofollow',
      icon: IconBook,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Create a Comic',
    },
    {
      href: '/bounties/create',
      visible: !isMuted && canCreate && features.bounties,
      redirectReason: 'create-bounty',
      rel: 'nofollow',
      icon: IconMoneybag,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Create a Bounty',
      currency: true,
    },
    {
      href: '/challenges/create',
      visible: !isMuted && canCreate && features.challengePlatform && features.userChallenges,
      redirectReason: 'create-challenge',
      rel: 'nofollow',
      icon: IconTrophy,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Create a Challenge',
      newUntil: new Date('2026-08-15'),
    },
  ];
}

export function useGetCreator() {
  const currentUser = useCurrentUser();
  const { data: creator } = trpc.user.getCreator.useQuery(
    { id: currentUser?.id as number },
    { enabled: !!currentUser }
  );
  return creator;
}

function useSystemCollections() {
  const currentUser = useCurrentUser();
  const { data: systemCollections = [], ...other } = trpc.user.getBookmarkCollections.useQuery(
    undefined,
    { enabled: !!currentUser }
  );

  const groupedCollections = useMemo(() => {
    const grouped = systemCollections.reduce((acc, collection) => {
      if (collection.type) acc[collection.type] = collection;
      return acc;
    }, {} as Record<CollectionType, (typeof systemCollections)[number]>);

    return grouped;
  }, [systemCollections]);

  return {
    ...other,
    systemCollections,
    groupedCollections,
  };
}
