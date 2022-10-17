import {
  Box,
  Card,
  createStyles,
  DefaultMantineColor,
  Group,
  MantineTheme,
  Stack,
  Text,
  useMantineTheme,
} from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
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

type MasonryListProps = {
  columnWidth: number;
  data: GetAllModelsReturnType['items'];
};

// https://github.com/jaredLunde/masonic
export function MasonryList({ columnWidth = 300, data }: MasonryListProps) {
  const [selected] = useSessionStorage({
    key: 'selectedIndex',
    getInitialValueInEffect: false,
    deserialize: (value) => (!!value ? Number(value) : undefined),
  });

  const containerRef = useRef(null);
  const [windowWidth, height] = useWindowSize();
  const { offset, width } = useContainerPosition(containerRef, [windowWidth, height]);
  const positioner = usePositioner({ width, columnGutter: 16, columnWidth });
  const { scrollTop, isScrolling } = useScroller(offset);
  const resizeObserver = useResizeObserver(positioner);
  const scrollToIndex = useScrollToIndex(positioner, {
    offset,
    height,
    align: 'center',
  });

  useEffect(() => {
    if (!data?.length || !selected || data.length < selected) return;
    scrollToIndex(selected);
  }, []); //eslint-disable-line

  useEffect(() => console.log({ data }), [data]);

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
  const { id, image, name, metrics } = data ?? {};
  const { classes } = useStyles();

  const hasDimensions = image.width && image.height;
  const [, setSelected] = useSessionStorage({
    key: 'selectedIndex',
    serialize: (value: number) => value.toString(),
  });

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
        onClick={() => setSelected(index)}
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
              <StarRating rating={metrics.rating} />
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
