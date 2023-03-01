import {
  Badge,
  Box,
  Card,
  Center,
  createStyles,
  DefaultMantineColor,
  Group,
  Indicator,
  Loader,
  LoadingOverlay,
  Rating,
  Stack,
  Text,
  ThemeIcon,
  useMantineTheme,
  AspectRatio,
  Menu,
  ActionIcon,
} from '@mantine/core';
import { ModelStatus } from '@prisma/client';
import { useWindowSize } from '@react-hook/window-size';
import {
  IconCloudOff,
  IconDotsVertical,
  IconDownload,
  IconFlag,
  IconHeart,
  IconMessageCircle2,
  IconStar,
  IconTagOff,
} from '@tabler/icons';
import dayjs from 'dayjs';
import {
  useContainerPosition,
  useMasonry,
  usePositioner,
  useResizeObserver,
  useScroller,
  useScrollToIndex,
} from 'masonic';
import Link from 'next/link';
import { useRouter } from 'next/router';
import React, { useEffect, useRef, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { z } from 'zod';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { AmbientModelCard } from '~/components/InfiniteModels/AmbientModelCard';
import { useInfiniteModelsFilters } from '~/components/InfiniteModels/InfiniteModelsFilters';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { GetModelsInfiniteReturnType } from '~/server/controllers/model.controller';
import { ReportEntity } from '~/server/schema/report.schema';
import { getRandom } from '~/utils/array-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type InfiniteModelsProps = {
  columnWidth?: number;
  showHidden?: boolean;
  delayNsfw?: boolean;
};

const filterSchema = z.object({
  query: z.string().optional(),
  user: z.string().optional(),
  username: z.string().optional(),
  tagname: z.string().optional(),
  tag: z.string().optional(),
  favorites: z.preprocess((val) => val === true || val === 'true', z.boolean().optional()),
  hidden: z.preprocess((val) => val === true || val === 'true', z.boolean().optional()),
});

const aDayAgo = dayjs().subtract(1, 'day').toDate();

