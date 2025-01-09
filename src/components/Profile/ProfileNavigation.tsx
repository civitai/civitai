import React from 'react';
import {
  IconAssembly,
  IconCategory,
  IconLayoutList,
  IconPencilMinus,
  IconPhoto,
  IconBookmark,
} from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import {
  DataItem,
  HomeStyleSegmentedControl,
} from '~/components/HomeContentToggle/HomeStyleSegmentedControl';
import { IconVideo } from '@tabler/icons-react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type ProfileNavigationProps = {
  username: string;
};

const overviewPath = '[username]';

export const ProfileNavigation = ({ username }: ProfileNavigationProps) => {
  const router = useRouter();
  const { articles, canViewNsfw } = useFeatureFlags();

  const {
    data: userOverview,
    isInitialLoading,
    isRefetching,
  } = trpc.userProfile.overview.useQuery({ username }, { enabled: canViewNsfw });
  const { data: user } = trpc.userProfile.get.useQuery({ username });

  const activePath = router.pathname.split('/').pop() || overviewPath;
  const baseUrl = `/user/${username}`;

  const opts: Record<string, DataItem> = {
    [overviewPath]: {
      url: `${baseUrl}/`,
      icon: (props) => <IconAssembly {...props} />,
      label: 'Overview',
    },
    models: {
      url: `${baseUrl}/models`,
      icon: (props) => <IconCategory {...props} />,
      count: userOverview?.modelCount ?? 0,
      disabled: !!user?.bannedAt,
    },
    posts: {
      url: `${baseUrl}/posts`,
      icon: (props) => <IconLayoutList {...props} />,
      count: userOverview?.postCount ?? 0,
      disabled: !!user?.bannedAt,
    },
    images: {
      url: `${baseUrl}/images`,
      icon: (props) => <IconPhoto {...props} />,
      count: userOverview?.imageCount ?? 0,
      disabled: !!user?.bannedAt,
    },
    videos: {
      url: `${baseUrl}/videos`,
      icon: (props) => <IconVideo {...props} />,
      count: userOverview?.videoCount ?? 0,
      disabled: !!user?.bannedAt,
    },
    articles: {
      url: `${baseUrl}/articles`,
      icon: (props) => <IconPencilMinus {...props} />,
      count: userOverview?.articleCount ?? 0,
      disabled: !articles || !!user?.bannedAt,
    },
    collections: {
      url: `${baseUrl}/collections`,
      icon: (props) => <IconBookmark {...props} />,
      count: userOverview?.collectionCount ?? 0,
      disabled: !!user?.bannedAt,
    },
  };

  return (
    <HomeStyleSegmentedControl
      data={opts}
      value={activePath}
      loading={isInitialLoading || isRefetching}
    />
  );
};
