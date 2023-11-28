import { Anchor, Badge, createStyles, Group, Tabs, Text } from '@mantine/core';
import React from 'react';
import {
  IconAssembly,
  IconCategory,
  IconClubs,
  IconLayoutList,
  IconPencilMinus,
  IconPhoto,
  IconPlaylistAdd,
} from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { numberWithCommas } from '~/utils/number-helpers';
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
    tiers: {
      url: `${baseUrl}/models`,
      icon: <IconCategory />,
    },
    admins: {
      url: `${baseUrl}/articles`,
      icon: <IconPencilMinus />,
    },
  };

  return <HomeStyleSegmentedControl data={opts} value={activePath} />;
};
