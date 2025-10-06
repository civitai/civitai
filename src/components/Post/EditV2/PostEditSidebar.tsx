import type { TooltipProps } from '@mantine/core';
import { Alert, Anchor, Badge, Button, Text, ThemeIcon, Title, Tooltip } from '@mantine/core';
import { IconClock, IconTrash } from '@tabler/icons-react';
import { useIsMutating } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useMemo, useRef, useState } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HelpButton } from '~/components/HelpButton/HelpButton';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { ReorderImagesButton } from '~/components/Post/EditV2/PostReorderImages';
import { SchedulePostModal } from '~/components/Post/EditV2/SchedulePostModal';
import { usePostContestCollectionDetails } from '~/components/Post/post.utils';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';
// import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useTourContext } from '~/components/Tours/ToursProvider';
import type { PostDetailEditable } from '~/server/services/post.service';
import { CollectionType } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { isValidAIGeneration, hasImageLicenseViolation } from '~/utils/image-utils';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageResourceHelper } from '~/shared/utils/prisma/models';

const getLicenseViolationDetails = (
  images: Array<{ nsfwLevel: number; resourceHelper: ImageResourceHelper[] }>
) => {
  const violatingImages = images.filter((image) => {
    return hasImageLicenseViolation(image).violation;
  });

  if (violatingImages.length === 0) return null;

  const count = violatingImages.length;
  const isPlural = count > 1;

  return `${count} image${isPlural ? 's' : ''} violate${
    isPlural ? '' : 's'
  } license restrictions for ${
    isPlural ? 'their' : 'its'
  } NSFW content level. Check the alerts on your images for details.`;
};

