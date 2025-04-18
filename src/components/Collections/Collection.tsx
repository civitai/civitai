import {
  ActionIcon,
  AspectRatio,
  Box,
  Button,
  Center,
  ContainerProps,
  createStyles,
  Divider,
  Group,
  HoverCard,
  Menu,
  Popover,
  Progress,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { CollectionItemStatus } from '@prisma/client';
import {
  IconAlertCircle,
  IconCirclePlus,
  IconCloudOff,
  IconDotsVertical,
  IconInfoCircle,
  IconPhoto,
} from '@tabler/icons-react';
import { capitalize, truncate } from 'lodash-es';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { CSSProperties, useState } from 'react';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleCategories } from '~/components/Article/Infinite/ArticleCategories';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import {
  contestCollectionReactionsHidden,
  isCollectionSubsmissionPeriod,
  useCollection,
  useCollectionEntryCount,
} from '~/components/Collections/collection.utils';
import { CollectionCategorySelect } from '~/components/Collections/components/CollectionCategorySelect';
import { CollectionContextMenu } from '~/components/Collections/components/CollectionContextMenu';
import { CollectionFollowAction } from '~/components/Collections/components/CollectionFollow';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { SortFilter } from '~/components/Filters';
import { AdaptiveFiltersDropdown } from '~/components/Filters/AdaptiveFiltersDropdown';
import { ImageContextMenuProvider } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { useImageQueryParams } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { RemoveFromCollectionMenuItem } from '~/components/MenuItems/RemoveFromCollectionMenuItem';
import { ModelContextMenuProvider } from '~/components/Model/Actions/ModelCardContextMenu';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { PostCategories } from '~/components/Post/Infinite/PostCategories';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { ToolMultiSelect } from '~/components/Tool/ToolMultiSelect';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ArticleSort, ImageSort, ModelSort, PostSort } from '~/server/common/enums';
import { CollectionContributorPermissionFlags } from '~/server/services/collection.service';
import {
  Availability,
  CollectionMode,
  CollectionType,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';
import { CollectionByIdModel } from '~/types/router';
import { getRandom } from '~/utils/array-helpers';
import { formatDate } from '~/utils/date-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { Meta } from '../Meta/Meta';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';

const AddUserContentModal = dynamic(() =>
  import('~/components/Collections/AddUserContentModal').then((x) => x.AddUserContentModal)
);

const ModelCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { set, ...query } = useModelQueryParams();
  const isContestCollection = collection.mode === CollectionMode.Contest;
  const sort = isContestCollection
    ? getRandom(Object.values(ModelSort))
    : query.sort ?? ModelSort.Newest;
  const currentUser = useCurrentUser();

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
        fromPlatform: undefined,
        fileFormats: undefined,
        sort,
        period: MetricTimeframe.AllTime,
        collectionId: collection.id,
        collectionTagId: query.collectionTagId,
      }
    : {
        ...query,
        sort,
        followed: undefined,
        hidden: undefined,
        favorites: undefined,
        collectionId: collection.id,
      };

  return (
    <ModelContextMenuProvider
      setMenuItems={(data, menuItems) => {
        const items = menuItems.filter((m) => m.key !== 'add-to-collection');
        const isOwnerOrMod =
          currentUser?.id === collection.user.id ||
          currentUser?.id === data.user.id ||
          currentUser?.isModerator;

        if (isOwnerOrMod) {
          items.push({
            key: 'remove-from-collection',
            component: (
              <RemoveFromCollectionMenuItem collectionId={collection.id} itemId={data.id} />
            ),
          });
        }
        return items.filter(isDefined);
      }}
    >
      <Stack spacing="xs">
        <IsClient>
          {!isContestCollection && (
            <>
              <Group position="right" spacing={4}>
                <SortFilter
                  type="models"
                  value={sort}
                  compact={false}
                  onChange={(x) => set({ sort: x as ModelSort })}
                />
                <ModelFiltersDropdown
                  filterMode="query"
                  maxPopoverHeight={'calc(75vh - var(--header-height))'}
                />
              </Group>
              <CategoryTags />
            </>
          )}
          {isContestCollection && collection.tags.length > 0 && (
            <CollectionCategorySelect
              collectionId={collection.id}
              value={query.collectionTagId?.toString() ?? 'all'}
              onChange={(x) =>
                set({ collectionTagId: x && x !== 'all' ? parseInt(x, 10) : undefined })
              }
            />
          )}
          <ModelsInfinite filters={filters} disableStoreFilters />
        </IsClient>
      </Stack>
    </ModelContextMenuProvider>
  );
};

