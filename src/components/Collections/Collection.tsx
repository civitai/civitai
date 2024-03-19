import {
  ActionIcon,
  AspectRatio,
  Box,
  Center,
  ContainerProps,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  createStyles,
  Menu,
  Popover,
} from '@mantine/core';
import { Availability, CollectionMode, CollectionType, MetricTimeframe } from '@prisma/client';
import {
  IconAlertCircle,
  IconCirclePlus,
  IconCloudOff,
  IconDotsVertical,
  IconInfoCircle,
  IconPhoto,
} from '@tabler/icons-react';
import React, { useState } from 'react';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { AddUserContentModal } from '~/components/Collections/AddUserContentModal';
import { CollectionContextMenu } from '~/components/Collections/components/CollectionContextMenu';
import { CollectionFollowAction } from '~/components/Collections/components/CollectionFollow';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { constants } from '~/server/common/constants';
import { CollectionByIdModel } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { ArticleSort, ImageSort, ModelSort, PostSort } from '~/server/common/enums';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { PostCategories } from '~/components/Post/Infinite/PostCategories';
import { ArticleCategories } from '~/components/Article/Infinite/ArticleCategories';
import { CollectionContributorPermissionFlags } from '~/server/services/collection.service';
import { showSuccessNotification } from '~/utils/notifications';
import { Meta } from '../Meta/Meta';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { getRandom } from '~/utils/array-helpers';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { formatDate } from '~/utils/date-helpers';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { isCollectionSubsmissionPeriod } from '~/components/Collections/collection.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { truncate } from 'lodash-es';
import { ImageContextMenuProvider } from '~/components/Image/ContextMenu/ImageContextMenu';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

const ModelCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { set, ...query } = useModelQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const isContestCollection = collection.mode === CollectionMode.Contest;
  const sort = isContestCollection
    ? getRandom(Object.values(ModelSort))
    : query.sort ?? ModelSort.Newest;

  // For contest collections, we need to keep the filters clean from outside intervention.
  const filters = isContestCollection
    ? {
        types: undefined,
        checkpointType: undefined,
        baseModels: undefined,
        browsingMode: undefined,
        status: undefined,
        earlyAccess: undefined,
        view: undefined,
        supportsGeneration: undefined,
        followed: undefined,
        hidden: undefined,
        sort,
        period: MetricTimeframe.AllTime,
        collectionId: collection.id,
      }
    : {
        ...query,
        sort,
        followed: undefined,
        hidden: undefined,
        period: MetricTimeframe.AllTime,
        collectionId: collection.id,
      };

  return (
    <Stack spacing="xs">
      <IsClient>
        {!isContestCollection && (
          <>
            <Group position="apart" spacing={0}>
              <SortFilter
                type="models"
                value={sort}
                onChange={(x) => set({ sort: x as ModelSort })}
              />
              <Group spacing="xs">
                <ModelFiltersDropdown />
              </Group>
            </Group>
            <CategoryTags />
          </>
        )}
        <ModelsInfinite
          filters={{
            // For contest collections, we should always have a clean slate.
            ...filters,
          }}
        />
      </IsClient>
    </Stack>
  );
};