export function PostEditSidebar({ post }: { post: PostDetailEditable }) {
  // #region [state]
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const params = usePostEditParams();
  // const currentUser = useCurrentUser();
  const { runTour } = useTourContext();
  const features = useFeatureFlags();

  const [deleted, setDeleted] = useState(false);
  const [updatePost, isReordering, hasImages, showReorder, collectionId, collectionTagId, images] =
    usePostEditStore((state) => [
      state.updatePost,
      state.isReordering,
      state.images.filter((x) => x.type === 'added').length > 0,
      state.images.length > 1,
      state.collectionId,
      state.collectionTagId,
      state.images,
    ]);
  const todayRef = useRef(new Date());

  const addedImages = useMemo(
    () => images.filter((image) => image.type === 'added').map((image) => image.data),
    [images]
  );

  const isAiVerified = !addedImages.some(
    (image) =>
      !isValidAIGeneration({
        id: image.id,
        nsfwLevel: image.nsfwLevel,
        resources: image.resourceHelper,
        tools: image.tools,
        meta: image.meta as ImageMetaProps,
        tags: image.tags,
      })
  );

  // Check for NSFW license violations
  const hasNsfwLicenseViolations = addedImages.some(
    (image) => hasImageLicenseViolation(image).violation
  );

  const canPublish =
    hasImages && !isReordering && isAiVerified && !hasNsfwLicenseViolations && features.canWrite;

  const canSchedule = post.publishedAt && post.publishedAt.getTime() > new Date().getTime();
  const { returnUrl, afterPublish } = params;

  const { collection } = usePostContestCollectionDetails(
    { id: post.id },
    { enabled: !!collectionId }
  );
  // #endregion

  // #region [mutations]
  const updatePostMutation = trpc.post.update.useMutation();
  const mutating = useIsMutating({
    predicate: (mutation) => mutation.options.mutationKey?.flat().includes('post') ?? false,
    exact: false,
  });
  const publishLabel = collectionId ? 'Submit' : 'Publish';
  // #endregion

  // #region [publish post]
  const publish = (publishedAt = new Date()) =>
    updatePostMutation.mutate(
      {
        id: post.id ?? 0,
        title: !post.title ? params.postTitle : undefined,
        publishedAt,
        collectionId,
        collectionTagId,
      },
      {
        onSuccess: async (_, post) => {
          const { id, publishedAt } = post;
          updatePost((data) => {
            data.publishedAt = publishedAt ?? null;
          });
          if (publishedAt && afterPublish) await afterPublish({ postId: id, publishedAt });
          else {
            if (returnUrl) router.push(returnUrl);
            else router.push({ pathname: `/posts/${post.id}`, query: removeEmpty({ returnUrl }) });
            // else router.push(`/user/${currentUser?.username}/posts`);
          }
          await queryUtils.image.getImagesAsPostsInfinite.invalidate();
        },
        onError: (error) => {
          showErrorNotification({
            title: 'There was an error while trying to publish your post',
            error,
          });
        },
      }
    );

  const handleShowConfirmPublish = (date?: Date) => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: params.confirmTitle,
        message: params.confirmMessage ?? 'Are you sure you want to publish this post?',
        onConfirm: () => handlePublish(date, false),
      },
    });
  };

  const handlePublish = (date?: Date, confirmPublish = params.confirmPublish) => {
    confirmPublish ? handleShowConfirmPublish(date) : publish(date);
  };

  const handleScheduleClick = () => {
    dialogStore.trigger({
      component: SchedulePostModal,
      props: {
        onSubmit: handlePublish,
        publishedAt: post.publishedAt,
        publishingModel: !!post.modelVersionId,
      },
    });
  };

  useCatchNavigation({
    unsavedChanges: !post.publishedAt && !deleted,
    message: `You haven't published this post, all images will stay hidden. Do you wish to continue?`,
  });
  // #endregion

  const postLabel = collectionId ? 'Entry' : 'Post';

  return (
    <>
      <div className="flex flex-col gap-0">
        {collection?.metadata?.includeContestCallouts && (
          <Alert mb="xs">
            <div className="flex">
              <Text size="xs">
                Please add the AI and filmmaking tools you used in your entry. Depending on the
                tool, you&apos;ll automatically be eligible for the{' '}
                <Anchor
                  target="_blank"
                  rel="noopener nofollow"
                  href="https://www.projectodyssey.ai/free-trials-and-prizes"
                >
                  Title and Gold Sponsor Awards
                </Anchor>
                .
              </Text>
            </div>
          </Alert>
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Title size="sm">{postLabel}</Title>
            {features.appTour && (
              <HelpButton
                data-tour="post:reset"
                tooltip="Need help? Start the tour!"
                onClick={() => runTour({ key: 'post-generation', step: 0, forceRun: true })}
              />
            )}
          </div>
          <Badge color={mutating > 0 ? 'yellow' : 'green'} size="lg">
            {mutating > 0 ? 'Saving' : 'Saved'}
          </Badge>
        </div>

        <Text size="xs" component="div">
          {!post.publishedAt ? (
            <>
              Your {postLabel} is currently{' '}
              <Tooltip
                label={`Click the ${publishLabel} button to make your post Public to share with the Civitai community for comments and reactions.`}
                {...tooltipProps}
              >
                <Text component="span" td="underline">
                  hidden
                </Text>
              </Tooltip>
            </>
          ) : post.publishedAt > todayRef.current ? (
            <div className="flex items-center gap-1">
              <ThemeIcon color="gray" variant="filled" radius="xl">
                <IconClock size={20} />
              </ThemeIcon>
              <span>Scheduled for {formatDate(post.publishedAt, 'MMMM D, h:mma')}</span>
            </div>
          ) : (
            <>
              Published <DaysFromNow date={post.publishedAt} />
            </>
          )}
        </Text>
      </div>

      {!post.publishedAt ? (
        <Tooltip
          disabled={canPublish}
          label={
            !isAiVerified
              ? 'We could not verify some of your NSFW images were AI generated. Please add proper metadata before publishing this post.'
              : hasNsfwLicenseViolations
              ? getLicenseViolationDetails(addedImages)
              : isReordering
              ? 'Finish rearranging your images before you publish'
              : 'At least one image is required in order to publish this post to the community'
          }
          multiline
          w="260px"
          withArrow
        >
          {collectionId ? (
            <Button
              disabled={!canPublish || !!mutating}
              onClick={() => handlePublish()}
              loading={updatePostMutation.isLoading}
              data-tour="post:publish"
            >
              {publishLabel}
            </Button>
          ) : (
            <Button.Group>
              <Button
                disabled={!canPublish || !!mutating}
                onClick={() => handlePublish()}
                loading={updatePostMutation.isLoading}
                className="flex-1"
                data-tour="post:publish"
              >
                {publishLabel}
              </Button>
              <Tooltip label="Schedule Publish" disabled={!hasImages} withArrow>
                <Button
                  variant="outline"
                  loading={updatePostMutation.isLoading}
                  onClick={handleScheduleClick}
                  disabled={!canPublish || !!mutating}
                >
                  <IconClock size={20} />
                </Button>
              </Tooltip>
            </Button.Group>
          )}
        </Tooltip>
      ) : (
        <Button.Group>
          <ShareButton
            title={post.title ?? undefined}
            url={`/posts/${post.id}`}
            collect={{ type: CollectionType.Post, postId: post.id }}
          >
            <Button variant="default" className="flex-1">
              Share
            </Button>
          </ShareButton>
          {canSchedule && (
            <Tooltip label="Reschedule Publish" disabled={!hasImages} withArrow>
              <Button
                variant="filled"
                color="gray"
                loading={updatePostMutation.isLoading}
                onClick={handleScheduleClick}
                disabled={!canPublish}
              >
                <IconClock size={20} />
              </Button>
            </Tooltip>
          )}
        </Button.Group>
      )}

      {showReorder && <ReorderImagesButton />}

      {post.publishedAt && images.length > 0 && (
        <Button
          onClick={() => {
            const [image] = images;
            if (images.length > 1) {
              if (collectionId) router.replace(`/posts/${post.id}`);
              else router.push(`/posts/${post.id}`);
            } else if (images.length === 1 && image && 'id' in image.data) {
              if (collectionId) router.replace(`/images/${image.data.id}`);
              else router.push(`/images/${image.data.id}`);
            }
          }}
          variant="outline"
          color="blue"
        >
          View {postLabel}
        </Button>
      )}

      <DeletePostButton postId={post.id}>
        {({ onClick, isLoading }) => (
          <Button
            onClick={() => {
              setDeleted(true);
              onClick();
            }}
            color="red"
            loading={isLoading}
            variant="outline"
            leftSection={<IconTrash size={20} />}
            disabled={!features.canWrite}
          >
            Delete Post
          </Button>
        )}
      </DeletePostButton>
    </>
  );
}

const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};
