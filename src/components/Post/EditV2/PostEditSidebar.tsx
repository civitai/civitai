import { Button, Title, Badge, Tooltip, Text, TooltipProps, ThemeIcon } from '@mantine/core';
import { useIsMutating } from '@tanstack/react-query';
import { useCurrentUserRequired } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { PostDetailEditable } from '~/server/services/post.service';
import { useRouter } from 'next/router';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { CollectionType } from '@prisma/client';
import { formatDate } from '~/utils/date-helpers';
import { useRef, useState } from 'react';
import { IconClock, IconTrash } from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ReorderImagesButton } from '~/components/Post/EditV2/PostReorderImages';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SchedulePostModal } from '~/components/Post/EditV2/SchedulePostModal';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { removeEmpty } from '~/utils/object-helpers';

export function PostEditSidebar({ post }: { post: PostDetailEditable }) {
  // #region [state]
  const router = useRouter();
  const params = usePostEditParams();
  const { returnUrl, afterPublish } = params;
  const [deleted, setDeleted] = useState(false);
  const [updatePost, isReordering, hasImages, showReorder] = usePostEditStore((state) => [
    state.updatePost,
    state.isReordering,
    state.images.filter((x) => x.type === 'added').length > 0,
    state.images.length > 1,
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
  // #endregion

  // #region [publish post]
  const publish = (publishedAt = new Date()) =>
    updatePostMutation.mutate(
      { id: post.id ?? 0, title: !post.title ? params.postTitle : undefined, publishedAt },
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
      }
    );

  const confirmPublish = (date?: Date) => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: params.confirmTitle,
        message: params.confirmMessage ?? 'Are you sure you want to publish this post?',
        onConfirm: () => handlePublish(date),
      },
    });
  };

  const handlePublish = (date?: Date) => {
    params.confirmPublish ? confirmPublish(date) : publish(date);
  };

  const handleScheduleClick = () => {
    dialogStore.trigger({
      component: SchedulePostModal,
      props: { onSubmit: handlePublish, publishedAt: post.publishedAt },
    });
  };

  useCatchNavigation({
    unsavedChanges: !post.publishedAt && !deleted,
    message: `You haven't published this post, all images will stay hidden. Do you wish to continue?`,
  });
  // #endregion

  return (
    <>
      <div className="flex flex-col gap-0 5">
        <div className="flex justify-between items-center">
          <Title size="sm">POST</Title>
          <Badge color={mutating > 0 ? 'yellow' : 'green'} size="lg">
            {mutating > 0 ? 'Saving' : 'Saved'}
          </Badge>
        </div>

        <Text size="xs">
          {!post.publishedAt ? (
            <>
              Your post is currently{' '}
              <Tooltip
                label="Click the Publish button to make your post Public to share with the Civitai community for comments and reactions."
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
          <Button.Group>
            <Button
              disabled={!canPublish}
              onClick={() => handlePublish()}
              loading={updatePostMutation.isLoading}
              className="flex-1"
            >
              Publish
            </Button>
            <Tooltip label="Schedule Publish" withArrow>
              <Button
                variant="outline"
                loading={updatePostMutation.isLoading}
                onClick={handleScheduleClick}
                disabled={!canPublish}
              >
                <IconClock size={20} />
              </Button>
            </Tooltip>
          </Button.Group>
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