const ImageCollection = ({
  collection,
  permissions,
}: {
  collection: NonNullable<CollectionByIdModel>;
  permissions?: CollectionContributorPermissionFlags;
}) => {
  const isContestCollection = collection.mode === CollectionMode.Contest;
  const { replace, query } = useImageQueryParams();
  const sort = isContestCollection ? ImageSort.Random : query.sort ?? ImageSort.Newest;
  const period = query.period ?? MetricTimeframe.AllTime;
  const updateCollectionCoverImageMutation = trpc.collection.updateCoverImage.useMutation();
  const utils = trpc.useContext();

  // For contest collections, we need to keep the filters clean from outside intervention.
  const filters = isContestCollection
    ? {
        generation: undefined,
        view: undefined,
        excludeCrossPosts: undefined,
        types: undefined,
        withMeta: undefined,
        hidden: undefined,
        followed: undefined,
        period: MetricTimeframe.AllTime,
        sort,
        collectionId: collection.id,
      }
    : {
        ...query,
        period,
        sort,
        collectionId: collection.id,
      };

  return (
    <ImageContextMenuProvider
      additionalMenuItemsBefore={(image) => {
        if (!permissions || !permissions.manage || !image.id) return null;
        return (
          <Menu.Item
            icon={
              // @ts-ignore: transparent variant actually works here.
              <ThemeIcon color="pink.7" variant="transparent" size="sm">
                <IconPhoto size={16} stroke={1.5} />
              </ThemeIcon>
            }
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              updateCollectionCoverImageMutation.mutate(
                {
                  id: collection.id,
                  imageId: image.id,
                },
                {
                  onSuccess: async () => {
                    showSuccessNotification({
                      title: 'Cover image updated',
                      message: 'Collection cover image has been updated',
                    });
                    await utils.collection.getById.invalidate({ id: collection.id });
                  },
                }
              );
            }}
          >
            Use as cover image
          </Menu.Item>
        );
      }}
    >
      <Stack spacing="xs">
        <IsClient>
          {!isContestCollection && (
            <>
              <Group position="apart" spacing={0}>
                <SortFilter
                  type="images"
                  value={sort}
                  onChange={(x) => replace({ sort: x as ImageSort })}
                />
                <PeriodFilter
                  type="images"
                  value={period}
                  onChange={(x) => replace({ period: x })}
                />
              </Group>
              <ImageCategories />
            </>
          )}
          <ReactionSettingsProvider settings={{ hideReactionCount: isContestCollection }}>
            <ImagesInfinite
              filters={{
                ...filters,
                sort,
                collectionId: collection.id,
                types: undefined,
                hidden: undefined,
                withMeta: undefined,
                followed: undefined,
              }}
            />
          </ReactionSettingsProvider>
        </IsClient>
      </Stack>
    </ImageContextMenuProvider>
  );
};
const PostCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { replace, query } = usePostQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const isContestCollection = collection.mode === CollectionMode.Contest;
  const sort = isContestCollection
    ? getRandom(Object.values(PostSort))
    : query.sort ?? PostSort.Newest;

  const filters = isContestCollection
    ? {
        modelId: undefined,
        modelVersionId: undefined, // not hooked up to service/schema yet
        tags: undefined,
        username: undefined,
        draftOnly: undefined,
        followed: undefined,
        sort,
        period: MetricTimeframe.AllTime,
        collectionId: collection.id,
      }
    : {
        ...query,
        period,
        sort,
        collectionId: collection.id,
      };

  // For contest collections, we need to keep the filters clean from outside intervention.
  return (
    <Stack spacing="xs">
      <IsClient>
        {!isContestCollection && (
          <>
            <Group position="apart" spacing={0}>
              <SortFilter
                type="posts"
                value={sort}
                onChange={(sort) => replace({ sort: sort as any })}
              />
              <PeriodFilter
                type="posts"
                value={period}
                onChange={(period) => replace({ period })}
              />
            </Group>
            <PostCategories />
          </>
        )}
        <ReactionSettingsProvider settings={{ hideReactionCount: !isContestCollection }}>
          <PostsInfinite
            filters={{
              ...filters,
              sort,
              collectionId: collection.id,
            }}
          />
        </ReactionSettingsProvider>
      </IsClient>
    </Stack>
  );
};

const ArticleCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { replace, query } = useArticleQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const isContestCollection = collection.mode === CollectionMode.Contest;
  const sort = isContestCollection
    ? getRandom(Object.values(ArticleSort))
    : query.sort ?? ArticleSort.Newest;

  // For contest collections, we need to keep the filters clean from outside intervention.
  const filters = isContestCollection
    ? { sort, period: MetricTimeframe.AllTime, followed: false, collectionId: collection.id }
    : {
        ...query,
        sort,
        period,
        collectionId: collection.id,
      };

  return (
    <Stack spacing="xs">
      <IsClient>
        {!isContestCollection && (
          <>
            <Group position="apart" spacing={0}>
              <SortFilter
                type="articles"
                value={sort}
                onChange={(x) => replace({ sort: x as ArticleSort })}
              />
              <PeriodFilter
                type="articles"
                value={period}
                onChange={(x) => replace({ period: x })}
              />
            </Group>
            <ArticleCategories />
          </>
        )}
        <ArticlesInfinite
          filters={{
            ...filters,
            sort,
            collectionId: collection.id,
          }}
        />
      </IsClient>
    </Stack>
  );
};

