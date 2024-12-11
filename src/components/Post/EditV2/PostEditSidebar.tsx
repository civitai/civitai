import { Alert, Badge, Button, Text, ThemeIcon, Title, Tooltip, TooltipProps } from '@mantine/core';
import { IconClock, IconTrash } from '@tabler/icons-react';
import { useIsMutating } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useRef, useState } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { ReorderImagesButton } from '~/components/Post/EditV2/PostReorderImages';
import { SchedulePostModal } from '~/components/Post/EditV2/SchedulePostModal';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { PostDetailEditable } from '~/server/services/post.service';
import { CollectionType } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

export function PostEditSidebar({ post }: { post: PostDetailEditable }) {
  // #region [state]
  const router = useRouter();
  const params = usePostEditParams();
  const { returnUrl, afterPublish } = params;
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
  const canPublish = hasImages && !isReordering;
  const todayRef = useRef(new Date());
  const canSchedule = post.publishedAt && post.publishedAt.getTime() > new Date().getTime();
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
            router.push({ pathname: `/posts/${post.id}`, query: removeEmpty({ returnUrl }) });
            // if (returnUrl) router.push(returnUrl);
            // else router.push(`/user/${currentUser.username}/posts`);
          }
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
        {collectionId && (
          <Alert mb="xs">
            <div className="flex">
              <Text size="xs">
                Did you tag the tools you used in your entry? Adding the tools used to create your
                entry may make you elegible for more prizes.
              </Text>
            </div>
          </Alert>
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Title size="sm">{postLabel}</Title>
          </div>
          <Badge color={mutating > 0 ? 'yellow' : 'green'} size="lg">
            {mutating > 0 ? 'Saving' : 'Saved'}
          </Badge>
        </div>

        <Text size="xs">
          {!post.publishedAt ? (
            <>
              Your {postLabel} is currently{' '}
              <Tooltip
                label={`Click the ${publishLabel} button to make your post Public to share with the Civitai community for comments and reactions.`}
                {...tooltipProps}
              >
                <Text component="span" underline>
                  hidden
                </Text>
              </Tooltip>
            </>
          ) : post.publishedAt > todayRef.current ? (
            <div className="flex items-center gap-1">
              <ThemeIcon color="gray" variant="filled" radius="xl">
                <IconClock size={20} />
              </ThemeIcon>
              <span>Scheduled for {formatDate(post.publishedAt)}</span>
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
            isReordering
              ? 'Finish rearranging your images before you publish'
              : 'At least one image is required in order to publish this post to the community'
          }
          multiline
          width={260}
          withArrow
        >
          {collectionId ? (
            <Button
              disabled={!canPublish || !!mutating}
              onClick={() => handlePublish()}
              loading={updatePostMutation.isLoading}
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
              >
                {publishLabel}
              </Button>
              <Tooltip label="Schedule Publish" withArrow>
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
            <Tooltip label="Reschedule Publish" withArrow>
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
              router.push(`/posts/${post.id}`);
            } else if (images.length === 1 && image && image.data.hasOwnProperty('id')) {
              // @ts-ignore - we know it's an image that has ID based off of the above.
              router.push(`/images/${image.data.id}`);
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
            leftIcon={<IconTrash size={20} />}
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
