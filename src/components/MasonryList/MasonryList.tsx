import {
  Box,
  Card,
  createStyles,
  DefaultMantineColor,
  Group,
  Stack,
  Text,
  useMantineTheme,
} from '@mantine/core';
import {
  useContainerPosition,
  useMasonry,
  usePositioner,
  useResizeObserver,
  useScroller,
  useScrollToIndex,
} from 'masonic';
import Image from 'next/image';
import Link from 'next/link';
import React, { useMemo, useEffect, useRef } from 'react';
import { StarRating } from '~/components/StarRating/StarRating';
import { GetAllModelsReturnType } from '~/server/services/models/getAllModels';
import { useWindowSize } from '@react-hook/window-size';
import { getRandom } from './../../utils/array-helpers';
import { useModelStore } from '~/hooks/useModelStore';

type MasonryListProps = {
  columnWidth: number;
  data: GetAllModelsReturnType['items'];
};

// https://github.com/jaredLunde/masonic
export function MasonryList({ columnWidth = 300, data }: MasonryListProps) {
  // use stringified filters as key for positioner dependency array
  const filters = useModelStore((state) => state.filters);
  const stringified = JSON.stringify(filters);

  const selectedIndex = useModelStore((state) => state.index);
  const setSelectedIndex = useModelStore((state) => state.setIndex);

  const containerRef = useRef(null);
  const [windowWidth, height] = useWindowSize();
  const { offset, width } = useContainerPosition(containerRef, [windowWidth, height]);
  // with 'stringified' in the dependency array, masonic knows to expect layout changes
  const positioner = usePositioner({ width, columnGutter: 16, columnWidth }, [stringified]);
  const { scrollTop, isScrolling } = useScroller(offset);
  const resizeObserver = useResizeObserver(positioner);
  const scrollToIndex = useScrollToIndex(positioner, {
    offset,
    height,
    align: 'center',
  });

  useEffect(() => {
    if (!data?.length || !selectedIndex || data.length < selectedIndex) return;

    scrollToIndex(selectedIndex);
    setSelectedIndex(undefined);
  }, []); //eslint-disable-line

  return useMasonry({
    resizeObserver,
    positioner,
    scrollTop,
    isScrolling,
    height,
    containerRef,
    items: data,
    overscanBy: 3,
    render: MasonryItem,
  });
}

const mantineColors: DefaultMantineColor[] = [
  'blue',
  'cyan',
  'grape',
  'green',
  'indigo',
  'lime',
  'orange',
  'pink',
  'red',
  'teal',
  'violet',
  'yellow',
];

const MasonryItem = ({
  index,
  data,
  width,
}: {
  index: number;
  data: GetAllModelsReturnType['items'][0];
  width: number;
}) => {
  const { id, image, name, rank } = data ?? {};
  const { classes } = useStyles();

  const hasDimensions = image.width && image.height;

  const setSelectedIndex = useModelStore((state) => state.setIndex);

  // const height = useMemo(() => {
  //   if (!image.url) return undefined;
  //   if (!image.width || !image.height) return 300;
  //   const aspectRatio = image.width / image.height;
  //   const heightT = width / aspectRatio;
  //   return heightT + 72;
  // }, [width, image.width, image.height, image.url]);

  const theme = useMantineTheme();
  const background = useMemo(() => {
    const base = theme.colors[getRandom(mantineColors)];
    return theme.fn.gradient({ from: base[6], to: base[3] });
  }, []);

  return (
    <Link href={`models/${id}`}>
      <Card
        withBorder
        shadow="sm"
        className={classes.card}
        style={{ background }}
        onClick={() => setSelectedIndex(index)}
        p={0}
      >
        <Image
          src={image.url}
          alt={name}
          objectFit="cover"
          objectPosition="top"
          height={hasDimensions ? `${image.height}px` : undefined}
          width={hasDimensions ? `${image.width}px` : undefined}
          layout={!hasDimensions ? 'fill' : undefined}
          placeholder="empty"
        />
        <Box p="xs" className={classes.content}>
          <Stack spacing={6}>
            <Text size={14} lineClamp={2}>
              {name}
            </Text>
            <Group position="apart">
              <StarRating rating={rank.rating} />
            </Group>
          </Stack>
        </Box>
      </Card>
    </Link>
  );
};

const useStyles = createStyles((theme) => ({
  card: {
    height: '300px',
    cursor: 'pointer',
  },

  content: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
    position: 'absolute',
    bottom: 0,
    right: 0,
    left: 0,
  },
}));
