import { useMantineTheme } from '@mantine/core';
import {
  IconBarbell,
  IconBookmark,
  IconBookmarkEdit,
  IconCloudLock,
  IconClubs,
  IconCrown,
  IconHistory,
  IconLink,
  IconMoneybag,
  IconPlayerPlayFilled,
  IconProgressBolt,
  IconUser,
  IconUserCircle,
  IconUsers,
  IconBrush,
  IconPhotoUp,
  IconUpload,
  IconVideoPlus,
  IconWriting,
  type Icon,
  type IconProps,
  IconThumbUp,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useSystemCollections } from '~/components/Collections/collection.utils';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LoginRedirectReason } from '~/utils/login-helpers';
import dynamic from 'next/dynamic';
import { trpc } from '~/utils/trpc';

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

  const {
    groupedCollections: {
      Article: bookmarkedArticlesCollection,
      Model: bookmarkedModelsCollection,
    },
  } = useSystemCollections();

  return [
    {
      visible: !!currentUser,
      items: [
        {
          href: `/user/${currentUser?.username}`,
          icon: IconUser,
          color: theme.colors.blue[theme.fn.primaryShade()],
          label: 'Your Profile',
        },
        {
          href: `/user/${currentUser?.username}/models?section=training`,
          visible: !!currentUser && features.imageTrainingResults,
          icon: IconBarbell,
          color: theme.colors.green[theme.fn.primaryShade()],
          label: 'Training',
        },
        {
          href: `/collections`,
          icon: IconBookmark,
          color: theme.colors.green[theme.fn.primaryShade()],
          label: 'My Collections',
        },
        {
          href: `/collections/${bookmarkedModelsCollection?.id}`,
          icon: IconThumbUp,
          color: theme.colors.green[theme.fn.primaryShade()],
          label: 'Liked models',
        },
        {
          href: `/collections/${bookmarkedArticlesCollection?.id}`,
          visible: !!bookmarkedArticlesCollection,
          icon: IconBookmarkEdit,
          color: theme.colors.pink[theme.fn.primaryShade()],
          label: 'Bookmarked articles',
        },
        {
          href: '/bounties?engagement=favorite',
          as: '/bounties',
          visible: features.bounties,
          icon: IconMoneybag,
          color: theme.colors.pink[theme.fn.primaryShade()],
          label: 'My bounties',
        },
        {
          href: '/clubs?engagement=engaged',
          as: '/clubs',
          visible: features.clubs,
          icon: IconClubs,
          color: theme.colors.pink[theme.fn.primaryShade()],
          label: 'My clubs',
        },
        {
          href: '/user/buzz-dashboard',
          visible: features.buzz,
          icon: IconProgressBolt,
          color: theme.colors.yellow[theme.fn.primaryShade()],
          label: 'Buzz dashboard',
        },
        {
          href: '/user/vault',
          visible: features.vault,
          icon: IconCloudLock,
          color: theme.colors.yellow[theme.fn.primaryShade()],
          label: 'My vault',
        },
      ],
    },
    {
      visible: !!currentUser,
      items: [
        {
          href: '/leaderboard/overall',
          icon: IconCrown,
          color: theme.colors.yellow[theme.fn.primaryShade()],
          label: 'Leaderboard',
        },
        {
          href: '/product/link',
          icon: IconLink,
          label: 'Download Link App',
        },
        {
          href: `/user/${currentUser?.username}/following`,
          icon: IconUsers,
          label: 'Creators you follow',
        },
        {
          href: '/user/downloads',
          icon: IconHistory,
          label: 'Download history',
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
          color: theme.colors.yellow[theme.fn.primaryShade()],
          label: 'Leaderboard',
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
  const isMuted = currentUser?.muted ?? false;

  return [
    {
      href: '/generate',
      visible: !isMuted,
      rel: 'nofollow',
      icon: IconBrush,
      color: theme.colors.blue[theme.fn.primaryShade()],
      label: 'Generate Images',
    },
    {
      href: '/posts/create',
      visible: !isMuted,
      redirectReason: 'post-images',
      rel: 'nofollow',
      icon: IconPhotoUp,
      color: theme.colors.blue[theme.fn.primaryShade()],
      label: 'Post images',
    },
    {
      href: '/posts/create?video=true',
      visible: !isMuted,
      redirectReason: 'post-images',
      rel: 'nofollow',
      icon: IconVideoPlus,
      color: theme.colors.blue[theme.fn.primaryShade()],
      label: 'Post videos',
    },
    {
      href: '/models/create',
      visible: !isMuted,
      redirectReason: 'upload-model',
      rel: 'nofollow',
      icon: IconUpload,
      color: theme.colors.blue[theme.fn.primaryShade()],
      label: ' Upload a model',
    },
    {
      href: '/models/train',
      visible: !isMuted && features.imageTraining,
      redirectReason: 'train-model',
      rel: 'nofollow',
      icon: IconBarbell,
      color: theme.colors.blue[theme.fn.primaryShade()],
      label: 'Train a LoRA',
      currency: true,
    },
    {
      href: '/articles/create',
      visible: !isMuted && features.articles,
      redirectReason: 'create-article',
      rel: 'nofollow',
      icon: IconWriting,
      color: theme.colors.blue[theme.fn.primaryShade()],
      label: 'Write an article',
    },
    {
      href: '/bounties/create',
      visible: !isMuted && features.bounties,
      redirectReason: 'create-bounty',
      rel: 'nofollow',
      icon: IconMoneybag,
      color: theme.colors.blue[theme.fn.primaryShade()],
      label: 'Create a bounty',
      currency: true,
    },
    {
      href: '/clubs/create',
      visible: !isMuted && features.clubs,
      redirectReason: 'create-club',
      rel: 'nofollow',
      icon: IconClubs,
      color: theme.colors.blue[theme.fn.primaryShade()],
      label: 'Create a club',
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
