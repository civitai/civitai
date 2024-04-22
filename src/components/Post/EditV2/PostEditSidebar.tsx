import { Button, Title, Badge, Tooltip, Text, TooltipProps, ThemeIcon } from '@mantine/core';
import { useIsMutating } from '@tanstack/react-query';
import { useCurrentUserRequired } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { PostDetailEditable } from '~/server/services/post.service';
import { useRouter } from 'next/router';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { CollectionType } from '@prisma/client';
import { formatDate } from '~/utils/date-helpers';
import { useRef } from 'react';
import { IconClock, IconTrash } from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ReorderImagesButton } from '~/components/Post/EditV2/PostReorderImages';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { DeletePostButton } from '~/components/Post/DeletePostButton';

export function PostEditSidebar({ post }: { post: PostDetailEditable }) {
  // #region [state]
  const router = useRouter();
  const currentUser = useCurrentUserRequired();
  const params = usePostEditParams();
  const { returnUrl } = params;
  const [updatePost, isReordering, hasImages, showReorder] = usePostEditStore((state) => [
    state.updatePost,
    state.isReordering,
    state.images.filter((x) => x.type === 'added').length > 0,
    state.images.length > 1,
  ]);

  const canPublish = hasImages && !isReordering;
  const queryUtils = trpc.useUtils();
  const mutating = useIsMutating();
  const todayRef = useRef(new Date());
  // #endregion

  const updatePostMutation = trpc.post.update.useMutation();

  const handlePublish = () =>
    updatePostMutation.mutate(
      { id: post.id ?? 0, publishedAt: new Date() },
      {
        onSuccess: async (_, { publishedAt }) => {
          updatePost((data) => {
            data.publishedAt = publishedAt ?? null;
          });
          await queryUtils.image.getImagesAsPostsInfinite.invalidate();

          if (returnUrl) router.push(returnUrl);
          else router.push(`/user/${currentUser.username}/posts`);
        },
      }
    );

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
          label="At least one image is required in order to publish this post to the community"
          multiline
          width={260}
          withArrow
        >
          <Button
            disabled={!canPublish}
            onClick={handlePublish}
            loading={updatePostMutation.isLoading}
          >
            Publish
          </Button>
        </Tooltip>
      ) : (
        <ShareButton
          title={post.title ?? undefined}
          url={`/posts/${post.id}`}
          collect={{ type: CollectionType.Post, postId: post.id }}
        >
          <Button variant="default">Share</Button>
        </ShareButton>
      )}

      {showReorder && <ReorderImagesButton />}

      <DeletePostButton postId={post.id}>
        {({ onClick, isLoading }) => (
          <Button
            onClick={() => onClick()}
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
