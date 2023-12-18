import React from 'react';
import { IconCategory, IconClubs, IconLayoutList, IconPencilMinus } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { HomeStyleSegmentedControl } from '~/components/HomeContentToggle/HomeStyleSegmentedControl';

const overviewPath = '[id]';

export const ClubFeedNavigation = ({ id }: { id: number }) => {
  const router = useRouter();
  const activePath = router.pathname.split('/').pop() || overviewPath;

  const baseUrl = `/clubs/${id}`;

  const opts: Record<
    string,
    { url: string; icon: React.ReactNode; label?: string; count?: number | string }
  > = {
    [overviewPath]: {
      url: `${baseUrl}/`,
      icon: <IconClubs />,
      label: 'Feed',
    },
    models: {
      url: `${baseUrl}/models`,
      icon: <IconCategory />,
    },
    articles: {
      url: `${baseUrl}/articles`,
      icon: <IconPencilMinus />,
    },
    posts: {
      url: `${baseUrl}/posts`,
      icon: <IconLayoutList />,
    },
  };

  return <HomeStyleSegmentedControl data={opts} value={activePath} />;
};
