import {
  Box,
  Card,
  createStyles,
  DefaultMantineColor,
  Group,
  Rating,
  Stack,
  Text,
} from '@mantine/core';
import { useWindowSize } from '@react-hook/window-size';
import { IconDownload } from '@tabler/icons';
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
import React, { useEffect, useRef, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useModelStore } from '~/hooks/useModelStore';
import { useModelFilters } from '~/hooks/useModelFilters';
import { GetAllModelsReturnType } from '~/server/validators/models/getAllModels';
import { getRandom } from '~/utils/array-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';

type MasonryListProps = {
  columnWidth: number;
  data: GetAllModelsReturnType;
};

// https://github.com/jaredLunde/masonic
export function MasonryList({ columnWidth = 300, data }: MasonryListProps) {
  // use stringified filters as key for positioner dependency array
  const { filters } = useModelFilters();
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
    overscanBy: 10,
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
  data: GetAllModelsReturnType[0];
  width: number;
}) => {
  const { id, image, name, rank, nsfw } = data ?? {};
  const { classes } = useStyles();

  const hasDimensions = image.width && image.height;

  const setSelectedIndex = useModelStore((state) => state.setIndex);
  const { ref, inView } = useInView();

  const height = useMemo(() => {
    if (!image.width || !image.height || !width) return 300;
    const aspectRatio = image.width / image.height;
    const heightT = width / aspectRatio;
    return heightT + (rank.rating ? 72 : 36);
  }, [width, image.width, image.height, rank.rating]);

  // console.log({ height, width });

  return (
    <Link href={`models/${id}`} prefetch={false}>
      <Card
        ref={ref}
        withBorder
        shadow="sm"
        className={classes.card}
        style={{ height: `${height}px` }}
        onClick={() => setSelectedIndex(index)}
        p={0}
      >
        {inView && (
          <>
            {nsfw ? (
              <MediaHash {...image} />
            ) : (
              <Image
                src={image.url}
                alt={name}
                objectFit="cover"
                objectPosition="top"
                // height={hasDimensions ? `${image.height}px` : undefined}
                // width={hasDimensions ? `${image.width}px` : undefined}
                // layout={!hasDimensions ? 'fill' : undefined}
                layout="fill"
                placeholder="empty"
              />
            )}

            <Box p="xs" className={classes.content}>
              <Group position="apart" align="flex-end">
                <Stack spacing={6}>
                  <Text size={14} lineClamp={2}>
                    {name}
                  </Text>
                  {!!rank?.rating && (
                    <Group spacing={5}>
                      <Rating value={rank.rating} fractions={2} readOnly size="xs" />
                      <Text size="xs">({rank.ratingCount})</Text>
                    </Group>
                  )}
                </Stack>
                <Group spacing={5} align="bottom">
                  <Text size="xs">{abbreviateNumber(rank.downloadCount ?? 0)}</Text>
                  <IconDownload size={16} />
                </Group>
              </Group>
            </Box>
          </>
        )}
      </Card>
    </Link>
  );
};

const useStyles = createStyles((theme) => {
  const base = theme.colors[getRandom(mantineColors)];
  const background = theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0];

  return {
    card: {
      height: '300px',
      cursor: 'pointer',
      background: theme.fn.gradient({ from: base[9], to: background, deg: 180 }),
    },

    content: {
      background,
      position: 'absolute',
      bottom: 0,
      right: 0,
      left: 0,
    },
  };
});