const imageCollectionSortOptions = [ImageSort.Newest, ImageSort.Oldest];
const ImageCollection = ({
  collection,
  permissions,
}: {
  collection: NonNullable<CollectionByIdModel>;
  permissions?: CollectionContributorPermissionFlags;
}) => {
  const isContestCollection = collection.mode === CollectionMode.Contest;
  const { replace, query } = useImageQueryParams();
  const defaultSort =
    query.sort && imageCollectionSortOptions.includes(query.sort) ? query.sort : ImageSort.Newest;
  const sort = isContestCollection ? ImageSort.Random : defaultSort;
  const period = query.period ?? MetricTimeframe.AllTime;
  const updateCollectionCoverImageMutation = trpc.collection.updateCoverImage.useMutation();
  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();

  const [toolSearchOpened, setToolSearchOpened] = useState(false);

  // For contest collections, we need to keep the filters clean from outside intervention.
  const filters = isContestCollection
    ? {
        ...query,
        generation: undefined,
        view: undefined,
        hideAutoResources: undefined,
        hideManualResources: undefined,
        types: undefined,
        withMeta: undefined,
        hidden: undefined,
        followed: undefined,
        period: MetricTimeframe.AllTime,
        sort,
        collectionId: collection.id,
        collectionTagId: query.collectionTagId,
      }
    : {
        ...query,
        period,
        sort,
        collectionId: collection.id,
        hidden: undefined,
        followed: undefined,
      };

  return (
    <ImageContextMenuProvider
      additionalMenuItemsBefore={(image) => {
        const canUpdateCover = !permissions || !permissions.manage || !image.id;

        return (
          <>
            {canUpdateCover && (
              <Menu.Item
                icon={
                  // @ts-ignore: transparent variant actually works here.
                  <ThemeIcon color="pink.7" variant="transparent" size="xs">
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
            )}
          </>
        );
      }}
      additionalMenuItemsAfter={(image) => {
        const isOwnerOrMod =
          permissions?.manage || currentUser?.id === collection.user.id || currentUser?.isModerator;
        return (
          <>
            {isOwnerOrMod && (
              <RemoveFromCollectionMenuItem collectionId={collection.id} itemId={image.id} />
            )}
          </>
        );
      }}
    >
      <Stack spacing="xs">
        <IsClient>
          {!isContestCollection && (
            <>
              <Group position="right" spacing={4}>
                <SortFilter
                  type="images"
                  value={sort}
                  compact={false}
                  onChange={(x) => replace({ sort: x as ImageSort })}
                  options={imageCollectionSortOptions.map((x) => ({ label: x, value: x }))}
                />
                <MediaFiltersDropdown
                  filterType="images"
                  query={filters}
                  onChange={(value) => replace(value)}
                />
              </Group>
              <ImageCategories />
            </>
          )}

          {isContestCollection && collection.tags.length > 0 && (
            <CollectionCategorySelect
              collectionId={collection.id}
              value={query.collectionTagId?.toString() ?? 'all'}
              onChange={(x) =>
                replace({ collectionTagId: x && x !== 'all' ? parseInt(x, 10) : undefined })
              }
            />
          )}
          {isContestCollection && (
            <Group position="right">
              <AdaptiveFiltersDropdown
                // Small hack to make the dropdown visible when the dropdown is open
                dropdownProps={{ className: toolSearchOpened ? '!overflow-visible' : undefined }}
              >
                <Stack>
                  <Divider label="Tools" labelProps={{ weight: 'bold', size: 'sm' }} />
                  <ToolMultiSelect
                    value={query.tools ?? []}
                    onChange={(tools) => {
                      if (!tools || tools.length === 0) {
                        replace({ tools: undefined });
                      } else {
                        replace({ tools });
                      }
                    }}
                    placeholder="Created with..."
                    // Needed to hack the select dropdown to be visible when the dropdown is open
                    onDropdownOpen={() => setToolSearchOpened(true)}
                    onDropdownClose={() => setToolSearchOpened(false)}
                    grouped={false}
                  />
                </Stack>
              </AdaptiveFiltersDropdown>
            </Group>
          )}
          <ReactionSettingsProvider
            settings={{
              hideReactionCount: isContestCollection,
              hideReactions: contestCollectionReactionsHidden(collection),
            }}
          >
            <ImagesInfinite filters={filters} disableStoreFilters collectionId={collection.id} />
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
        draftOnly: undefined,
        followed: undefined,
      };

  // For contest collections, we need to keep the filters clean from outside intervention.
  return (
    <Stack spacing="xs">
      <IsClient>
        {!isContestCollection && (
          <>
            <Group position="right" spacing={4}>
              <SortFilter
                type="posts"
                value={sort}
                compact={false}
                onChange={(sort) => replace({ sort: sort as PostSort })}
              />
              <PostFiltersDropdown query={filters} onChange={(value) => replace(value)} />
            </Group>
            <PostCategories />
          </>
        )}
        <ReactionSettingsProvider settings={{ hideReactionCount: !isContestCollection }}>
          <PostsInfinite filters={filters} disableStoreFilters />
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
    ? {
        sort,
        period: MetricTimeframe.AllTime,
        collectionId: collection.id,
        followed: undefined,
        favorites: undefined,
        hidden: undefined,
      }
    : {
        ...query,
        sort,
        period,
        collectionId: collection.id,
        followed: undefined,
        favorites: undefined,
        hidden: undefined,
      };

  return (
    <Stack spacing="xs">
      <IsClient>
        {!isContestCollection && (
          <>
            <Group position="right" spacing={4}>
              <SortFilter
                type="articles"
                value={sort}
                compact={false}
                onChange={(x) => replace({ sort: x as ArticleSort })}
              />
              <ArticleFiltersDropdown query={filters} onChange={(value) => replace(value)} />
            </Group>
            <ArticleCategories />
          </>
        )}
        <ArticlesInfinite filters={filters} disableStoreFilters />
      </IsClient>
    </Stack>
  );
};

export function Collection({
  collectionId,
  ...containerProps
}: { collectionId: number } & Omit<ContainerProps, 'children'>) {
  const router = useRouter();

  const currentUser = useCurrentUser();
  const { collection, permissions, isLoading } = useCollection(collectionId);
  const { data: entryCountDetails } = useCollectionEntryCount(collectionId, {
    enabled:
      !!currentUser?.id &&
      collection?.mode === CollectionMode.Contest &&
      !!collection?.metadata?.maxItemsPerUser,
  });

  const { classes } = useStyles({ bannerPosition: collection?.metadata?.bannerPosition });
  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === collection?.user.id);

  if (!isLoading && (!collection || isBlocked)) {
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

  if (!collection) return null;

  return (
    <BrowsingLevelProvider browsingLevel={collection.metadata.forcedBrowsingLevel ?? undefined}>
      <BrowsingSettingsAddonsProvider>
        {collection && (
          <Meta
            title={`${collection.name} - collection posted by ${collection.user.username}`}
            description={
              collection.description
                ? truncate(removeTags(collection.description), { length: 150 })
                : ''
            }
            images={collection.image}
            deIndex={
              collection.read !== 'Public' || collection.availability === Availability.Unsearchable
            }
          />
        )}
        <SensitiveShield
          contentNsfwLevel={collection.metadata.forcedBrowsingLevel || collection.nsfwLevel}
        >
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
                          <CustomMarkdown
                            rehypePlugins={[rehypeRaw, remarkGfm]}
                            allowedElements={['a', 'p', 'strong', 'em', 'code', 'u']}
                            unwrapDisallowed
                          >
                            {collection.description}
                          </CustomMarkdown>
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
                    <Stack>
                      <Group spacing={4} ml="auto" sx={{ alignSelf: 'flex-start' }} noWrap>
                        {collection.mode === CollectionMode.Contest &&
                        // Respect the submission period:
                        (!metadata.submissionEndDate ||
                          new Date(metadata.submissionEndDate) > new Date()) &&
                        (!metadata.submissionStartDate ||
                          new Date(metadata.submissionStartDate) < new Date()) &&
                        [CollectionType.Image, CollectionType.Post].some(
                          (x) => x === collection.type
                        ) ? (
                          <HoverCard
                            width={300}
                            disabled={!currentUser?.meta?.contestBanDetails}
                            withArrow
                            withinPortal
                          >
                            <HoverCard.Target>
                              {/* Required div to display hovercard even when button is disabled */}
                              <div>
                                <Button
                                  color="blue"
                                  radius="xl"
                                  disabled={!!currentUser?.meta?.contestBanDetails}
                                  onClick={() => {
                                    if (currentUser?.meta?.contestBanDetails) {
                                      return;
                                    }

                                    if (
                                      !!metadata.existingEntriesDisabled ||
                                      collection.type === CollectionType.Post
                                    ) {
                                      router.push(`/posts/create?collectionId=${collection.id}`);
                                    } else {
                                      dialogStore.trigger({
                                        component: AddUserContentModal,
                                        props: {
                                          collectionId: collection.id,
                                        },
                                      });
                                    }
                                  }}
                                >
                                  Submit an entry
                                </Button>
                              </div>
                            </HoverCard.Target>
                            <HoverCard.Dropdown px="md" py={8}>
                              {currentUser?.meta?.contestBanDetails && (
                                <Text>
                                  Due to breaking the rules in the past, you are ineligible for
                                  participation in this event.
                                </Text>
                              )}
                            </HoverCard.Dropdown>
                          </HoverCard>
                        ) : (
                          <>
                            <CollectionFollowAction
                              collectionId={collection.id}
                              permissions={permissions}
                            />
                            {canAddContent && (
                              <Tooltip label="Add from your library." position="bottom" withArrow>
                                <ActionIcon
                                  color="blue"
                                  variant="subtle"
                                  radius="xl"
                                  onClick={() => {
                                    if (!!metadata.existingEntriesDisabled) {
                                      router.push(`/posts/create?collectionId=${collection.id}`);
                                    } else {
                                      dialogStore.trigger({
                                        component: AddUserContentModal,
                                        props: {
                                          collectionId: collection.id,
                                        },
                                      });
                                    }
                                  }}
                                >
                                  <IconCirclePlus />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </>
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
                      {entryCountDetails?.max &&
                        (() => {
                          const statuses = [
                            CollectionItemStatus.REJECTED,
                            CollectionItemStatus.REVIEW,
                            CollectionItemStatus.ACCEPTED,
                          ];
                          const totalEntries =
                            (entryCountDetails[CollectionItemStatus.REJECTED] ?? 0) +
                            entryCountDetails.max;
                          const remainingEntries =
                            entryCountDetails.max -
                            // We only count review/accepted
                            [CollectionItemStatus.ACCEPTED, CollectionItemStatus.REVIEW].reduce(
                              // Sum all statuses
                              (acc, status) => acc + (entryCountDetails[status] ?? 0),
                              0
                            );

                          return (
                            <Stack spacing={0}>
                              <Progress
                                size="xl"
                                sections={[
                                  ...statuses.map((status) => {
                                    const color =
                                      status === CollectionItemStatus.REVIEW
                                        ? 'blue'
                                        : status === CollectionItemStatus.ACCEPTED
                                        ? 'green'
                                        : 'red';

                                    const label = capitalize(status.toLowerCase());
                                    const entryCount = entryCountDetails[status];

                                    return entryCount
                                      ? {
                                          value: (entryCount / totalEntries) * 100,
                                          color,
                                          // label,
                                          tooltip: `${label}: ${entryCountDetails[status]}`,
                                        }
                                      : undefined;
                                  }),
                                  remainingEntries > 0
                                    ? {
                                        value: (remainingEntries / totalEntries) * 100,
                                        color: 'gray',
                                        // label: 'Remaining',
                                        tooltip: `Remaining: ${remainingEntries}`,
                                      }
                                    : undefined,
                                ].filter(isDefined)}
                              />
                              <Tooltip label="Rejected entries do not count toward the allowed count.">
                                <Text size="xs" weight="bold">
                                  Max entries per participant: {entryCountDetails.max}
                                </Text>
                              </Tooltip>
                            </Stack>
                          );
                        })()}
                    </Stack>
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
                          {formatDate(metadata.submissionEndDate)}.{' '}
                          {metadata.submissionsHiddenUntilEndDate ? (
                            <>
                              You will only be able to see your own entries until the submission
                              period is over.
                            </>
                          ) : (
                            <>
                              Entries that have been approved will be visible to the public. Entries
                              under review are only visible to the owner.
                            </>
                          )}
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
      </BrowsingSettingsAddonsProvider>
    </BrowsingLevelProvider>
  );
}

const useStyles = createStyles<string, { bannerPosition?: CSSProperties['objectPosition'] }>(
  (_theme, params) => ({
    coverImage: {
      objectPosition: params.bannerPosition ?? 'top center',
    },
  })
);
