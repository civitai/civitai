import type { ContainerProps } from '@mantine/core';
import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  Button,
  Center,
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
  useMantineTheme,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCirclePlus,
  IconCloudOff,
  IconDotsVertical,
  IconInbox,
  IconInfoCircle,
  IconLock,
  IconPhoto,
} from '@tabler/icons-react';
import { capitalize, truncate } from 'lodash-es';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import {
  contestCollectionReactionsHidden,
  isCollectionSubsmissionPeriod,
  useCollection,
  useCollectionEntryCount,
} from '~/components/Collections/collection.utils';
import {
  articleCollectionSortOptions,
  contestArticleSorts,
  contestModelSorts,
  contestPostSorts,
  imageCollectionSortOptions,
  modelCollectionSortOptions,
  postCollectionSortOptions,
  resolveImageCollectionSort,
  toSortMenuOptions,
} from '~/components/Collections/collection-sort';
import { CollectionInvitePrompt } from '~/components/Collections/CollectionCollaborators/CollectionInvitePrompt';
import { usePendingInviteFor } from '~/components/Collections/CollectionCollaborators/collectionInvite.util';
import { CollectionCollaboratorsSummary } from '~/components/Collections/CollectionCollaboratorsSummary';
import { CollectionCategorySelect } from '~/components/Collections/components/CollectionCategorySelect';
import { CollectionContextMenu } from '~/components/Collections/components/CollectionContextMenu';
import { CollectionFollowAction } from '~/components/Collections/components/CollectionFollow';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { SortFilter } from '~/components/Filters';
import { AdaptiveFiltersDropdown } from '~/components/Filters/AdaptiveFiltersDropdown';
import { ImageContextMenuProvider } from '~/components/Image/ContextMenu/ImageContextMenuProvider';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { useUpdateCollectionCoverImage } from '~/components/Image/hooks/useUpdateCollectionCoverImage';
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
import { NextLink } from '~/components/NextLink/NextLink';
import { PostFiltersDropdown } from '~/components/Post/Infinite/PostFiltersDropdown';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { ToolMultiSelect } from '~/components/Tool/ToolMultiSelect';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ArticleSort, ImageSort, ModelSort, PostSort } from '~/server/common/enums';
import type { CollectionContributorPermissionFlags } from '~/server/services/collection.service';
import {
  Availability,
  CollectionItemStatus,
  CollectionMode,
  CollectionType,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';
import type { CollectionByIdModel } from '~/types/router';
import { getRandom } from '~/utils/array-helpers';
import { formatDate } from '~/utils/date-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeTags } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { Gated } from '~/components/Gated/Gated';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';
import classes from './Collection.module.scss';

const AddUserContentModal = dynamic(() =>
  import('~/components/Collections/AddUserContentModal').then((x) => x.AddUserContentModal)
);

const ModelCollection = ({
  collection,
  permissions,
}: {
  collection: NonNullable<CollectionByIdModel>;
  permissions?: CollectionContributorPermissionFlags;
}) => {
  const { set, ...query } = useModelQueryParams();
  const isContestCollection = collection.mode === CollectionMode.Contest;
  const sort = isContestCollection
    ? getRandom(contestModelSorts)
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
        // Same rule the image collection uses, and the same one the server enforces — a Manager
        // could not remove anything here while being able to on an image collection.
        const canRemove =
          permissions?.manage ||
          currentUser?.id === collection.user.id ||
          currentUser?.id === data.user.id ||
          currentUser?.isModerator;

        if (canRemove) {
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
      <Stack gap="xs">
        <IsClient>
          {!isContestCollection && (
            <>
              <Group justify="flex-end" gap={4}>
                <SortFilter
                  type="models"
                  value={sort}
                  onChange={(x) => set({ sort: x as ModelSort })}
                  options={toSortMenuOptions(modelCollectionSortOptions)}
                />
                <ModelFiltersDropdown
                  filterMode="query"
                  maxPopoverHeight={'calc(75vh - var(--header-height))'}
                />
              </Group>
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

const ImageCollection = ({
  collection,
  permissions,
}: {
  collection: NonNullable<CollectionByIdModel>;
  permissions?: CollectionContributorPermissionFlags;
}) => {
  const isContestCollection = collection.mode === CollectionMode.Contest;
  const { replace, query } = useImageQueryParams();
  const sort = resolveImageCollectionSort({
    querySort: query.sort,
    isContest: isContestCollection,
  });
  const period = query.period ?? MetricTimeframe.AllTime;
  const updateCollectionCoverImage = useUpdateCollectionCoverImage();
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
        const canUpdateCover = !!permissions?.manage && !!image.id;

        return (
          <>
            {canUpdateCover && (
              <Menu.Item
                leftSection={
                  <ThemeIcon color="pink.7" variant="transparent" size="xs">
                    <IconPhoto size={16} stroke={1.5} />
                  </ThemeIcon>
                }
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  updateCollectionCoverImage({
                    collectionId: collection.id,
                    imageId: image.id,
                  });
                }}
              >
                Use as cover image
              </Menu.Item>
            )}
          </>
        );
      }}
      additionalMenuItemsAfter={(image) => {
        // Mirrors `removeCollectionItem`: a manage holder, the collection owner, a moderator, the
        // image's author, or whoever put it in the collection.
        const canRemove =
          permissions?.manage ||
          currentUser?.id === collection.user.id ||
          currentUser?.isModerator ||
          currentUser?.id === (image.userId ?? image.user?.id) ||
          currentUser?.id === image.collectionItemAddedById;
        return (
          <>
            {canRemove && (
              <RemoveFromCollectionMenuItem collectionId={collection.id} itemId={image.id} />
            )}
          </>
        );
      }}
    >
      <Stack gap="xs">
        <IsClient>
          {!isContestCollection && (
            <>
              <Group justify="flex-end" gap={4}>
                <SortFilter
                  type="images"
                  value={sort}
                  onChange={(x) => replace({ sort: x as ImageSort })}
                  options={toSortMenuOptions(imageCollectionSortOptions)}
                  ignoreNsfwLevel
                />
                <MediaFiltersDropdown
                  filterType="images"
                  query={filters}
                  onChange={(value) => replace(value)}
                />
              </Group>
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
            <Group justify="flex-end">
              <AdaptiveFiltersDropdown
                // Small hack to make the dropdown visible when the dropdown is open
                dropdownProps={{ className: toolSearchOpened ? '!overflow-visible' : undefined }}
              >
                <Stack>
                  <Divider label="Tools" className="text-sm font-bold" />
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
    ? getRandom(contestPostSorts)
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
    <Stack gap="xs">
      <IsClient>
        {!isContestCollection && (
          <>
            <Group justify="flex-end" gap={4}>
              <SortFilter
                type="posts"
                value={sort}
                onChange={(sort) => replace({ sort: sort as PostSort })}
                options={toSortMenuOptions(postCollectionSortOptions)}
              />
              <PostFiltersDropdown query={filters} onChange={(value) => replace(value)} />
            </Group>
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
    ? getRandom(contestArticleSorts)
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
    <Stack gap="xs">
      <IsClient>
        {!isContestCollection && (
          <>
            <Group justify="flex-end" gap={4}>
              <SortFilter
                type="articles"
                value={sort}
                onChange={(x) => replace({ sort: x as ArticleSort })}
                options={toSortMenuOptions(articleCollectionSortOptions)}
              />
              <ArticleFiltersDropdown query={filters} onChange={(value) => replace(value)} />
            </Group>
          </>
        )}
        <ArticlesInfinite filters={filters} disableStoreFilters />
      </IsClient>
    </Stack>
  );
};

function CollectionSubmissionsClosedNotice({ isOwner }: { isOwner: boolean }) {
  return (
    <Stack gap={4} maw={280} ml="auto">
      <Group gap={6} wrap="nowrap">
        <IconLock size={14} style={{ flexShrink: 0 }} />
        <Text size="sm" fw={600}>
          {isOwner ? 'Your collection has stopped accepting entries' : 'Not accepting entries'}
        </Text>
      </Group>
      <Text size="xs" c="dimmed">
        {isOwner
          ? "Submissions are paused because your membership isn't active. Everything you've already collected is safe, and your collaborators keep their access — you just can't take in new entries until you renew."
          : "This collection isn't accepting new entries right now."}
      </Text>
      {isOwner && (
        <Button
          component={NextLink}
          href="/pricing"
          size="xs"
          radius="xl"
          style={{ alignSelf: 'flex-start' }}
        >
          Renew membership
        </Button>
      )}
    </Stack>
  );
}

export function Collection({
  collectionId,
  ...containerProps
}: { collectionId: number } & Omit<ContainerProps, 'children'>) {
  const router = useRouter();
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const { collection, permissions, collaborators, pendingReviewCount, isLoading } =
    useCollection(collectionId);
  const { data: entryCountDetails } = useCollectionEntryCount(collectionId, {
    enabled:
      !!currentUser?.id &&
      collection?.mode === CollectionMode.Contest &&
      !!collection?.metadata?.maxItemsPerUser,
  });

  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === collection?.user.id);
  const pendingInvite = usePendingInviteFor(collectionId);

  if (!isLoading && (!collection || isBlocked)) {
    // An invitee to a private collection has no permission on it until they accept, and the
    // invite notification links here — so answering it is the only useful thing this page can
    // offer them.
    if (pendingInvite && !isBlocked) {
      return (
        <Stack w="100%" align="center">
          <Stack gap="md" align="center" maw={800} w="100%">
            <Title order={1} className="inline-block">
              You&apos;ve been invited
            </Title>
            <Text className="text-center">
              Accept this invitation to open the collection and start adding to it.
            </Text>
            <CollectionInvitePrompt collectionId={collectionId} />
          </Stack>
        </Stack>
      );
    }

    return (
      <Stack w="100%" align="center">
        <Stack gap="md" align="center" maw={800}>
          <Title order={1} className="inline-block">
            Whoops!
          </Title>
          <Text className="text-center">
            It looks like you landed on the wrong place.The collection you are trying to access does
            not exist or you do not have the sufficient permissions to see it.
          </Text>
          <ThemeIcon size={128} radius={100} style={{ opacity: 0.5 }}>
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
  // The lapse stops growth, not operation: the server keeps write for the owner and for
  // elevated collaborators, so anyone who still holds it keeps their add control. The owner
  // still gets the notice — it carries their renew CTA — while a collaborator whose access is
  // untouched gets nothing rather than a "not accepting entries" line next to a live button.
  const submissionsClosed =
    !!permissions?.collaborationDisabled && !permissions?.write && !permissions?.writeReview;
  const showSubmissionsClosedNotice =
    !!permissions?.collaborationDisabled && (submissionsClosed || !!permissions?.isOwner);
  // Open collections get the same entry point contests have always had. Without it the only way
  // in was the save picker on someone else's model or image page, so a collection asking for
  // submissions had no way to accept one from its own page.
  const canSubmitEntry =
    collection?.mode !== CollectionMode.Contest &&
    !permissions?.isOwner &&
    !submissionsClosed &&
    (permissions?.write || permissions?.writeReview) &&
    (collectionType === CollectionType.Image || collectionType === CollectionType.Post) &&
    (!metadata.submissionStartDate || new Date(metadata.submissionStartDate) < new Date()) &&
    (!metadata.submissionEndDate || new Date(metadata.submissionEndDate) > new Date());

  // validateContestCollectionEntry applies the base-model list to model entries only, so on any
  // other collection type a stored value advertises a restriction nothing enforces.
  const showAllowedBaseModels =
    !!metadata.baseModels?.length &&
    (collectionType ?? CollectionType.Model) === CollectionType.Model;

  const submissionPeriod =
    metadata.submissionStartDate ||
    metadata.submissionEndDate ||
    metadata.maxItemsPerUser ||
    showAllowedBaseModels ? (
      <Popover
        zIndex={200}
        position="bottom-end"
        shadow="md"
        radius={12}
        middlewares={{ flip: true, shift: true }}
      >
        <Popover.Target>
          <LegacyActionIcon variant="transparent" size="lg">
            <IconInfoCircle />
          </LegacyActionIcon>
        </Popover.Target>
        <Popover.Dropdown maw={468} p="md" w="100%">
          <Stack gap="xs">
            {metadata.submissionStartDate && (
              <Text size="sm">
                Submission start date:{' '}
                {formatDate(metadata.submissionStartDate, 'MMM D, YYYY h:mma')}
              </Text>
            )}
            {metadata.submissionEndDate && (
              <Text size="sm">
                Submission end date: {formatDate(metadata.submissionEndDate, 'MMM D, YYYY h:mma')}
              </Text>
            )}

            {metadata.maxItemsPerUser && (
              <Text size="sm">Max items per user: {metadata.maxItemsPerUser}</Text>
            )}

            {showAllowedBaseModels && (
              <Text size="sm">Allowed base models: {metadata.baseModels?.join(', ')}</Text>
            )}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    ) : null;

  if (!collection) return null;

  return (
    /* 🔴 `forcedBrowsingLevel`, not `browsingLevel`. This is a policy ceiling —
       the same value `Gated` below treats as a gate, bypassed only for mods and
       owners — and the override slot it used to sit in is one any component may
       decline to read. `useViewerBrowsingLevelDebounced` does exactly that by
       design, so as an override this cap silently stopped applying to the remix
       gallery and to avatars. Caps are intersected by the provider, so this
       cannot lift the domain cap either. */
    <BrowsingLevelProvider
      forcedBrowsingLevel={collection.metadata.forcedBrowsingLevel ?? undefined}
    >
      <BrowsingSettingsAddonsProvider>
        <Gated
          contentNsfwLevel={collection.metadata.forcedBrowsingLevel || collection.nsfwLevel}
          nsfw={collection.nsfw ?? undefined}
          bypassRating={
            permissions?.manage ||
            currentUser?.id === collection.user.id ||
            (currentUser?.isModerator ?? false)
          }
          suppressAds={collection.read !== 'Public'}
          meta={{
            title: `${collection.name}${
              collection.user.username ? ` - collection posted by ${collection.user.username}` : ''
            } | Civitai`,
            description: collection.description
              ? truncate(removeTags(collection.description), { length: 150 })
              : '',
            images: collection.image,
            canonical: `/collections/${collection.id}`,
            deIndex:
              collection.read !== 'Public' || collection.availability === Availability.Unsearchable,
          }}
        >
          <MasonryProvider
            columnWidth={constants.cardSizes.model}
            maxColumnCount={7}
            maxSingleColumnWidth={450}
          >
            <MasonryContainer {...containerProps} p={0}>
              <Stack gap="xl" w="100%">
                <CollectionInvitePrompt collectionId={collectionId} />
                <Group gap="xl">
                  {collection?.image && (
                    <Box
                      w={220}
                      styles={{
                        overflow: 'hidden',
                        borderRadius: '8px',
                        boxShadow: theme.shadows.md,
                        [containerQuery.smallerThan('sm')]: {
                          width: '100%',
                          marginBottom: theme.spacing.xs,
                        },
                      }}
                    >
                      <AspectRatio ratio={3 / 2}>
                        <EdgeMedia
                          style={{
                            objectPosition: collection?.metadata?.bannerPosition ?? 'top center',
                          }}
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
                  <Stack gap={8} style={{ flex: 1 }}>
                    <Stack gap={0}>
                      <Group>
                        <Title order={1} lineClamp={1} className={classes.title}>
                          {collection?.name ?? 'Loading...'}
                        </Title>
                        {collection?.archivedAt && (
                          <Badge color="gray" variant="light" radius="sm">
                            Archived
                          </Badge>
                        )}
                        {submissionPeriod}
                      </Group>
                      {collection?.description && (
                        <Text component="div" size="xs" c="dimmed">
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
                      <Group gap={4} wrap="nowrap">
                        <CollectionCollaboratorsSummary
                          collectionId={collection.id}
                          owner={collection.user}
                          collaborators={collaborators ?? []}
                          supportsCollaborators={collection.mode === null}
                          canManage={permissions?.manage}
                        />
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
                      <Group gap={4} ml="auto" style={{ alignSelf: 'flex-start' }} wrap="nowrap">
                        {collection.mode === CollectionMode.Contest &&
                        !permissions?.collaborationDisabled &&
                        // Respect the submission period and permissions:
                        (permissions?.write || permissions?.writeReview) &&
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
                            {canSubmitEntry && (
                              <Button
                                color="blue"
                                radius="xl"
                                onClick={() => {
                                  if (
                                    !!metadata.existingEntriesDisabled ||
                                    collection.type === CollectionType.Post
                                  ) {
                                    router.push(`/posts/create?collectionId=${collection.id}`);
                                  } else {
                                    dialogStore.trigger({
                                      component: AddUserContentModal,
                                      props: { collectionId: collection.id },
                                    });
                                  }
                                }}
                              >
                                Submit an entry
                              </Button>
                            )}
                            <CollectionFollowAction
                              collectionId={collection.id}
                              permissions={permissions}
                            />
                            {!canSubmitEntry && !submissionsClosed && canAddContent && (
                              <Tooltip label="Add from your library." position="bottom" withArrow>
                                <LegacyActionIcon
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
                                </LegacyActionIcon>
                              </Tooltip>
                            )}
                          </>
                        )}
                        {permissions.manage && !!pendingReviewCount && (
                          <Button
                            component={Link}
                            href={`/collections/${collection.id}/review`}
                            color="blue"
                            radius="xl"
                            leftSection={<IconInbox size={16} />}
                          >
                            Review {abbreviateNumber(pendingReviewCount)}
                          </Button>
                        )}
                        <CollectionContextMenu
                          collectionId={collection.id}
                          ownerId={collection.user.id}
                          permissions={permissions}
                          mode={collection.mode}
                        >
                          <LegacyActionIcon variant="subtle">
                            <IconDotsVertical size={16} />
                          </LegacyActionIcon>
                        </CollectionContextMenu>
                      </Group>
                      {showSubmissionsClosedNotice && (
                        <CollectionSubmissionsClosedNotice isOwner={!!permissions?.isOwner} />
                      )}
                      {entryCountDetails?.max &&
                        (permissions?.write || permissions?.writeReview) &&
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
                            <Stack gap={0}>
                              <Progress.Root size="xl">
                                {[
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
                                          tooltip: `${label}: ${
                                            entryCountDetails[status] as number
                                          }`,
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
                                ]
                                  .filter(isDefined)
                                  .map((section) => {
                                    return (
                                      <Tooltip key={section.tooltip} label={section.tooltip}>
                                        <Progress.Section
                                          value={section.value}
                                          color={section.color}
                                        />
                                      </Tooltip>
                                    );
                                  })}
                              </Progress.Root>
                              <Tooltip label="Rejected entries do not count toward the allowed count.">
                                <Text size="xs" fw="bold">
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
                      {formatDate(metadata.submissionStartDate, 'MMM D, YYYY h:mma')}
                    </Text>
                  </AlertWithIcon>
                ) : (
                  <>
                    {isCollectionSubsmissionPeriod(collection) && (
                      <AlertWithIcon icon={<IconAlertCircle />}>
                        <Text>
                          This collection is accepting entries until{' '}
                          {formatDate(metadata.submissionEndDate, 'MMM D, YYYY h:mma')}.{' '}
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
                      <ModelCollection collection={collection} permissions={permissions} />
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
                    <Stack gap="xs">
                      <Text size="lg" fw="700" align="center">
                        Whoops!
                      </Text>
                      <Text align="center">This collection type is not supported</Text>
                    </Stack>
                  </Center>
                )}
              </Stack>
            </MasonryContainer>
          </MasonryProvider>
        </Gated>
      </BrowsingSettingsAddonsProvider>
    </BrowsingLevelProvider>
  );
}
