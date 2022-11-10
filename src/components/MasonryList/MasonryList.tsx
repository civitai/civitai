import {
  Box,
  Card,
  createStyles,
  DefaultMantineColor,
  Group,
  LoadingOverlay,
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
import Link from 'next/link';
import React, { useEffect, useRef, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';

import { useModelFilters } from '~/hooks/useModelFilters';
import { GetAllModelsReturnType } from '~/server/validators/models/getAllModels';
import { getRandom } from '~/utils/array-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { useRouter } from 'next/router';
import { SensitiveContent } from '~/components/SensitiveContent/SensitiveContent';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useSession } from 'next-auth/react';
import { MetricTimeframe } from '@prisma/client';

type MasonryListProps = {
  columnWidth: number;
  data: GetAllModelsReturnType;
};

// https://github.com/jaredLunde/masonic
export function MasonryList({ columnWidth = 300, data }: MasonryListProps) {
  // use stringified filters as key for positioner dependency array
  const { filters } = useModelFilters();
  const stringified = JSON.stringify(filters);
  const router = useRouter();
  const modelId = Number(([] as string[]).concat(router.query.model ?? [])[0]);

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
    if (!data?.length) return;
    if (!modelId) scrollToIndex(0);
    const index = data.findIndex((x) => x.id === modelId);
    if (index === -1 || data.length < index) return;

    scrollToIndex(index);
  }, [stringified]); //eslint-disable-line

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
  width: itemWidth,
}: {
  index: number;
  data: GetAllModelsReturnType[0];
  width: number;
}) => {
  const { data: session } = useSession();
  const { id, image, name, rank, nsfw } = data ?? {};
  const { classes } = useStyles();
  const [loading, setLoading] = useState(false);

  // const hasDimensions = image.width && image.height;

  const { ref, inView } = useInView();

  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = itemWidth > 0 ? itemWidth : 300;
    const aspectRatio = image.width / image.height;
    const heightT = width / aspectRatio;
    return heightT + (rank?.ratingAllTime ? 66 : 33);
  }, [itemWidth, image.width, image.height, rank?.ratingAllTime]);

  const modelText = (
    <Text size={14} weight={500} lineClamp={2} style={{ flex: 1 }}>
      {name}
    </Text>
  );

  const modelRating = (
    <Group spacing={5}>
      <Rating value={rank?.ratingAllTime ?? 0} fractions={2} readOnly size="xs" />
      <Text size="xs">({(rank?.ratingCountAllTime ?? 0).toString()})</Text>
    </Group>
  );

  const modelDownloads = (
    <Group spacing={5} align="bottom">
      <Text size="xs">{abbreviateNumber(rank?.downloadCountAllTime ?? 0).toString()}</Text>
      <IconDownload size={16} />
    </Group>
  );

  const withRating = (
    <Stack spacing={6}>
      {modelText}
      <Group position="apart">
        {modelRating}
        {modelDownloads}
      </Group>
    </Stack>
  );

  const withoutRating = (
    <Group position="apart" align="flex-end">
      {modelText}
      {modelDownloads}
    </Group>
  );

  const PreviewImage = (
    <EdgeImage
      src={image.url}
      alt={image.name ?? undefined}
      width={450}
      placeholder="empty"
      style={{ width: '100%' }}
    />
  );

  return (
    <Link
      href={{
        pathname: `models/${id}`,
        query: nsfw && session?.user?.blurNsfw ? { showNsfw: true } : undefined,
      }}
      as={`models/${id}`}
      // prefetch={false}
    >
      <Card
        ref={ref}
        withBorder
        shadow="sm"
        className={classes.card}
        style={{ height: `${height}px` }}
        p={0}
        onClick={() => setLoading(true)}
      >
        <LoadingOverlay visible={loading} zIndex={10} loaderProps={{ variant: 'dots' }} />
        {inView && (
          <>
            {nsfw ? (
              <SensitiveContent placeholder={<MediaHash {...image} />} style={{ height: '100%' }}>
                {PreviewImage}
              </SensitiveContent>
            ) : (
              PreviewImage
            )}
            <Box p="xs" className={classes.content}>
              {!!rank?.ratingAllTime ? withRating : withoutRating}
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
