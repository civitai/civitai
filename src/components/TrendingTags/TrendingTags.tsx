import { ActionIcon, Box, Button, createStyles, Group, ScrollArea } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useRef, useState } from 'react';

import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  tagsContainer: {
    position: 'relative',

    [theme.fn.largerThan('lg')]: {
      marginLeft: theme.spacing.xl * -1.5, // -36px
      marginRight: theme.spacing.xl * -1.5, // -36px
    },
  },
  tag: {
    textTransform: 'uppercase',
  },
  title: {
    display: 'none',

    [theme.fn.largerThan('sm')]: {
      display: 'block',
    },
  },
  arrowButton: {
    '&:active': {
      transform: 'none',
    },
  },
  hidden: {
    display: 'none !important',
  },
  leftArrow: {
    display: 'none',
    position: 'absolute',
    left: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    paddingRight: theme.spacing.xl,
    zIndex: 12,
    backgroundImage: theme.fn.gradient({
      from: theme.colorScheme === 'dark' ? theme.colors.dark[7] : 'white',
      to: 'transparent',
      deg: 90,
    }),

    [theme.fn.largerThan('md')]: {
      display: 'block',
    },
  },
  rightArrow: {
    display: 'none',
    position: 'absolute',
    right: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    paddingLeft: theme.spacing.xl,
    zIndex: 12,
    backgroundImage: theme.fn.gradient({
      from: theme.colorScheme === 'dark' ? theme.colors.dark[7] : 'white',
      to: 'transparent',
      deg: 270,
    }),

    [theme.fn.largerThan('md')]: {
      display: 'block',
    },
  },
}));

export function TrendingTags() {
  const { classes, cx } = useStyles();
  const router = useRouter();

  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollPosition, setScrollPosition] = useState({ x: 0, y: 0 });

  const { data: trendingTags = [] } = trpc.tag.getTrending.useQuery({ entityType: 'Model' });

  if (!trendingTags.length) return null;

  const atStart = scrollPosition.x === 0;
  const atEnd =
    viewportRef.current &&
    scrollPosition.x >= viewportRef.current.scrollWidth - viewportRef.current.offsetWidth;

  const scrollLeft = () => viewportRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => viewportRef.current?.scrollBy({ left: 200, behavior: 'smooth' });

  return (
    <ScrollArea
      viewportRef={viewportRef}
      type="never"
      className={classes.tagsContainer}
      onScrollPositionChange={setScrollPosition}
    >
      <Box className={cx(classes.leftArrow, atStart && classes.hidden)}>
        <ActionIcon
          className={classes.arrowButton}
          variant="transparent"
          radius="xl"
          onClick={scrollLeft}
        >
          <IconChevronLeft />
        </ActionIcon>
      </Box>
      <Group spacing={8} px={36} noWrap>
        <Link href="/" passHref>
          <Button
            component="a"
            className={classes.tag}
            variant={!router.query.tag ? 'filled' : 'light'}
            compact
          >
            All
          </Button>
        </Link>
        {trendingTags.map((tag) => (
          <Link key={tag.id} href={`/?tag=${encodeURIComponent(tag.name)}`} as="/" passHref>
            <Button
              component="a"
              className={classes.tag}
              variant={router.query.tag === tag.name ? 'filled' : 'light'}
              compact
            >
              {tag.name}
            </Button>
          </Link>
        ))}
      </Group>
      <Box className={cx(classes.rightArrow, atEnd && classes.hidden)}>
        <ActionIcon
          className={classes.arrowButton}
          variant="transparent"
          radius="xl"
          onClick={scrollRight}
        >
          <IconChevronRight />
        </ActionIcon>
      </Box>
    </ScrollArea>
  );
}
