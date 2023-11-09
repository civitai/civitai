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
    { url: string; icon: React.ReactNode; label?: string; count?: number }
  > = {
    [overviewPath]: {
      url: '/',
      icon: <IconAssembly />,
      label: 'Overview',
    },
    models: {
      url: `/models`,
      icon: <IconCategory />,
      count: userOverview?.modelCount,
    },
    posts: {
      url: `/posts`,
      icon: <IconLayoutList />,
      count: userOverview?.postCount,
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
    collections: {
      url: `/collections`,
      icon: <IconPlaylistAdd />,
      count: userOverview?.collectionCount,
    },
  };

  return (
    <Tabs value={activePath} className={classes.container}>
      <Tabs.List className={cx(classes.scrollArea, classes.tabs)}>
        {Object.keys(opts).map((key) => {
          console.log(key === activePath);
          return (
            <Link href={`${baseUrl}${opts[key].url}`} passHref key={key}>
              <Anchor variant="text">
                <Tabs.Tab
                  value={key}
                  className={cx(classes.navigatorBtn, { [classes.selected]: key === activePath })}
                >
                  <Group noWrap>
                    {opts[key].icon}
                    <Text tt="capitalize" className={classes.navigatorBtnText}>
                      {opts[key]?.label ?? key}
                    </Text>
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
