import {
  Stack,
  Text,
  Tooltip,
  Button,
  Checkbox,
  TooltipProps,
  Group,
  ThemeIcon,
} from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { trpc } from '~/utils/trpc';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { EditPostTags } from '~/components/Post/Edit/EditPostTags';

import { PostEditActions } from '~/components/Post/Edit/PostEditActions';
import { useRouter } from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CollectionType } from '@prisma/client';
import { formatDate } from '~/utils/date-helpers';
import { IconClock } from '@tabler/icons-react';
import { showErrorNotification } from '~/utils/notifications';
import { useFeatureFlags } from '../../../providers/FeatureFlagsProvider';
import { useQueryUserContributingClubs } from '../../Club/club.utils';

const publishText = 'Publish';
export const hiddenLabel = `Click the '${publishText}' button to make your post Public to share with the Civitai community for comments and reactions.`;
export const matureLabel = 'Mature content may include content that is suggestive or provocative';
const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

export function EditPostControls() {
  return (
    <Stack spacing={50}>
      <Stack>
        <ManagePostStatus />
        <ManagePostMaturity />
        <EditPostTags />
      </Stack>
      <PostEditActions />
    </Stack>
  );
}

const today = new Date();

export function ManagePostStatus() {
  const router = useRouter();
  const returnUrl = router.query.returnUrl as string;
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const id = useEditPostContext((state) => state.id);
  const title = useEditPostContext((state) => state.title);
  const images = useEditPostContext((state) => state.images);
  const publishedAt = useEditPostContext((state) => state.publishedAt);
  const setPublishedAt = useEditPostContext((state) => state.setPublishedAt);
  const isReordering = useEditPostContext((state) => state.reorder);
  const clubs = useEditPostContext((state) => state.clubs);
  const unlisted = useEditPostContext((state) => state.unlisted);

  const { mutate, isLoading } = trpc.post.update.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Failed to publish',
        error: new Error(error.message),
      });
    },
  });

  const canPublish = images.filter((x) => x.discriminator === 'image').length > 0 && !isReordering;

  const handlePublish = () => {
    if (!currentUser) return;
    const publishedAt = new Date();
    mutate(
      { id, publishedAt, clubs, unlisted },
      {
        onSuccess: async () => {
          setPublishedAt(publishedAt);
          await queryUtils.image.getImagesAsPostsInfinite.invalidate();
          if (clubs?.length) {
            await queryUtils.clubPost.getInfiniteClubPosts.invalidate();
          }

          if (returnUrl) router.push(returnUrl);
          else router.push(`/user/${currentUser.username}/posts`);
        },
      }
    );
  };

  return (
    <Stack spacing={4}>
      <Group spacing="xs">
        {!publishedAt && (
          <Tooltip
            disabled={canPublish}
            label="At least one image is required in order to publish this post to the community"
            multiline
            width={260}
            withArrow
          >
            <div style={{ display: 'flex', flex: 2 }}>
              <Button
                disabled={!canPublish}
                style={{ flex: 1 }}
                onClick={handlePublish}
                loading={isLoading}
              >
                {publishText}
              </Button>
            </div>
          </Tooltip>
        )}
        {publishedAt && (
          <ShareButton
            title={title}
            url={`/posts/${id}`}
            collect={{ type: CollectionType.Post, postId: id }}
          >
            <Button variant="default" style={{ flex: 1 }}>
              Share
            </Button>
          </ShareButton>
        )}
      </Group>
      <Text size="xs">
        {!publishedAt ? (
          <>
            Your post is currently{' '}
            <Tooltip label={hiddenLabel} {...tooltipProps}>
              <Text component="span" underline>
                hidden
              </Text>
            </Tooltip>
          </>
        ) : publishedAt > today ? (
          <Group spacing={4}>
            <ThemeIcon color="gray" variant="filled" radius="xl">
              <IconClock size={20} />
            </ThemeIcon>
            Scheduled for {formatDate(publishedAt)}
          </Group>
        ) : (
          <>
            Published <DaysFromNow date={publishedAt} />
          </>
        )}
      </Text>
    </Stack>
  );
}

export function ManagePostMaturity() {
  const id = useEditPostContext((state) => state.id);
  const nsfw = useEditPostContext((state) => state.nsfw);
  const toggleNsfw = useEditPostContext((state) => state.toggleNsfw);

  const { mutate, isLoading } = trpc.post.update.useMutation();

  const toggleCheckbox = () => {
    toggleNsfw();
    mutate({ id, nsfw: !nsfw }, { onError: () => toggleNsfw(false) });
  };

  return (
    <Checkbox
      checked={nsfw}
      onChange={toggleCheckbox}
      disabled={isLoading}
      label={
        <Text>
          Mature{' '}
          <Tooltip label={matureLabel} {...tooltipProps}>
            <Text component="span">(?)</Text>
          </Tooltip>
        </Text>
      }
    />
  );
}
