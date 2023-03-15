import { ActionIcon, Box, Button, createStyles, Group, ScrollArea } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons';
import { useRef, useState } from 'react';

type TagProps = { id: number; name: string };
export function TagScroller({
  data,
  value = [],
  onChange,
}: {
  data: TagProps[];
  value?: number[];
  onChange?: (value: number[]) => void;
}) {
  const { classes, cx, theme } = useStyles();

  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollPosition, setScrollPosition] = useState({ x: 0, y: 0 });

  if (!data.length) return null;

  const atStart = scrollPosition.x === 0;
  const atEnd =
    viewportRef.current &&
    scrollPosition.x >= viewportRef.current.scrollWidth - viewportRef.current.offsetWidth - 1;

  const scrollLeft = () => viewportRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => viewportRef.current?.scrollBy({ left: 200, behavior: 'smooth' });

  const handleChange = (tagId: number, shouldAdd: boolean) => {
    const tags = [...value];
    const index = tags.findIndex((id) => id === tagId);
    if (shouldAdd) {
      if (index === -1) tags.push(tagId);
      else tags.splice(index, 1);
      onChange?.(tags);
    } else {
      if (index === -1 || tags.length > 1) onChange?.([tagId]);
      else onChange?.([]);
    }
  };

  return (
    <ScrollArea
      viewportRef={viewportRef}
      className={classes.tagsContainer}
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
        {data.map((tag) => {
          const active = value.includes(tag.id);
          return (
            <Button
              key={tag.id}
              className={classes.tag}
              variant={active ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
              color={active ? 'blue' : 'gray'}
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                const shouldAdd = e.ctrlKey;
                handleChange(tag.id, shouldAdd);
              }}
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

const useStyles = createStyles((theme) => ({
  tagsContainer: {
    position: 'relative',

    [theme.fn.largerThan('lg')]: {
      // marginLeft: theme.spacing.xl * -1.5, // -36px
      // marginRight: theme.spacing.xl * -1.5, // -36px
    },
  },
  tagsGroup: {
    [theme.fn.largerThan('lg')]: {
      // marginLeft: theme.spacing.xl * 1.5, // 36px
      // marginRight: theme.spacing.xl * 1.5, // 36px
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
