import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  createStyles,
  Group,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons';
import Link from 'next/link';
import { useRef, useState } from 'react';

import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  tag: {
    transition: 'background .3s',

    '&:hover': {
      backgroundColor:
        theme.colorScheme === 'dark' ? 'rgba(25, 113, 194, 0.3)' : 'rgba(231, 245, 255, 1)',
    },
  },
  title: {
    display: 'none',

    [theme.fn.largerThan('sm')]: {
      display: 'block',
    },
  },
  scrollArrow: {
    '&:active': {
      transform: 'none',
    },
  },
  hidden: {
    display: 'none',
  },
  leftArrow: {
    position: 'absolute',
    left: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    backgroundImage: theme.fn.gradient({
      from: theme.colorScheme === 'dark' ? theme.colors.dark[7] : 'white',
      to: 'transparent',
      deg: 90,
    }),
    paddingRight: theme.spacing.xl,
  },
  rightArrow: {
    position: 'absolute',
    right: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    backgroundImage: theme.fn.gradient({
      from: theme.colorScheme === 'dark' ? theme.colors.dark[7] : 'white',
      to: 'transparent',
      deg: 270,
    }),
    paddingLeft: theme.spacing.xl,
  },
}));

export function TrendingTags() {
  const { classes, cx } = useStyles();

  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollPosition, setScrollPosition] = useState({ x: 0, y: 0 });

  const { data: tagsData } = trpc.tag.getAll.useQuery({
    limit: 20,
    entityType: 'Model',
    withModels: true,
  });
  const trendingTags = tagsData?.items ?? [];

  if (!trendingTags.length) return null;

  const atStart = scrollPosition.x === 0;
  const atEnd =
    viewportRef.current &&
    scrollPosition.x >= viewportRef.current.scrollWidth - viewportRef.current.offsetWidth;

  const scrollLeft = () => viewportRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => viewportRef.current?.scrollBy({ left: 200, behavior: 'smooth' });

  return (
    <Stack spacing={4}>
      <Text className={classes.title} color="dimmed" transform="uppercase">
        Explore Tags
      </Text>
      <ScrollArea
        viewportRef={viewportRef}
        type="never"
        sx={{ position: 'relative' }}
        onScrollPositionChange={setScrollPosition}
      >
        <Box className={cx(classes.leftArrow, atStart && classes.hidden)}>
          <ActionIcon
            className={classes.scrollArrow}
            variant="transparent"
            radius="xl"
            onClick={scrollLeft}
          >
            <IconChevronLeft />
          </ActionIcon>
        </Box>
        <Group spacing={8} noWrap>
          {trendingTags.map((tag) => (
            <Link key={tag.id} href={`/tag/${tag.name.toLowerCase()}`} passHref>
              <Anchor variant="text">
                <Badge className={classes.tag} size="lg" variant="outline">
                  {tag.name}
                </Badge>
              </Anchor>
            </Link>
          ))}
        </Group>
        <Box className={cx(classes.rightArrow, atEnd && classes.hidden)}>
          <ActionIcon
            className={classes.scrollArrow}
            variant="transparent"
            radius="xl"
            onClick={scrollRight}
          >
            <IconChevronRight />
          </ActionIcon>
        </Box>
      </ScrollArea>
    </Stack>
  );
}