export function Collection({
  collectionId,
  ...containerProps
}: { collectionId: number } & Omit<ContainerProps, 'children'>) {
  const { classes } = useStyles();
  const [opened, setOpened] = useState(false);
  const currentUser = useCurrentUser();

  const { data: { collection, permissions } = {}, isLoading } = trpc.collection.getById.useQuery({
    id: collectionId,
  });

  if (!isLoading && !collection) {
    return (
      <Stack w="100%" align="center">
        <Stack spacing="md" align="center" maw={800}>
          <Title order={1} inline>
            Whoops!
          </Title>
          <Text align="center">
            It looks like you landed on the wrong place.The collection you are trying to access does
            not exist or you do not have the sufficient permissions to see it.
          </Text>
          <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
            <IconCloudOff size={80} />
          </ThemeIcon>
        </Stack>
      </Stack>
    );
  }

  const collectionType = collection?.type;
  // TODO.collections: This is tied to images for now but
  // we will need to add a check for other resources later
  const metadata = collection?.metadata ?? {};
  const canAddContent =
    collectionType === CollectionType.Image &&
    (permissions?.write || permissions?.writeReview) &&
    (!metadata.submissionStartDate || new Date(metadata.submissionStartDate) < new Date()) &&
    (!metadata.submissionEndDate || new Date(metadata.submissionEndDate) > new Date());

  const submissionPeriod =
    metadata.submissionStartDate || metadata.submissionEndDate || metadata.maxItemsPerUser ? (
      <Popover
        zIndex={200}
        position="bottom-end"
        shadow="md"
        radius={12}
        onClose={() => setOpened(false)}
        middlewares={{ flip: true, shift: true }}
      >
        <Popover.Target>
          <ActionIcon variant="transparent" size="lg">
            <IconInfoCircle />
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown maw={468} p="md" w="100%">
          <Stack spacing="xs">
            {metadata.submissionStartDate && (
              <Text size="sm">
                Submission start date: {formatDate(metadata.submissionStartDate)}
              </Text>
            )}
            {metadata.submissionEndDate && (
              <Text size="sm">Submission end date: {formatDate(metadata.submissionEndDate)}</Text>
            )}

            {metadata.maxItemsPerUser && (
              <Text size="sm">Max items per user: {metadata.maxItemsPerUser}</Text>
            )}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    ) : null;

  const nsfw = collection ? !getIsSafeBrowsingLevel(collection.nsfwLevel) : false;

  return (
    <>
      {collection && (
        <Meta
          title={`${collection.name} - collection posted by ${collection.user.username}`}
          description={collection.description ?? undefined}
          images={collection.image}
          deIndex={
            collection.read !== 'Public' || collection.availability === Availability.Unsearchable
          }
        />
      )}
      <SensitiveShield enabled={nsfw && !currentUser}>
        <MasonryProvider
          columnWidth={constants.cardSizes.model}
          maxColumnCount={7}
          maxSingleColumnWidth={450}
        >
          <MasonryContainer {...containerProps} p={0}>
            <Stack spacing="xl" w="100%">
              <Group spacing="xl">
                {collection?.image && (
                  <Box
                    w={220}
                    sx={(theme) => ({
                      overflow: 'hidden',
                      borderRadius: '8px',
                      boxShadow: theme.shadows.md,
                      [containerQuery.smallerThan('sm')]: {
                        width: '100%',
                        marginBottom: theme.spacing.xs,
                      },
                    })}
                  >
                    <AspectRatio ratio={3 / 2}>
                      <EdgeMedia
                        className={classes.coverImage}
                        src={collection.image.url}
                        type={collection.image.type}
                        name={collection.image.name ?? collection.image.url}
                        alt={
                          collection.image.meta
                            ? truncate(collection.image.meta.prompt, {
                                length: constants.altTruncateLength,
                              })
                            : collection.image.name ?? undefined
                        }
                        width={collection.image.width ?? 1200}
                        loading="lazy"
                      />
                    </AspectRatio>
                  </Box>
                )}
                <Stack spacing={8} sx={{ flex: 1 }}>
                  <Stack spacing={0}>
                    <Group>
                      <Title
                        order={1}
                        lineClamp={1}
                        sx={() => ({
                          [containerQuery.smallerThan('sm')]: {
                            fontSize: '28px',
                          },
                        })}
                      >
                        {collection?.name ?? 'Loading...'}
                      </Title>
                      {submissionPeriod}
                    </Group>
                    {collection?.description && (
                      <Text size="xs" color="dimmed">
                        <ReactMarkdown
                          rehypePlugins={[rehypeRaw, remarkGfm]}
                          allowedElements={['a', 'p', 'strong', 'em', 'code', 'u']}
                          unwrapDisallowed
                          className="markdown-content"
                        >
                          {collection.description}
                        </ReactMarkdown>
                      </Text>
                    )}
                  </Stack>
                  {collection && (
                    <Group spacing={4} noWrap>
                      {collection.user.id !== -1 && (
                        <UserAvatar user={collection.user} withUsername linkToProfile />
                      )}
                      {/* TODO.collections: We need some metrics to actually display these badges */}
                      {/* <IconBadge className={classes.iconBadge} icon={<IconLayoutGrid size={14} />}>
                      <Text size="xs">{abbreviateNumber(data._count.items)}</Text>
                    </IconBadge>
                    <IconBadge className={classes.iconBadge} icon={<IconUser size={14} />}>
                      <Text size="xs">{abbreviateNumber(data._count.contributors)}</Text>
                    </IconBadge> */}
                    </Group>
                  )}
                </Stack>
                {collection && permissions && (
                  <Group spacing={4} ml="auto" sx={{ alignSelf: 'flex-start' }} noWrap>
                    <CollectionFollowAction collection={collection} permissions={permissions} />
                    {canAddContent && (
                      <Tooltip label="Add from your library." position="bottom" withArrow>
                        <ActionIcon
                          color="blue"
                          variant="subtle"
                          radius="xl"
                          onClick={() => setOpened(true)}
                        >
                          <IconCirclePlus />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    <CollectionContextMenu
                      collectionId={collection.id}
                      ownerId={collection.user.id}
                      permissions={permissions}
                      mode={collection.mode}
                    >
                      <ActionIcon variant="subtle">
                        <IconDotsVertical size={16} />
                      </ActionIcon>
                    </CollectionContextMenu>
                  </Group>
                )}
              </Group>
              {metadata.submissionStartDate &&
              new Date(metadata.submissionStartDate) > new Date() ? (
                <AlertWithIcon icon={<IconAlertCircle />}>
                  <Text>
                    This collection is not accepting entries just yet. Please come back after{' '}
                    {formatDate(metadata.submissionStartDate)}
                  </Text>
                </AlertWithIcon>
              ) : (
                <>
                  {isCollectionSubsmissionPeriod(collection) && (
                    <AlertWithIcon icon={<IconAlertCircle />}>
                      <Text>
                        This collection is accepting entries until{' '}
                        {formatDate(metadata.submissionEndDate)}. During the subsmission period, you
                        will only see your entries, both reviewed and unreviewed. Once the
                        submission period ends, you will see all entries.
                      </Text>
                    </AlertWithIcon>
                  )}
                  {collection && collectionType === CollectionType.Model && (
                    <ModelCollection collection={collection} />
                  )}
                  {collection && collectionType === CollectionType.Image && (
                    <ImageCollection collection={collection} permissions={permissions} />
                  )}
                  {collection && collectionType === CollectionType.Post && (
                    <PostCollection collection={collection} />
                  )}
                  {collection && collectionType === CollectionType.Article && (
                    <ArticleCollection collection={collection} />
                  )}
                </>
              )}
              {!collectionType && !isLoading && (
                <Center py="xl">
                  <Stack spacing="xs">
                    <Text size="lg" weight="700" align="center">
                      Whoops!
                    </Text>
                    <Text align="center">This collection type is not supported</Text>
                  </Stack>
                </Center>
              )}
            </Stack>
          </MasonryContainer>
        </MasonryProvider>
      </SensitiveShield>
      {collection && canAddContent && (
        <AddUserContentModal
          collectionId={collection.id}
          opened={opened}
          onClose={() => setOpened(false)}
        />
      )}
    </>
  );
}

const useStyles = createStyles(() => ({
  coverImage: {
    objectPosition: 'top center',
  },
}));
