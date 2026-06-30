import { useMantineTheme, getPrimaryShade, useComputedColorScheme } from '@mantine/core';
import {
  type Icon,
  type IconProps,
  IconBarbell,
  IconBook,
  IconBookmark,
  IconBookmarkEdit,
  IconBrush,
  IconCloudLock,
  IconCode,
  IconCube,
  // IconClubs,
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
  IconThumbUp,
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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
        // {
        //   href: '/clubs?engagement=engaged',
        //   as: '/clubs',
        //   visible: features.clubs,
        //   icon: IconClubs,
        //   color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
        //   label: 'My Clubs',
        // },
        {
          href: '/user/buzz-dashboard',
          visible: features.buzz,
          icon: IconProgressBolt,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Buzz Dashboard',
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
          // PUBLIC "App builders" get-started landing page (Scope A soft launch).
          // Gated on the separate public `appBlocksGetStarted` flag (kill switch),
          // NOT the mod-only `appBlocks` gate — this is the only `/apps/*` surface
          // visible to non-mods. Distinct label ("Build apps") from the mod-only
          // marketplace entry below so a moderator never sees two identical labels.
          // Visibility comes from the pure `appsNavVisibility` helper (unit-tested).
          href: '/apps/get-started',
          visible: appsNav.getStarted,
          icon: IconCode,
          color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Build apps',
          newUntil: new Date('2026-08-01'),
        },
        {
          // Mod-only App Blocks marketplace + in-page AppsSubNav hub (installed,
          // submit, my-submissions, revenue, review). Stays gated on `appBlocks`
          // (mod-only today). Relabeled "Apps Marketplace" so it reads distinctly
          // from the public "Build apps" entry above.
          href: '/apps',
          visible: appsNav.marketplace,
          icon: IconPlugConnected,
          color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'Apps Marketplace',
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
    // {
    //   href: '/clubs/create',
    //   visible: !isMuted && canCreate && features.clubs,
    //   redirectReason: 'create-club',
    //   rel: 'nofollow',
    //   icon: IconClubs,
    //   color: theme.colors.blue[getPrimaryShade(theme, colorScheme ?? 'dark')],
    //   label: 'Create a Club',
    // },
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
