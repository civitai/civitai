import { Anchor, Badge, createStyles, Group, Tabs, Text } from '@mantine/core';
import React from 'react';
import {
  IconAssembly,
  IconCategory,
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

export const ClubManagementNavigation = ({ id }: { id: number }) => {
  const router = useRouter();
  const activePath = router.pathname.split('/').pop() || overviewPath;

  const baseUrl = `/clubs/manage/${id}`;

  const opts: Record<
    string,
    { url: string; icon: React.ReactNode; label?: string; count?: number | string }
  > = {
    [overviewPath]: {
      url: `${baseUrl}/`,
      icon: <IconAssembly />,
      label: 'General',
    },
    tiers: {
      url: `${baseUrl}/tiers`,
      icon: <IconCategory />,
    },
    admins: {
      url: `${baseUrl}/admins`,
      icon: <IconLayoutList />,
    },
    members: {
      url: `${baseUrl}/members`,
      icon: <IconPhoto />,
    },
    revenue: {
      url: `${baseUrl}/revenue`,
      icon: <IconPencilMinus />,
    },
  };

  return <HomeStyleSegmentedControl data={opts} value={activePath} orientation="vertical" />;
};
