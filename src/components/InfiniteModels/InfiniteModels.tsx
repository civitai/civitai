import {
  Badge,
  Box,
  Card,
  Center,
  createStyles,
  DefaultMantineColor,
  Group,
  Loader,
  LoadingOverlay,
  Stack,
  Text,
  ThemeIcon,
  useMantineTheme,
} from '@mantine/core';
import { ModelStatus } from '@prisma/client';
import { useWindowSize } from '@react-hook/window-size';
import { IconCloudOff, IconDownload, IconHeart } from '@tabler/icons';
import {
  useContainerPosition,
  useMasonry,
  usePositioner,
  useResizeObserver,
  useScroller,
  useScrollToIndex,
} from 'masonic';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import React, { useEffect, useRef, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ModelRating } from '~/components/ModelRating/ModelRating';
import { SensitiveContent } from '~/components/SensitiveContent/SensitiveContent';
import { useModelFilters } from '~/hooks/useModelFilters';
import { GetModelsInfiniteReturnType } from '~/server/controllers/model.controller';
import { getRandom } from '~/utils/array-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { QS } from '~/utils/qs';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type InfiniteModelsProps = {
  columnWidth?: number;
};

export function InfiniteModels({ columnWidth = 300 }: InfiniteModelsProps) {
  const router = useRouter();
  const queryParams = QS.parse(QS.stringify(router.query));
  const { ref, inView } = useInView();
  const {
    data,
    isLoading,
    isFetching,
    fetchNextPage,
    // fetchPreviousPage,
    hasNextPage,
    // hasPreviousPage,
  } = trpc.model.getAll.useInfiniteQuery(
    { limit: 100, ...queryParams },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
    }
  );

  useEffect(() => {
    if (inView) {
      fetchNextPage();
    }
  }, [fetchNextPage, inView]);

  const models = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [], [data]);
  const loading = isLoading || isFetching;

  return (
    <>
      {loading ? (
        <Center>
          <Loader size="xl" />
        </Center>
      ) : !!models.length ? (
        <MasonryList columnWidth={300} data={models} />
      ) : (
        <Stack align="center">
          <ThemeIcon size={128} radius={100}>
            <IconCloudOff size={80} />
          </ThemeIcon>
          <Text size={32} align="center">
            No results found
          </Text>
          <Text align="center">
            {"Try adjusting your search or filters to find what you're looking for"}
          </Text>
        </Stack>
      )}
      {!loading && hasNextPage && (
        <Group position="center" ref={ref}>
          <Loader />
        </Group>
      )}
    </>
  );
}

type MasonryListProps = {
  columnWidth: number;
  data: GetModelsInfiniteReturnType;
};

// https://github.com/jaredLunde/masonic
export function MasonryList({ columnWidth = 300, data }: MasonryListProps) {
  const router = useRouter();
  // use stringified filters as key for positioner dependency array
  const { filters } = useModelFilters();
  const stringified = JSON.stringify(filters);
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
  data,
  width: itemWidth,
}: {
  index: number;
  data: GetModelsInfiniteReturnType[0];
  width: number;
}) => {
  const { data: session } = useSession();
  const { classes } = useStyles();
  const theme = useMantineTheme();

  const { id, image, name, rank, nsfw } = data ?? {};
  const blurNsfw = session?.user?.blurNsfw ?? true;

  const [showingNsfw, setShowingNsfw] = useState(!blurNsfw);
  const [loading, setLoading] = useState(false);
  const { ref, inView } = useInView();

  const { data: favoriteModels = [] } = trpc.user.getFavoriteModels.useQuery(undefined, {
    enabled: !!session,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const isFavorite = favoriteModels.find((favorite) => favorite.modelId === id);

  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = itemWidth > 0 ? itemWidth : 300;
    const aspectRatio = image.width / image.height;
    const imageHeight = Math.floor(width / aspectRatio);
    const totalHeight = imageHeight + (rank?.ratingAllTime ? 66 : 33);
    return totalHeight;
  }, [itemWidth, image.width, image.height, rank?.ratingAllTime]);

  const modelText = (
    <Group position="left">
      <Text size={14} weight={500} lineClamp={2} style={{ flex: 1 }}>
        {name}
      </Text>
      {data.status !== ModelStatus.Published && (
        <Badge color="yellow" radius="sm">
          {data.status}
        </Badge>
      )}
    </Group>
  );

  const modelRating = <ModelRating rank={rank} size="xs" />;

  const modelDownloads = (
    <Group spacing={5} align="bottom">
      <IconDownload size={16} />
      <Text size="xs">{abbreviateNumber(rank?.downloadCountAllTime ?? 0)}</Text>
    </Group>
  );

  const modelLikes = (
    <Group spacing={5}>
      <IconHeart
        size={16}
        style={{ fill: isFavorite ? theme.colors.red[6] : undefined }}
        color={isFavorite ? theme.colors.red[6] : undefined}
      />
      <Text size="xs">{abbreviateNumber(rank?.favoriteCountAllTime ?? 0)}</Text>
    </Group>
  );

  const withRating = (
    <Stack spacing={6}>
      {modelText}
      <Group position="apart">
        {modelRating}
        <Group spacing={4} align="center">
          {modelLikes}
          {modelDownloads}
        </Group>
      </Group>
    </Stack>
  );

  const withoutRating = (
    <Group position="apart" align="flex-end">
      {modelText}
      <Group spacing={4} align="center">
        {modelLikes}
        {modelDownloads}
      </Group>
    </Group>
  );

  const PreviewImage = (
    <EdgeImage
      src={image.url}
      alt={image.name ?? undefined}
      width={450}
      placeholder="empty"
      style={{ width: '100%', zIndex: 2, position: 'relative' }}
    />
  );

  const modelLink = `/models/${id}/${slugit(name)}`;

  return (
    <Link
      href={{
        pathname: modelLink,
        query: showingNsfw ? { showNsfw: true } : undefined,
      }}
      as={modelLink}
      passHref
    >
      <a>
        <Card
          ref={ref}
          withBorder
          shadow="sm"
          className={classes.card}
          style={{ height: `${height}px` }}
          p={0}
          onClick={(e: React.MouseEvent<HTMLDivElement>) => {
            if (!(e.ctrlKey || e.metaKey) || e.button === 0) setLoading(true);
          }}
        >
          <LoadingOverlay visible={loading} zIndex={10} loaderProps={{ variant: 'dots' }} />
          {inView && (
            <>
              <MediaHash
                hash={image.hash}
                width={image.width}
                height={image.height}
                style={{ bottom: rank?.ratingAllTime ? 66 : 33, height: 'auto' }}
              />
              {nsfw ? (
                <SensitiveContent
                  placeholder={<MediaHash {...image} />}
                  style={{ height: '100%' }}
                  onToggleClick={(value) => setShowingNsfw(value)}
                >
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
      </a>
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
      zIndex: 10,
    },
  };
});