export function InfiniteModels({
  columnWidth = 300,
  showHidden = false,
  delayNsfw = false,
}: InfiniteModelsProps) {
  const router = useRouter();
  const filters = useInfiniteModelsFilters();
  const result = filterSchema.safeParse(router.query);
  const currentUser = useCurrentUser();
  const queryParams = result.success ? result.data : {};

  const { ref, inView } = useInView();

  const { data: blockedTags } = trpc.user.getTags.useQuery(
    { type: 'Hide' },
    { enabled: !!currentUser }
  );
  const excludedTagIds = blockedTags?.map((tag) => tag.id);

  // Hidden Models
  const { data: { Hide } = { Hide: [] }, isFetched: isHiddenFetched } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });

  // State is kept separate to prevent unnecessary re-fetch
  // when the user toggles a model's hidden state updating the list above
  const [excludedIds, setExcludedIds] = useState<number[]>();
  useEffect(() => {
    if (isHiddenFetched && !excludedIds) setExcludedIds(Hide);
  }, [isHiddenFetched]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading, fetchNextPage, hasNextPage } = trpc.model.getAll.useInfiniteQuery(
    {
      ...filters,
      ...queryParams,
      excludedTagIds,
      excludedIds: queryParams.hidden ? undefined : excludedIds,
    },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
    }
  );
  const { data: hidden = [] } = trpc.user.getHiddenUsers.useQuery(undefined, {
    enabled: !showHidden && !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const hiddenUserIds = useMemo(() => hidden.map((item) => item.id), [hidden]);

  useEffect(() => {
    if (inView) {
      fetchNextPage();
    }
  }, [fetchNextPage, inView]);

  const isAuthenticated = !!currentUser;
  const models = useMemo(
    () => {
      const items =
        data?.pages
          .flatMap((x) => (!!x ? x.items : []))
          .filter((item) => !hiddenUserIds.includes(item.user.id)) ?? [];

      // If current user isn't authenticated make sure they aren't greeted with a blurry wall
      if (delayNsfw && items.length > 0 && !isAuthenticated && items.length <= 100) {
        let toPush = 4;
        while (toPush > 0) {
          let i = 0;
          let item = items[0];
          while (item) {
            item = items[i];
            if (!item || item.nsfw) break;
            i++;
          }
          if (!item) break;
          items.splice(i, 1);
          items.splice(i + 4, 0, item);

          toPush--;
        }
      }

      return items;
    },
    [data, isAuthenticated] //eslint-disable-line
  );

  return (
    <>
      {isLoading ? (
        <Center>
          <Loader size="xl" />
        </Center>
      ) : !!models.length ? (
        <MasonryList
          columnWidth={columnWidth}
          data={models}
          filters={{ ...filters, ...queryParams }}
        />
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
      {!isLoading && hasNextPage && (
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
  filters: Record<string, unknown>;
};

// https://github.com/jaredLunde/masonic
export function MasonryList({ columnWidth, data, filters }: MasonryListProps) {
  const router = useRouter();
  const features = useFeatureFlags();
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
    if (!data?.length || !modelId) return;
    // if (!modelId) scrollToIndex(0);
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
    render: features.ambientCard ? AmbientModelCard : MasonryItem,
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

// const maxNameLengthByType: Record<ModelType, number> = {
//   [ModelType.Checkpoint]: 30,
//   [ModelType.Hypernetwork]: 30,
//   [ModelType.AestheticGradient]: 25,
//   [ModelType.TextualInversion]: 24,
// };

const MasonryItem = ({
  data,
  width: itemWidth,
}: {
  index: number;
  data: GetModelsInfiniteReturnType[0];
  width: number;
}) => {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const theme = useMantineTheme();

  const { id, image, name, rank, nsfw, user } = data ?? {};

  const [loading, setLoading] = useState(false);
  const { ref, inView } = useInView();

  const {
    data: { Favorite: favoriteModels = [], Hide: hiddenModels = [] } = { Favorite: [], Hide: [] },
  } = trpc.user.getEngagedModels.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const isFavorite = favoriteModels.find((modelId) => modelId === id);
  const { data: hidden = [] } = trpc.user.getHiddenUsers.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const isHidden =
    hidden.find(({ id }) => id === user.id) || hiddenModels.find((modelId) => modelId === id);

  const onTwoLines = true;
  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = itemWidth > 0 ? itemWidth : 300;
    const aspectRatio = image.width / image.height;
    const imageHeight = Math.floor(width / aspectRatio);
    const totalHeight = imageHeight + (onTwoLines ? 66 : 33);
    return totalHeight > 600 ? 600 : totalHeight;
  }, [itemWidth, image.width, image.height, onTwoLines]);

  const modelText = (
    <Text size={14} weight={500} lineClamp={1} style={{ flex: 1 }}>
      {name}
    </Text>
  );

  const modelBadges = (
    <>
      {data.status !== ModelStatus.Published && (
        <Badge color="yellow" radius="sm" size="xs">
          {data.status}
        </Badge>
      )}
      <Badge radius="sm" size="xs">
        {splitUppercase(data.type)}
      </Badge>
    </>
  );

  const modelRating = (
    <IconBadge
      sx={{ userSelect: 'none' }}
      icon={
        <Rating
          size="xs"
          value={rank.rating}
          readOnly
          emptySymbol={
            theme.colorScheme === 'dark' ? (
              <IconStar size={14} fill="rgba(255,255,255,.3)" color="transparent" />
            ) : undefined
          }
        />
      }
      variant={theme.colorScheme === 'dark' && rank.ratingCount > 0 ? 'filled' : 'light'}
    >
      <Text size="xs" color={rank.ratingCount > 0 ? undefined : 'dimmed'}>
        {abbreviateNumber(rank.ratingCount)}
      </Text>
    </IconBadge>
  );

  const modelDownloads = (
    <IconBadge
      icon={<IconDownload size={14} />}
      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
    >
      <Text size={12}>{abbreviateNumber(rank.downloadCount)}</Text>
    </IconBadge>
  );

  const modelLikes = !!rank.favoriteCount && (
    <IconBadge
      icon={
        <IconHeart
          size={14}
          style={{ fill: isFavorite ? theme.colors.red[6] : undefined }}
          color={isFavorite ? theme.colors.red[6] : undefined}
        />
      }
      color={isFavorite ? 'red' : 'gray'}
      variant={theme.colorScheme === 'dark' && !isFavorite ? 'filled' : 'light'}
    >
      <Text size="xs">{abbreviateNumber(rank.favoriteCount)}</Text>
    </IconBadge>
  );

  const modelComments = !!rank.commentCount && (
    <IconBadge
      icon={<IconMessageCircle2 size={14} />}
      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
    >
      <Text size="xs">{abbreviateNumber(rank.commentCount)}</Text>
    </IconBadge>
  );

  const twoLine = (
    <Stack spacing={6}>
      <Group position="left" spacing={4}>
        {modelText}
        {modelBadges}
      </Group>
      <Group position="apart" spacing={0}>
        {modelRating}
        <Group spacing={4} align="center" ml="auto">
          {modelLikes}
          {modelComments}
          {modelDownloads}
        </Group>
      </Group>
    </Stack>
  );

  const oneLine = (
    <Group position="apart" align="flex-start" noWrap>
      {modelText}
      <Group spacing={4} align="center" position="right">
        {modelBadges}
        {modelLikes}
        {modelComments}
        {modelDownloads}
      </Group>
    </Group>
  );

  const reportOption = (
    <LoginRedirect reason="report-model" key="report">
      <Menu.Item
        icon={<IconFlag size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();
          openContext('report', { entityType: ReportEntity.Model, entityId: id });
        }}
      >
        Report
      </Menu.Item>
    </LoginRedirect>
  );

  const blockTagsOption = (
    <Menu.Item
      key="block-tags"
      icon={<IconTagOff size={14} stroke={1.5} />}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        openContext('blockModelTags', { modelId: id });
      }}
    >
      {`Hide content with these tags`}
    </Menu.Item>
  );
  let contextMenuItems: React.ReactNode[] = [];
  if (currentUser?.id !== user.id)
    contextMenuItems = contextMenuItems.concat([
      <HideModelButton key="hide-model" as="menu-item" modelId={id} />,
      <HideUserButton key="hide-button" as="menu-item" userId={user.id} />,
      reportOption,
    ]);
  if (currentUser) contextMenuItems.splice(2, 0, blockTagsOption);

  const isNew = data.createdAt > aDayAgo;
  const isUpdated = !isNew && data.lastVersionAt && data.lastVersionAt > aDayAgo;

  return (
    <Link href={`/models/${id}/${slugit(name)}`} passHref>
      <a>
        <Indicator
          disabled={!isNew && !isUpdated}
          withBorder
          size={24}
          radius="sm"
          label={isNew ? 'New' : 'Updated'}
          color="red"
          styles={{ indicator: { zIndex: 10, transform: 'translate(5px,-5px) !important' } }}
          sx={{ opacity: isHidden ? 0.1 : undefined }}
        >
          <Card
            ref={ref}
            withBorder
            shadow="sm"
            className={classes.card}
            style={{ height: `${height}px` }}
            p={0}
            onClick={(e: React.MouseEvent<HTMLDivElement>) => {
              if (!(e.ctrlKey || e.metaKey) && e.button !== 1) setLoading(true);
            }}
          >
            {inView && (
              <>
                <LoadingOverlay visible={loading} zIndex={9} loaderProps={{ variant: 'dots' }} />
                <ImageGuard
                  images={[image]}
                  connect={{ entityId: id, entityType: 'model' }}
                  nsfw={nsfw ?? image.nsfw} // if the image is nsfw, then most/all of the model is nsfw
                  render={(image) => (
                    <Box sx={{ position: 'relative' }}>
                      {contextMenuItems.length > 0 && (
                        <Menu>
                          <Menu.Target>
                            <ActionIcon
                              variant="transparent"
                              p={0}
                              onClick={(e: React.MouseEvent) => {
                                e.preventDefault();
                                e.stopPropagation();
                              }}
                              sx={{
                                width: 30,
                                position: 'absolute',
                                top: 10,
                                right: 4,
                                zIndex: 8,
                              }}
                            >
                              <IconDotsVertical
                                size={24}
                                color="#fff"
                                style={{ filter: `drop-shadow(0 0 2px #000)` }}
                              />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            {contextMenuItems.map((el, index) => (
                              <React.Fragment key={index}>{el}</React.Fragment>
                            ))}
                          </Menu.Dropdown>
                        </Menu>
                      )}
                      <ImageGuard.ToggleConnect />
                      <ImageGuard.Unsafe>
                        <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                          <MediaHash {...image} />
                        </AspectRatio>
                      </ImageGuard.Unsafe>
                      <ImageGuard.Safe>
                        <EdgeImage
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          width={450}
                          placeholder="empty"
                          style={{ width: '100%', zIndex: 2, position: 'relative' }}
                        />
                      </ImageGuard.Safe>
                    </Box>
                  )}
                />
                <Box p="xs" className={classes.content}>
                  {onTwoLines ? twoLine : oneLine}
                </Box>
              </>
            )}
          </Card>
        </Indicator>
      </a>
    </Link>
  );
};

const useStyles = createStyles((theme) => {
  const base = theme.colors[getRandom(mantineColors)];
  const background = theme.colorScheme === 'dark' ? theme.colors.dark[6] : '#fff';

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
