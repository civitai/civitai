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

type ProfileNavigationProps = {
  username: string;
};

const overviewPath = '[username]';
const useStyles = createStyles((theme, _, getRef) => {
  const selectedRef = getRef('selected');
  return {
    container: {
      position: 'relative',
      '&:hover': {
        [`& .${getRef('scrollArea')}`]: {
          '&::-webkit-scrollbar': {
            opacity: 1,
          },
          '&::-webkit-scrollbar-thumb': {
            backgroundColor:
              theme.colorScheme === 'dark'
                ? theme.fn.rgba(theme.white, 0.5)
                : theme.fn.rgba(theme.black, 0.5),
          },
        },
      },
    },
    scrollArea: {
      ref: getRef('scrollArea'),
      overflow: 'auto',
      scrollSnapType: 'x mandatory',
      '&::-webkit-scrollbar': {
        background: 'transparent',
        opacity: 0,
        height: 8,
      },
      '&::-webkit-scrollbar-thumb': {
        borderRadius: 4,
      },
    },

    tabs: {
      flexWrap: 'nowrap',
      overflow: 'auto hidden',
      paddingBottom: '2px',
      borderBottom: 0,
    },
    selected: {
      ref: selectedRef,
    },
    navigatorBtn: {
      padding: theme.spacing.md,
      [theme.fn.smallerThan('md')]: {
        padding: theme.spacing.sm,
      },
    },
    navigatorBtnGroup: {
      [theme.fn.smallerThan('md')]: {
        gap: '5px',
      },
    },
    navigatorBtnIcon: {},
    navigatorBtnText: {
      [theme.fn.smallerThan('md')]: {
        display: 'none',

        [`.${selectedRef} &`]: {
          display: 'block',
        },
      },
    },
  };
});

export const ProfileNavigation = ({ username }: ProfileNavigationProps) => {
  const router = useRouter();
  const { classes, cx } = useStyles();
  const { data: userOverview } = trpc.userProfile.overview.useQuery({
    username,
  });
  const activePath = router.pathname.split('/').pop() || overviewPath;

  const baseUrl = `/user/${username}`;

  const opts: Record<
    string,
    { url: string; icon: React.ReactNode; label?: string; count?: number | string }
  > = {
    [overviewPath]: {
      url: '/',
      icon: <IconAssembly />,
      label: 'Overview',
    },
    models: {
      url: `/models`,
      icon: <IconCategory />,
      count: numberWithCommas(userOverview?.modelCount),
    },
    posts: {
      url: `/posts`,
      icon: <IconLayoutList />,
      count: numberWithCommas(userOverview?.postCount),
    },
    images: {
      url: `/images`,
      icon: <IconPhoto />,
      count: numberWithCommas(userOverview?.imageCount),
    },
    articles: {
      url: `/articles`,
      icon: <IconPencilMinus />,
      count: numberWithCommas(userOverview?.articleCount),
    },
    collections: {
      url: `/collections`,
      icon: <IconPlaylistAdd />,
      count: numberWithCommas(userOverview?.collectionCount),
    },
  };

  return (
    <HomeStyleSegmentedControl
      data={opts}
      value={activePath}
      onChange={({ url }) => {
        router.push(`${baseUrl}${url}`);
      }}
    />
  );
};
