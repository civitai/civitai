import {
  Alert,
  Anchor,
  Badge,
  Button,
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
import { IconCheck, IconTrash, IconX } from '@tabler/icons-react';
import { IconDotsVertical, IconBookmark, IconShare3 } from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NotFound } from '~/components/AppLayout/NotFound';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import {
  BrowsingLevelProvider,
  useBrowsingLevelContext,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
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
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { PostControls } from '~/components/Post/Detail/PostControls';
import { PostImages } from '~/components/Post/Detail/PostImages';
import { usePostContestCollectionDetails } from '~/components/Post/post.utils';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { toStringList } from '~/utils/array-helpers';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { Fragment, useEffect } from 'react';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { contestCollectionReactionsHidden } from '~/components/Collections/collection.utils';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { AdUnitSide_1, AdUnitSide_2 } from '~/components/Ads/AdUnit';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { Flags } from '~/shared/utils/flags';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { RenderAdUnitOutstream } from '~/components/Ads/AdUnitOutstream';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { useSearchParams } from 'next/navigation';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { openAddToCollectionModal } from '~/components/Dialog/dialog-registry';
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
  const forcedBrowsingLevel = collection?.metadata?.forcedBrowsingLevel ?? undefined;

  const { setForcedBrowsingLevel } = useBrowsingLevelContext();
  useEffect(() => {
    if (forcedBrowsingLevel) {
      setForcedBrowsingLevel?.(forcedBrowsingLevel);
    }
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
      applyHiddenPreferences: !requiresCollectionJudgment && !forcedBrowsingLevel,
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
  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === post?.user.id);
  const sidebarEnabled = useContainerSmallerThan(1500);

  if (postLoading) return <PageLoader />;
  if (!post || isBlocked) return <NotFound />;

  const relatedResource =
    post.modelVersion?.id &&
    postResources.find((resource) => resource.modelVersionId === post.modelVersionId);

  const scrollHeight = scrollRef?.current?.clientHeight ?? 0;
  const aggregateBrowsingLevel = images.reduce<number>(
    (acc, image) => Flags.addFlag(acc, image.nsfwLevel),
    0
  );

  return (
    <>
      <Meta
        title={(post?.title ?? `Image post by ${post?.user.username ?? 'civitai'}`) + ' | Civitai'}
        description={
          `A post by ${post?.user.username ?? 'civitai'}. ` +
          (post?.detail ? ' ' + truncate(removeTags(post?.detail ?? ''), { length: 100 }) : '')
        }
        keywords={toStringList(post?.tags.map((x) => x.name) ?? [])}
        images={images}
        links={
          env.NEXT_PUBLIC_BASE_URL
            ? [{ href: `${env.NEXT_PUBLIC_BASE_URL}/posts/${postId}`, rel: 'canonical' }]
            : undefined
        }
        deIndex={post?.availability === Availability.Unsearchable}
      />
      <SensitiveShield
        contentNsfwLevel={forcedBrowsingLevel || post.nsfwLevel}
        isLoading={!!(post?.collectionId && isLoadingPostCollection)}
      >
        <TrackView entityId={post.id} entityType="Post" type="PostView" />
        <RenderAdUnitOutstream minContainerWidth={1600} />
        <ReactionSettingsProvider
          settings={{
            hideReactions: collectionItems.some((ci) =>
              contestCollectionReactionsHidden(ci.collection)
            ),
          }}
        >
          <div className="flex justify-center gap-8 px-3">
            <div className="flex w-full max-w-[728px] flex-col gap-3 @lg:my-3">
              <div className="flex flex-col">
                <div className="flex items-center justify-between">
                  {post.title && (
                    <Title order={1} lineClamp={2} size={26}>
                      {post.title}
                    </Title>
                  )}
                  {query.dialog && (
                    <NavigateBack url={searchParams.get('returnUrl') ?? '/posts'}>
                      {({ onClick }) => (
                        <CloseButton onClick={onClick} size="lg" ml="auto" title="Close post" />
                      )}
                    </NavigateBack>
                  )}
                </div>
                <div className="flex flex-wrap justify-between gap-2 @md:items-center @max-md:flex-col">
                  <Text size="xs" c="dimmed">
                    {relatedResource && relatedResource.modelId && (
                      <>
                        Posted to{' '}
                        <Anchor
                          component={Link}
                          href={`/models/${relatedResource.modelId}?modelVersionId=${relatedResource.modelVersionId}`}
                          inherit
                        >
                          {relatedResource.modelName} - {relatedResource.modelVersionName}
                        </Anchor>{' '}
                      </>
                    )}
                    {post.publishedAt ? <DaysFromNow date={post.publishedAt} /> : null}
                  </Text>
                  <div className="flex gap-2 ">
                    <Button
                      radius="xl"
                      color="gray"
                      variant={colorScheme === 'dark' ? 'filled' : 'light'}
                      leftSection={<IconBookmark size={14} />}
                      onClick={() =>
                        openAddToCollectionModal({
                          props: { postId: post.id, type: CollectionType.Post },
                        })
                      }
                      size="compact-md"
                    >
                      <Text className="text-xs">Save</Text>
                    </Button>
                    <ShareButton
                      url={`/posts/${post.id}`}
                      title={
                        post.title ??
                        (post.user.username ? `Post by ${post.user.username}` : 'Post on Civitai')
                      }
                      collect={{ type: CollectionType.Post, postId: post.id }}
                    >
                      <Button
                        radius="xl"
                        color="gray"
                        variant={colorScheme === 'dark' ? 'filled' : 'light'}
                        leftSection={<IconShare3 size={14} />}
                        size="compact-md"
                      >
                        <Text className="text-xs">Share</Text>
                      </Button>
                    </ShareButton>
                    <PostControls
                      postId={post.id}
                      userId={post.user.id}
                      isModelVersionPost={post.modelVersionId}
                    >
                      <LegacyActionIcon
                        variant={colorScheme === 'dark' ? 'filled' : 'light'}
                        size={30}
                        radius="xl"
                        className="@max-md:ml-auto"
                      >
                        <IconDotsVertical size={16} />
                      </LegacyActionIcon>
                    </PostControls>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <UserAvatar
                    user={post.user}
                    avatarProps={{ size: 32 }}
                    size="md"
                    subTextSize="sm"
                    textSize="md"
                    withUsername
                    linkToProfile
                  />
                  <Group gap={8} wrap="nowrap">
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
              {currentUser?.isModerator && post.nsfwLevel === 0 && (
                <>
                  <Alert color="red" mb="md">
                    This post is missing a NSFW level. Please queue for update on the context menu.
                    This post will not be visible to other users until it has a NSFW level.
                  </Alert>
                </>
              )}
              {!imagesLoading && !unfilteredImages?.length ? (
                <Alert>Unable to load images</Alert>
              ) : (
                <>
                  {currentUser?.id === post.user.id &&
                    hiddenExplained.hiddenByBrowsingSettings.length > 0 && (
                      <>
                        <Alert color="yellow" mb="md">
                          While browsing with X or XXX enabled, content tagged as minor or potential
                          celebrity is not shown. Some images in this post have been hidden.
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
                  {hiddenExplained.hasHidden && !imagesLoading && !forcedBrowsingLevel && (
                    <Paper component={Center} p="xl" mih={300} withBorder>
                      <ExplainHiddenImages {...hiddenExplained} />
                    </Paper>
                  )}
                </>
              )}
              <Stack className="mb-20 mt-6 gap-6" id="comments" mb={90}>
                {!!post.tags.length && (
                  <Collection
                    items={post.tags}
                    limit={5}
                    badgeProps={{ size: 'xl', p: 'md', radius: 'xl' }}
                    renderItem={(item) => (
                      <Link
                        legacyBehavior
                        key={item.id}
                        href={`/posts?tags=${item.id}&view=feed`}
                        passHref
                      >
                        <Badge
                          component="a"
                          color="gray"
                          radius="xl"
                          size="xl"
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
                )}
                {post.detail && <RenderHtml html={post.detail} withMentions />}
                <PostComments postId={postId} userId={post.user.id} />
              </Stack>
            </div>
            <div
              className="relative hidden w-[336px] flex-col gap-3 @lg:my-3 @lg:flex @[1500px]:hidden "
              // style={scrollHeight < 600 ? { display: 'none' } : undefined}
            >
              <div className="sticky left-0 top-0 ">
                <div className="flex w-full flex-col gap-3 py-3">
                  {sidebarEnabled && scrollHeight >= 600 && (
                    <AdUnitSide_1 browsingLevel={aggregateBrowsingLevel} />
                  )}
                  {sidebarEnabled && scrollHeight > 900 && (
                    <AdUnitSide_2 browsingLevel={aggregateBrowsingLevel} />
                  )}
                </div>
              </div>
            </div>
          </div>
        </ReactionSettingsProvider>
      </SensitiveShield>
    </>
  );
}
