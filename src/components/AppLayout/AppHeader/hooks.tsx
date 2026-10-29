// narrowed-path proof (throwaway)
import { useMantineTheme, getPrimaryShade, useComputedColorScheme } from '@mantine/core';
import {
  type Icon,
  type IconProps,
  IconBackpack,
  IconBarbell,
  IconBook,
  IconBookmark,
  IconBookmarkEdit,
  IconBriefcase,
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
  IconStairsUp,
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
import { myShopNavVisible } from '~/components/AppLayout/AppHeader/myShopNavVisibility';
import { appsNavVisibility } from '~/components/AppLayout/AppHeader/appsNavVisibility';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useEventMenuItems } from '~/components/AppLayout/AppHeader/useEventMenuItems';
import { enabledInventoryTypes } from '~/components/Inventory/inventory-types';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import { PLACEMENT_QUEUE_URL } from '~/components/Placement/queue-routes';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import type { UserMenuItemId } from '~/shared/constants/user-menu.constants';
import type { LoginRedirectReason } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';
import type { CollectionType } from '~/shared/utils/prisma/enums';
import { useMemo } from 'react';

export type UserMenuItem = {
  /** Set on items the drill-in menu can place and pin; see `USER_MENU_ITEM_IDS`. */
  id?: UserMenuItemId;
  label: string;
  icon: React.ForwardRefExoticComponent<IconProps & React.RefAttributes<Icon>>;
  color?: string;
  visible?: boolean;
  href?: string;
  as?: string;
  rel?: 'nofollow';
  onClick?: () => void;
  /** Opens `href` in a new tab. */
  external?: boolean;
  currency?: boolean;
  redirectReason?: LoginRedirectReason;
  newUntil?: Date;
  isNew?: boolean;
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
  /** What the badge counts, shown on hover. */
  badgeTooltip?: string;
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

  // App Blocks nav entry: is the /apps store visible to this viewer. Pure helper
  // (unit-tested in appsNavVisibility.test.ts) is the source of truth.
  const appsNav = appsNavVisibility(features);

  // Already in flight for the notification bell — one request per session,
  // `staleTime: Infinity`. Reading it here adds no round trip.
  const { pendingPlacements, pendingCollectionReviews, unopenedBoxes } =
    useQueryNotificationsCount();

  const eventItems = useEventMenuItems(
    theme.colors.grape[getPrimaryShade(theme, colorScheme ?? 'dark')]
  );

  return [
    {
      visible: !!currentUser,
      items: [
        {
          id: 'profile',
          href: `/user/${currentUser?.username as string}`,
          icon: IconUser,
          color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Your Profile',
        },
        // Stays after the event's strip is dismissed: the way back to the event.
        ...eventItems,
        {
          id: 'inventory',
          href: '/user/inventory',
          visible: enabledInventoryTypes(features).length > 0,
          icon: IconBackpack,
          color: theme.colors.grape[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Inventory',
          badge: unopenedBoxes,
          badgeTooltip: 'Unopened mystery boxes',
        },
        {
          id: 'my-shop',
          href: `/user/${currentUser?.username as string}/shop`,
          // Same rule as the shop itself (`creatorShopProcedure`): the `creatorShop` flag.
          visible: myShopNavVisible(features),
          icon: IconShoppingBag,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Shop',
        },
        {
          id: 'service-requests',
          // The buyer's list of what they've requested; a seller's incoming ones are on the shop's
          // manage page.
          href: '/services/deals',
          visible: !!currentUser && features.creatorServices,
          icon: IconBriefcase,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Service Requests',
        },
        {
          id: 'placements',
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
          badgeTooltip: 'Placements waiting for your review',
          newUntil: new Date('2026-09-20'),
        },
        {
          id: 'training',
          // With the Training Studio on, "my trainings" IS the studio's run list.
          href: features.trainingStudioUi
            ? '/training-studio'
            : `/user/${currentUser?.username as string}/models?section=training`,
          visible: !!currentUser && features.imageTrainingResults,
          icon: IconBarbell,
          color: theme.colors.green[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Training',
        },
        {
          id: 'collections',
          href: `/collections`,
          icon: IconBookmark,
          color: theme.colors.green[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Collections',
          badge: pendingCollectionReviews,
          badgeTooltip: 'Items awaiting review in your collections',
        },
        {
          id: 'liked-models',
          href: `/collections/${bookmarkedModelsCollection?.id}`,
          icon: IconThumbUp,
          color: theme.colors.green[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Liked Models',
        },
        {
          id: 'bookmarked-articles',
          href: `/collections/${bookmarkedArticlesCollection?.id}`,
          visible: !!bookmarkedArticlesCollection,
          icon: IconBookmarkEdit,
          color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Bookmarked Articles',
        },
        {
          id: 'bounties',
          href: '/bounties?engagement=favorite',
          visible: features.bounties,
          icon: IconMoneybag,
          color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Bounties',
        },
        {
          id: 'challenges',
          href: '/challenges?engagement=created',
          visible: features.challengePlatform && features.userChallenges,
          icon: IconTrophy,
          color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Challenges',
          newUntil: new Date('2026-08-15'),
        },
        {
          id: 'buzz-dashboard',
          href: '/user/buzz-dashboard',
          visible: features.buzz,
          icon: IconProgressBolt,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Buzz Dashboard',
        },
        {
          id: 'creator-studio',
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
          id: 'creator-journey',
          href: CREATOR_JOURNEY_HREF,
          visible: !!currentUser && features.creatorJourney,
          icon: IconStairsUp,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Creator Journey',
          newUntil: new Date('2026-11-15'),
        },
        {
          id: 'vault',
          href: '/user/vault',
          visible: features.vault,
          icon: IconCloudLock,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Vault',
        },
        {
          id: 'referrals',
          href: '/user/referrals',
          visible: features.referralProgramV2,
          icon: IconGift,
          color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Referrals',
          newUntil: new Date('2026-07-20'),
        },
        {
          id: 'apps',
          // 🔴 ONE `/apps*` DROPDOWN ENTRY, ONE DESTINATION. This was two entries
          // ("Build apps" → `/apps/get-started` and "Apps" → `/apps`), then one entry
          // with a CONDITIONAL href that fell back to `/apps/get-started` for a viewer
          // who held that flag but no store flag — because such a viewer cannot load
          // `/apps` at all (`resolveAppsPageAccess` → `notFound`) and sending them there
          // would be a menu entry into a 404.
          //
          // 🔴 THE FALLBACK IS GONE BECAUSE ITS DESTINATION IS, AND THE REPLACEMENT WOULD
          // 404 FOR THE SAME COHORT. `/apps/get-started` merged into `/apps/build`, whose
          // gate (`canAccessAppsBuild`) requires `hasAppsStoreAccess` — so repointing the
          // fallback would have recreated, on the very same line, exactly the
          // menu-entry-into-a-404 defect the fallback was written to avoid. A
          // get-started-only viewer now has NO `/apps/*` surface at all, so the honest
          // menu for them is no entry, which is what `visible` says.
          //
          // That also retires the "the label and icon do not follow the href" note this
          // block used to carry: there is one destination now, so "Apps" with
          // `IconPlugConnected` names it exactly.
          //
          // `marketplace` still routes through the shared `hasAppsStoreAccess` predicate
          // (#3907) — gating it on `appBlocks` alone hid the store from the catalog-only
          // and external-only cohorts, and this entry is the ONLY in-product route to
          // `/apps` (the sub-nav's Marketplace tab renders only once you are already on
          // an `/apps/*` route).
          href: '/apps',
          visible: appsNav.marketplace,
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
          id: 'leaderboard',
          href: '/leaderboard/overall',
          icon: IconCrown,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Leaderboard',
        },
        {
          id: 'auctions',
          href: '/auctions',
          visible: features.auctions,
          icon: IconGavel,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Auctions',
          newUntil: new Date('2025-04-07'),
        },
        {
          id: 'knights-of-new',
          href: '/games/knights-of-new-order',
          visible: features.newOrderGame,
          icon: IconSword,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Knights of New',
          newUntil: new Date('2025-06-15'),
        },
        {
          id: 'link-app',
          href: '/product/link',
          icon: IconLink,
          label: 'Download Link App',
        },
        {
          id: 'following',
          href: `/user/${currentUser?.username as string}/following`,
          icon: IconUsers,
          label: 'Creators You Follow',
        },
        {
          id: 'downloads',
          href: '/user/downloads',
          icon: IconHistory,
          label: 'Download History',
        },
        {
          id: 'getting-started',
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
        ...eventItems,
        {
          id: 'leaderboard',
          href: '/leaderboard/overall',
          icon: IconCrown,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Leaderboard',
        },
        {
          id: 'auctions',
          href: '/auctions',
          visible: features.auctions,
          icon: IconGavel,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Auctions',
          newUntil: new Date('2025-04-07'),
        },
        {
          id: 'link-app',
          href: '/product/link',
          icon: IconLink,
          label: 'Download Link App',
        },
        {
          id: 'sign-in',
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
      id: 'create-generate',
      href: '/generate',
      visible: !isMuted,
      rel: 'nofollow',
      icon: IconBrush,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Generate',
    },
    {
      id: 'create-post-images',
      href: '/posts/create',
      visible: !isMuted && canCreate,
      redirectReason: 'post-images',
      rel: 'nofollow',
      icon: IconPhotoUp,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Post Images',
    },
    {
      id: 'create-post-videos',
      href: '/posts/create?video=true',
      visible: !isMuted && canCreate,
      redirectReason: 'post-images',
      rel: 'nofollow',
      icon: IconVideoPlus,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Post Videos',
    },
    {
      id: 'create-model',
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
      id: 'create-model3d',
      href: '/generate?type=model3d',
      visible: !isMuted && features.model3dGenerator,
      rel: 'nofollow',
      icon: IconCube,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Generate 3D Model',
    },
    {
      // The user-toggleable trainingStudioUi flag swaps the trainer entry for the new Training
      // Studio; the old wizard stays reachable by toggling it back off.
      id: 'create-train',
      href: features.trainingStudioUi ? '/training-studio' : '/models/train',
      visible: !isMuted && features.imageTraining,
      redirectReason: 'train-model',
      rel: 'nofollow',
      icon: IconBarbell,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Train a LoRA',
      currency: true,
    },
    {
      id: 'create-article',
      href: '/articles/create',
      visible: !isMuted && canCreate && features.articles,
      redirectReason: 'create-article',
      rel: 'nofollow',
      icon: IconWriting,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Write an Article',
    },
    {
      id: 'create-comic',
      href: '/comics/create',
      visible: !isMuted && canCreate && features.comicCreator,
      redirectReason: 'post-images',
      rel: 'nofollow',
      icon: IconBook,
      color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
      label: 'Create a Comic',
    },
    {
      id: 'create-bounty',
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
      id: 'create-challenge',
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
