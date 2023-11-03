import { Anchor, Badge, Group, Tabs, Text } from '@mantine/core';
import React from 'react';
import { IconAssembly, IconCategory, IconPencilMinus, IconPhoto } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import Link from 'next/link';

type ProfileNavigationProps = {
  username: string;
};

export const ProfileNavigation = ({ username }: ProfileNavigationProps) => {
  const router = useRouter();
  const { data: userOverview } = trpc.userProfile.overview.useQuery({
    username,
  });
  const activePath = router.pathname.split('/').pop() || 'profile';

  const baseUrl = `/user/${username}/profile`;

  const opts: Record<
    string,
    { url: string; icon: React.ReactNode; label?: string; count?: number }
  > = {
    profile: {
      url: '/',
      icon: <IconAssembly />,
      label: 'Overview',
    },
    models: {
      url: `/models`,
      icon: <IconCategory />,
      count: userOverview?.modelCount,
    },
    images: {
      url: `/images`,
      icon: <IconPhoto />,
      count: userOverview?.imageCount,
    },
    articles: {
      url: `/articles`,
      icon: <IconPencilMinus />,
      count: userOverview?.articleCount,
    },
  };

  return (
    <Tabs value={activePath}>
      <Tabs.List style={{ flexWrap: 'nowrap', overflow: 'auto hidden', paddingBottom: '2px' }}>
        {Object.keys(opts).map((key) => {
          return (
            <Link href={`${baseUrl}${opts[key].url}`} passHref key={key}>
              <Anchor variant="text">
                <Tabs.Tab value={key}>
                  <Group noWrap>
                    {opts[key].icon}
                    <Text tt="capitalize">{opts[key]?.label ?? key}</Text>
                    {!!opts[key].count && <Badge>{opts[key].count}</Badge>}
                  </Group>
                </Tabs.Tab>
              </Anchor>
            </Link>
          );
        })}
      </Tabs.List>
    </Tabs>
  );
};
