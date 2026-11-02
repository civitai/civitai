import {
  Alert,
  Anchor,
  Badge,
  CloseButton,
  Group,
  Stack,
  Text,
  Title,
  Paper,
  Center,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import {
  Availability,
  CollectionType,
  EntityCollaboratorStatus,
  EntityType,
} from '~/shared/utils/prisma/enums';
import { IconAlertCircle, IconCheck, IconTrash, IconX } from '@tabler/icons-react';
import { IconDotsVertical, IconBookmark, IconShare3 } from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import { OwnerRatingControls } from '~/components/RatingReview/OwnerRatingControls';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NotFound } from '~/components/AppLayout/NotFound';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import {
  BrowsingLevelProvider,
  useBrowsingLevelContext,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { viewerCollectionCap } from '~/components/BrowsingLevel/resolve-browsing-level';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { ChatUserButton } from '~/components/Chat/ChatUserButton';
import { Collection } from '~/components/Collection/Collection';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import {
  useEntityCollaboratorsMutate,
  useGetEntityCollaborators,
} from '~/components/EntityCollaborator/entityCollaborator.util';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import {
  ExplainHiddenImages,
  useExplainHiddenImages,
} from '~/components/Image/ExplainHiddenImages/ExplainHiddenImages';
import { useQueryImages } from '~/components/Image/image.utils';
import { Gated } from '~/components/Gated/Gated';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { PostControls } from '~/components/Post/Detail/PostControls';
import { PostImages } from '~/components/Post/Detail/PostImages';
import { StorylinePostNext, StorylinePostPill } from '~/components/Storyline/StorylinePostChapter';
import { PostPublishedWithApp } from '~/components/Post/Detail/PostPublishedWithApp';
import { usePostContestCollectionDetails } from '~/components/Post/post.utils';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { toStringList } from '~/utils/array-helpers';
import { formatDate } from '~/utils/date-helpers';
import { getModelUrl, removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { Fragment, useEffect } from 'react';
import clsx from 'clsx';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { contestCollectionReactionsHidden } from '~/components/Collections/collection.utils';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { AdUnitSide_1, AdUnitSide_2 } from '~/components/Ads/AdUnit';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { RenderAdUnitOutstream } from '~/components/Ads/AdUnitOutstream';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { useSearchParams } from 'next/navigation';
import {
  BrowsingSettingsAddonsProvider,
  useBrowsingSettingsAddons,
} from '~/providers/BrowsingSettingsAddonsProvider';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

type Props = { postId: number };

export function PostDetail(props: Props) {
  return (
    <BrowsingLevelProvider>
      <BrowsingSettingsAddonsProvider>
        <PostDetailContent {...props} />
      </BrowsingSettingsAddonsProvider>
    </BrowsingLevelProvider>
  );
}

export function PostDetailContent({ postId }: Props) {
  const colorScheme = useComputedColorScheme('dark');
  const scrollRef = useScrollAreaRef();
  const currentUser = useCurrentUser();
  const searchParams = useSearchParams();
  const { query } = useBrowserRouter();
  const { data: post, isLoading: postLoading } = trpc.post.get.useQuery({ id: postId });
  const {
    collectionItems = [],
    permissions,
    collection,
    isLoading: isLoadingPostCollection,
  } = usePostContestCollectionDetails({ id: postId }, { enabled: !!post?.collectionId });

  const collectionMetadata = (collection?.metadata ?? {}) as CollectionMetadataSchema;
  const requiresCollectionJudgment =
    collectionMetadata?.judgesApplyBrowsingLevel && permissions?.manage;
  const collectionForcedLevel = collection?.metadata?.forcedBrowsingLevel ?? undefined;

  const { setForcedBrowsingLevel, userBrowsingLevel } = useBrowsingLevelContext();
  const forcedBrowsingLevel = viewerCollectionCap(
    collectionForcedLevel,
    userBrowsingLevel,
    !!permissions?.manage ||
      !!currentUser?.isModerator ||
      (!!currentUser && currentUser.id === post?.user.id)
  );
  // 🔴 Set unconditionally so the cap is CLEARED when a post has no collection.
  // Guarding on a truthy value latched the last contest ceiling into the ancestor
  // provider, and `resolvePageBrowsingLevel` puts `forced` AHEAD of the viewer's
  // preference rather than intersecting with it — so a PG-only viewer kept an
  // escalated R ceiling after moving to a post that never had one. Safe to clear
  // only because the provider no longer keeps its `forcedBrowsingLevel` prop in
  // the same state slot.
  useEffect(() => {
    setForcedBrowsingLevel?.(forcedBrowsingLevel);
  }, [forcedBrowsingLevel]);

  const {
    flatData: unfilteredImages,
    images,
    isLoading: imagesLoading,
  } = useQueryImages(
    {
      postId,
      pending: !!currentUser,
      browsingLevel: forcedBrowsingLevel,
      withMeta: false,
      include: [],
    },
    {
      applyHiddenPreferences: !requiresCollectionJudgment && !collectionForcedLevel,
      enabled: !!post && (!post.collectionId || !isLoadingPostCollection),
    }
  );

  const { data: postResources = [] } = trpc.post.getResources.useQuery({ id: postId });

  const isOwnerOrMod = currentUser?.id === post?.user.id || currentUser?.isModerator;

  const {
    removeEntityCollaborator,
    removingEntityCollaborator,
    actionEntityCollaborator,
    actioningEntityCollaborator,
  } = useEntityCollaboratorsMutate();

  const { collaborators: postCollaborators } = useGetEntityCollaborators({
    entityId: postId,
    entityType: EntityType.Post,
  });

  const hiddenExplained = useExplainHiddenImages(unfilteredImages);
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const hasActiveContentFilter =
    browsingSettingsAddons.settings.disableMinor || browsingSettingsAddons.settings.disablePoi;
  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === post?.user.id);
  const sidebarEnabled = true;

  if (postLoading) return <PageLoader />;
  if (!post || isBlocked) return <NotFound />;

  const relatedResource =
    post.modelVersion?.id &&
    postResources.find((resource) => resource.modelVersionId === post.modelVersionId);

  const scrollHeight = scrollRef?.current?.clientHeight ?? 0;

  const postTags = !!post.tags.length && (
    <Collection
      items={post.tags}
      limit={5}
      badgeProps={{ size: 'lg', p: 'sm', radius: 'sm' }}
      renderItem={(item) => (
        <Link legacyBehavior key={item.id} href={`/posts?tags=${item.id}&view=feed`} passHref>
          <Badge
            component="a"
            color="gray"
            radius="sm"
            size="lg"
            style={{ cursor: 'pointer' }}
            variant={colorScheme === 'dark' ? 'filled' : 'light'}
          >
            <Text className="text-xs" tt="capitalize" fw={500}>
              {item.name}
            </Text>
          </Badge>
        </Link>
      )}
      grouped
    />
  );

  const postActions = (
    <div className="flex shrink-0 items-center gap-1.5">
      <Tooltip label="Save">
        <LegacyActionIcon
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          color="gray"
          size={30}
          radius="xl"
          aria-label="Save post"
          onClick={() =>
            openAddToCollectionModal({
              props: { postId: post.id, type: CollectionType.Post },
            })
          }
        >
          <IconBookmark size={16} />
        </LegacyActionIcon>
      </Tooltip>
      <ShareButton
        url={`/posts/${post.id}`}
        title={
          post.title ?? (post.user.username ? `Post by ${post.user.username}` : 'Post on Civitai')
        }
        collect={{ type: CollectionType.Post, postId: post.id }}
      >
        <LegacyActionIcon
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          color="gray"
          size={30}
          radius="xl"
          aria-label="Share post"
        >
          <IconShare3 size={16} />
        </LegacyActionIcon>
      </ShareButton>
      <PostControls
        postId={post.id}
        userId={post.user.id}
        isModelVersionPost={post.modelVersionId}
        storylinePost={post}
      >
        <LegacyActionIcon
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          size={30}
          radius="xl"
          aria-label="Post options"
        >
          <IconDotsVertical size={16} />
        </LegacyActionIcon>
      </PostControls>
      {query.dialog && (
        <NavigateBack url={searchParams.get('returnUrl') ?? '/posts'}>
          {({ onClick }) => <CloseButton onClick={onClick} size="lg" title="Close post" />}
        </NavigateBack>
      )}
    </div>
  );

  const postCard = (
    <div className="flex flex-col gap-2 @max-lg:contents">
      <div className="empty:hidden @max-lg:order-first">
        <StorylinePostPill postId={post.id} />
      </div>
      <div className="flex items-start justify-between gap-2 @max-lg:order-first">
        {post.title ? (
          <Title order={1} lineClamp={3} size={20} className="min-w-0 break-words">
            {post.title}
          </Title>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        {postActions}
      </div>
      <Text size="xs" c="dimmed" className="@max-lg:order-first">
        {relatedResource && relatedResource.modelId && (
          <>
            Posted to{' '}
            <Anchor
              component={Link}
              href={getModelUrl({
                modelId: relatedResource.modelId,
                modelName: relatedResource.modelName,
                modelVersionId: relatedResource.modelVersionId,
              })}
              inherit
            >
              {relatedResource.modelName} - {relatedResource.modelVersionName}
            </Anchor>{' '}
          </>
        )}
        {post.publishedAt ? <DaysFromNow date={post.publishedAt} /> : null}
      </Text>
      {post.detail && (
        <div className="@max-lg:order-1">
          <RenderHtml html={post.detail} withMentions />
        </div>
      )}
      {postTags && <div className="@max-lg:order-first">{postTags}</div>}
    </div>
  );

  const creatorCard = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <UserAvatar
          user={post.user}
          avatarProps={{ size: 40 }}
          size="md"
          subTextSize="sm"
          textSize="md"
          withUsername
          linkToProfile
        />
        <Group gap={8} wrap="nowrap" ml="auto">
          <TipBuzzButton
            toUserId={post.user.id}
            entityId={post.id}
            entityType="Post"
            size="compact-md"
          />
          <ChatUserButton user={post.user} size="compact-md" />
          <FollowUserButton userId={post.user.id} size="compact-md" />
        </Group>
      </div>
      {postCollaborators.length > 0 &&
        postCollaborators.map((collaborator) => {
          return (
            <Group key={collaborator.user.id} gap={4} wrap="nowrap">
              <UserAvatar
                user={collaborator.user}
                avatarProps={{ size: 32 }}
                size="md"
                subTextSize="sm"
                textSize="md"
                withUsername
                linkToProfile
              />
              <Group gap={4} wrap="nowrap">
                {collaborator.user.id === currentUser?.id &&
                  collaborator.status === EntityCollaboratorStatus.Pending && (
                    <Fragment key={collaborator.user.id}>
                      <Tooltip label="Accept collaboration">
                        <LegacyActionIcon
                          onClick={() => {
                            actionEntityCollaborator({
                              entityId: postId,
                              entityType: EntityType.Post,
                              status: EntityCollaboratorStatus.Approved,
                            });
                          }}
                          loading={actioningEntityCollaborator}
                        >
                          <IconCheck size={20} />
                        </LegacyActionIcon>
                      </Tooltip>
                      <Tooltip label="Reject collaboration">
                        <LegacyActionIcon
                          onClick={() => {
                            actionEntityCollaborator({
                              entityId: postId,
                              entityType: EntityType.Post,
                              status: EntityCollaboratorStatus.Rejected,
                            });
                          }}
                          loading={actioningEntityCollaborator}
                        >
                          <IconX size={20} />
                        </LegacyActionIcon>
                      </Tooltip>
                    </Fragment>
                  )}

                {isOwnerOrMod && (
                  <Tooltip label="Remove collaborator">
                    <LegacyActionIcon
                      onClick={() => {
                        removeEntityCollaborator({
                          entityId: postId,
                          entityType: EntityType.Post,
                          targetUserId: collaborator.user.id,
                        });
                      }}
                      loading={removingEntityCollaborator}
                      color="red"
                    >
                      <IconTrash size={20} />
                    </LegacyActionIcon>
                  </Tooltip>
                )}
              </Group>
            </Group>
          );
        })}
    </div>
  );

  const panelClass = 'rounded-md border border-solid border-gray-3 p-3 dark:border-dark-4';

  return (
    <Gated
      contentNsfwLevel={collectionForcedLevel || post.nsfwLevel}
      nsfw={post.nsfw}
      bypassRating={isOwnerOrMod}
      suppressAds={!post.publishedAt}
      meta={{
        title: (post?.title ?? `Image post by ${post?.user.username ?? 'civitai'}`) + ' | Civitai',
        description:
          `A post by ${post?.user.username ?? 'civitai'}. ` +
          (post?.detail ? ' ' + truncate(removeTags(post?.detail ?? ''), { length: 100 }) : ''),
        keywords: toStringList(post?.tags.map((x) => x.name) ?? []),
        images,
        ogEndpoint: `/api/og?type=post&id=${postId}`,
        canonical: `/posts/${postId}`,
        deIndex: post?.availability === Availability.Unsearchable,
      }}
    >
      <TrackView entityId={post.id} entityType="Post" type="PostView" />
      <RenderAdUnitOutstream minContainerWidth={1964} />
      <ReactionSettingsProvider
        settings={{
          hideReactions: collectionItems.some((ci) =>
            contestCollectionReactionsHidden(ci.collection)
          ),
        }}
      >
        <div className="flex justify-center gap-8 px-3 @max-lg:mx-auto @max-lg:w-full @max-lg:max-w-[752px] @max-lg:flex-col @max-lg:gap-3">
          {/* On a phone the main column and the sidebar are `display: contents`, so their pieces
              sit in one column and `@max-lg:order-*` sets the screen order: title, where it was
              posted to and tags, then the images, description, creator, app card, comments. */}
          <div className="flex w-full max-w-[728px] flex-col gap-3 @lg:my-3 @max-lg:contents">
            {isOwnerOrMod && post.wasPublished && !post.publishedAt && (
              <Alert
                color="yellow"
                icon={<IconAlertCircle size={16} />}
                radius="sm"
                className="shrink-0"
              >
                <Stack gap="xs">
                  <Text size="sm" fw={600}>
                    Post unpublished
                  </Text>
                  {post.unpublishedAt && (
                    <Text size="sm">
                      Unpublished on {formatDate(post.unpublishedAt, 'MMMM D, YYYY')}.
                    </Text>
                  )}
                  <Text size="sm">
                    This post is hidden from the public because its parent model or version was
                    unpublished. Republish the parent to bring this post back — the original publish
                    date will be preserved.
                  </Text>
                  {post.parentModelId && post.modelVersionId && (
                    <Text size="sm">
                      <Anchor
                        component={Link}
                        href={`/models/${post.parentModelId}?modelVersionId=${post.modelVersionId}`}
                      >
                        View the parent model
                      </Anchor>{' '}
                      to see why it was unpublished.
                    </Text>
                  )}
                </Stack>
              </Alert>
            )}
            <OwnerRatingControls
              entityType="Post"
              entityId={post.id}
              isOwner={currentUser?.id === post.user.id}
            />
            {currentUser?.isModerator && post.nsfwLevel === 0 && (
              <>
                <Alert color="red" mb="md">
                  This post is missing a NSFW level. Please queue for update on the context menu.
                  This post will not be visible to other users until it has a NSFW level.
                </Alert>
              </>
            )}
            {!imagesLoading && !unfilteredImages?.length ? (
              hasActiveContentFilter ? (
                <Alert color="yellow">
                  No images in this post are visible with your current browsing and content
                  settings.
                </Alert>
              ) : (
                <Alert>Unable to load images</Alert>
              )
            ) : (
              <>
                {currentUser?.id === post.user.id &&
                  hiddenExplained.hiddenByBrowsingSettings.length > 0 && (
                    <>
                      <Alert color="yellow" mb="md">
                        With mature content enabled, content tagged as minor is not shown. Some
                        images in this post have been hidden.
                      </Alert>
                    </>
                  )}
                <PostImages
                  postId={post.id}
                  images={images}
                  isLoading={imagesLoading}
                  collectionItems={collectionItems}
                  isOwner={currentUser?.id === post.user.id}
                  isModerator={currentUser?.isModerator}
                />
                {hiddenExplained.hasHidden && !imagesLoading && !collectionForcedLevel && (
                  <Paper component={Center} p="xl" mih={300} withBorder>
                    <ExplainHiddenImages {...hiddenExplained} />
                  </Paper>
                )}
              </>
            )}
            <StorylinePostNext postId={post.id} />
            <Stack className="mb-20 mt-6 gap-6 @max-lg:order-4" id="comments" mb={90}>
              <PostComments postId={postId} userId={post.user.id} />
            </Stack>
          </div>
          <div className="relative flex w-[336px] flex-col gap-3 @lg:my-3 @max-lg:contents">
            <div className="sticky top-3 flex flex-col gap-3 @max-lg:contents">
              <div
                className="flex min-w-0 flex-col gap-3 @max-lg:contents"
                data-testid="post-info-panel"
              >
                <div className={clsx(panelClass, '@max-lg:contents')}>{postCard}</div>
                <div className="flex flex-col gap-3 @max-lg:contents">
                  <div className={clsx(panelClass, '@max-lg:order-2 @max-lg:border-0 @max-lg:p-0')}>
                    {creatorCard}
                  </div>
                  <div className="empty:hidden @max-lg:order-3">
                    <PostPublishedWithApp app={post.publishedWithApp} />
                  </div>
                </div>
              </div>

              <div className="flex w-full flex-col gap-3 py-3 @max-lg:hidden">
                {sidebarEnabled && scrollHeight >= 600 && <AdUnitSide_1 />}
                {sidebarEnabled && scrollHeight > 900 && <AdUnitSide_2 />}
              </div>
            </div>
          </div>
        </div>
      </ReactionSettingsProvider>
    </Gated>
  );
}
