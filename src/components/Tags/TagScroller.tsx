import { ActionIcon, Box, Button, createStyles, Group } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { containerQuery } from '~/utils/mantine-css-helpers';

type TagProps = { id: number; name: string };
export function TagScroller({
  data,
  value = [],
  onChange,
}: {
  data?: TagProps[];
  value?: number[];
  onChange?: (value: number[]) => void;
}) {
  const { classes, cx, theme } = useStyles();

  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const largerThanViewport = node && node.scrollWidth > node.offsetWidth;
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const scrollLeft = () => node?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => node?.scrollBy({ left: 200, behavior: 'smooth' });

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

  useEffect(() => {
    if (!node) return;

    const listener = () => {
      const atStart = node?.scrollLeft === 0;
      const atEnd = node.scrollLeft >= node.scrollWidth - node.offsetWidth - 1;
      setAtStart(atStart);
      setAtEnd(atEnd);
    };

    listener();

    node.addEventListener('scroll', listener, { passive: true });
    return () => {
      node.removeEventListener('scroll', listener);
    };
  }, [node]);

  if (!data?.length) return null;

  return (
    <div className={classes.tagsContainer}>
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
      <Group ref={setNode} className={classes.tagsGroup} spacing={8} noWrap>
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
      <Box className={cx(classes.rightArrow, (atEnd || !largerThanViewport) && classes.hidden)}>
        <ActionIcon
          className={classes.arrowButton}
          variant="transparent"
          radius="xl"
          onClick={scrollRight}
        >
          <IconChevronRight />
        </ActionIcon>
      </Box>
    </div>
  );
}

const useStyles = createStyles((theme) => ({
  tagsContainer: {
    position: 'relative',
  },
  tagsGroup: {
    overflowX: 'auto',
    willChange: 'transform',
    scrollbarWidth: 'none',
    '::-webkit-scrollbar': {
      display: 'none',
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
}));
