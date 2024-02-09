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
import { numberWithCommas } from '~/utils/number-helpers';
import {
  DataItem,
  HomeStyleSegmentedControl,
} from '~/components/HomeContentToggle/HomeStyleSegmentedControl';
import { IconVideo } from '@tabler/icons-react';

type ProfileNavigationProps = {
  username: string;
};

const overviewPath = '[username]';

export const ProfileNavigation = ({ username }: ProfileNavigationProps) => {
  const router = useRouter();
  const { data: userOverview } = trpc.userProfile.overview.useQuery({
    username,
  });
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
      count: numberWithCommas(userOverview?.modelCount),
    },
    posts: {
      url: `${baseUrl}/posts`,
      icon: (props) => <IconLayoutList {...props} />,
      count: numberWithCommas(userOverview?.postCount),
    },
    images: {
      url: `${baseUrl}/images`,
      icon: (props) => <IconPhoto {...props} />,
      count: numberWithCommas(userOverview?.imageCount),
    },
    videos: {
      url: `${baseUrl}/videos`,
      icon: (props) => <IconVideo {...props} />,
      count: numberWithCommas(userOverview?.videoCount),
    },
    articles: {
      url: `${baseUrl}/articles`,
      icon: (props) => <IconPencilMinus {...props} />,
      count: numberWithCommas(userOverview?.articleCount),
    },
    collections: {
      url: `${baseUrl}/collections`,
      icon: (props) => <IconBookmark {...props} />,
      count: numberWithCommas(userOverview?.collectionCount),
    },
  };

  return <HomeStyleSegmentedControl data={opts} value={activePath} />;
};
