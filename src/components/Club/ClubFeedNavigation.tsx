import React from 'react';
import { IconCategory, IconClubs, IconLayoutList, IconPencilMinus } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import {
  DataItem,
  HomeStyleSegmentedControl,
} from '~/components/HomeContentToggle/HomeStyleSegmentedControl';

const overviewPath = '[id]';

export const ClubFeedNavigation = ({ id }: { id: number }) => {
  const router = useRouter();
  const activePath = router.pathname.split('/').pop() || overviewPath;

  const baseUrl = `/clubs/${id}`;

  const opts: Record<string, DataItem> = {
    [overviewPath]: {
      url: `${baseUrl}/`,
      icon: (props) => <IconClubs {...props} />,
      label: 'Feed',
    },
    models: {
      url: `${baseUrl}/models`,
      icon: (props) => <IconCategory {...props} />,
    },
    articles: {
      url: `${baseUrl}/articles`,
      icon: (props) => <IconPencilMinus {...props} />,
    },
    posts: {
      url: `${baseUrl}/posts`,
      icon: (props) => <IconLayoutList {...props} />,
    },
  };

  return <HomeStyleSegmentedControl data={opts} value={activePath} />;
};
