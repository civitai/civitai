import React from 'react';
import {
  IconAssembly,
  IconBolt,
  IconCategory,
  IconFiles,
  IconUserBolt,
  IconUsers,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { HomeStyleSegmentedControl } from '~/components/HomeContentToggle/HomeStyleSegmentedControl';
import { useClubContributorStatus } from '~/components/Club/club.utils';
import { ClubAdminPermission } from '@prisma/client';

const overviewPath = '[id]';

export const ClubManagementNavigation = ({ id }: { id: number }) => {
  const router = useRouter();
  const activePath = router.pathname.split('/').pop() || overviewPath;
  const { isOwner, isModerator, permissions } = useClubContributorStatus({ clubId: id });

  const baseUrl = `/clubs/manage/${id}`;

  const isTiersEnabled = permissions.includes(ClubAdminPermission.ManageTiers);
  const isMembershipsEnabled = permissions.includes(ClubAdminPermission.ManageMemberships);
  const isResourcesEnabled = permissions.includes(ClubAdminPermission.ManageResources);
  const isRevenueEnabled = permissions.includes(ClubAdminPermission.ViewRevenue);

  const opts: Record<
    string,
    {
      url: string;
      icon: React.ReactNode;
      label?: string;
      count?: number | string;
      disabled?: boolean;
    }
  > = {
    [overviewPath]: {
      url: `${baseUrl}/`,
      icon: <IconAssembly />,
      label: 'General',
    },
    tiers: {
      url: `${baseUrl}/tiers`,
      icon: <IconCategory />,
      disabled: !isOwner && !isModerator && !isTiersEnabled,
    },
    admins: {
      url: `${baseUrl}/admins`,
      icon: <IconUserBolt />,
      disabled: !isOwner && !isModerator,
    },
    resources: {
      url: `${baseUrl}/resources`,
      icon: <IconFiles />,
      disabled: !isOwner && !isModerator && !isResourcesEnabled,
    },
    members: {
      url: `${baseUrl}/members`,
      icon: <IconUsers />,
      disabled: !isOwner && !isModerator && !isMembershipsEnabled,
    },
    revenue: {
      url: `${baseUrl}/revenue`,
      icon: <IconBolt />,
      disabled: !isOwner && !isModerator && !isRevenueEnabled,
    },
  };

  return <HomeStyleSegmentedControl data={opts} value={activePath} orientation="vertical" />;
};
