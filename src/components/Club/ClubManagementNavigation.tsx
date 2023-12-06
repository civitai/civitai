import { Anchor, Badge, createStyles, Group, Tabs, Text } from '@mantine/core';
import React from 'react';
import {
  IconAssembly,
  IconBolt,
  IconCategory,
  IconFiles,
  IconLayoutList,
  IconMoneybag,
  IconPencilMinus,
  IconPhoto,
  IconUsers,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
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
    resources: {
      url: `${baseUrl}/resources`,
      icon: <IconFiles />,
    },
    members: {
      url: `${baseUrl}/members`,
      icon: <IconUsers />,
    },
    revenue: {
      url: `${baseUrl}/revenue`,
      icon: <IconBolt />,
    },
  };

  return <HomeStyleSegmentedControl data={opts} value={activePath} orientation="vertical" />;
};
