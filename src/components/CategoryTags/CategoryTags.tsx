import { ActionIcon, Box, Button, createStyles, Group, ScrollArea } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useRef, useState } from 'react';

import { useModelQueryParams } from '~/components/Model/model.utils';
import { TagSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useCategoryTags } from '~/components/Tags/tag.utils';
import { TagTarget } from '~/shared/utils/prisma/enums';

const useStyles = createStyles((theme) => ({
  tagsContainer: {
    position: 'relative',

    [containerQuery.largerThan('lg')]: {
      // marginLeft: theme.spacing.xl * -1.5, // -36px
      // marginRight: theme.spacing.xl * -1.5, // -36px
    },
  },
  tagsGroup: {
    [containerQuery.largerThan('lg')]: {
      // marginLeft: theme.spacing.xl * 1.5, // 36px
      // marginRight: theme.spacing.xl * 1.5, // 36px
    },
  },
  tag: {
    textTransform: 'uppercase',
  },
  title: {
    display: 'none',

    [containerQuery.largerThan('sm')]: {
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

    [containerQuery.largerThan('md')]: {
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

    [containerQuery.largerThan('md')]: {
      display: 'block',
    },
  },
  viewport: {
    overflowX: 'scroll',
    overflowY: 'hidden',
  },
}));

export function CategoryTags({
  selected,
  setSelected,
  filter,
}: {
  selected?: string;
  setSelected?: (tag?: string) => void;
  filter?: (tag: string) => boolean;
}) {
  const { classes, cx, theme } = useStyles();
  const { set, tag: tagQuery } = useModelQueryParams();

  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollPosition, setScrollPosition] = useState({ x: 0, y: 0 });

  const { data: categories } = useCategoryTags({ entityType: TagTarget.Model });

  if (!categories.length) return null;

  const atStart = scrollPosition.x === 0;
  const atEnd =
    viewportRef.current &&
    scrollPosition.x >= viewportRef.current.scrollWidth - viewportRef.current.offsetWidth - 1;

  const scrollLeft = () => viewportRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => viewportRef.current?.scrollBy({ left: 200, behavior: 'smooth' });

  const handleSetTag = (tag: string | undefined) => set({ tag });

  const _tag = selected ?? tagQuery;
  const _setTag = setSelected ?? handleSetTag;

  return (
    <ScrollArea
      viewportRef={viewportRef}
      className={classes.tagsContainer}
      classNames={classes}
      type="never"
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
      <Group className={classes.tagsGroup} spacing={8} noWrap>
        <Button
          className={classes.tag}
          variant={!_tag ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
          color={!_tag ? 'blue' : 'gray'}
          onClick={() => _setTag(undefined)}
          compact
        >
          All
        </Button>
        {categories
          .filter((x) => (filter ? filter(x.name) : true))
          .map((tag) => {
            const active = _tag === tag.name;
            return (
              <Button
                key={tag.id}
                className={classes.tag}
                variant={active ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
                color={active ? 'blue' : 'gray'}
                onClick={() => _setTag(!active ? tag.name : undefined)}
                compact
              >
                {tag.name}
              </Button>
            );
          })}
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
