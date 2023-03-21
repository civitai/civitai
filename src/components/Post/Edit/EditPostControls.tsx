import {
  Stack,
  Text,
  Tooltip,
  Button,
  Checkbox,
  TooltipProps,
  Group,
  Divider,
  ActionIcon,
  Loader,
  createStyles,
} from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { trpc } from '~/utils/trpc';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { EditPostTags } from '~/components/Post/Edit/EditPostTags';
import { ReorderImagesButton } from '~/components/Post/Edit/ReorderImages';
import { IconArrowsDownUp, IconTrash } from '@tabler/icons';
import { DeletePostButton } from '~/components/Post/DeletePostButton';
import { PostEditActions } from '~/components/Post/Edit/PostEditActions';

const publishText = 'Publish';
const hiddenLabel = `When a post is Hidden, you can grab a link and share it outside of the Civitai community.  Click the '${publishText}' button to make your post Public to share with the Civitai community for comments and reactions.`;
const matureLabel = 'Mature content may include content that is suggestive or provocative';
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

function ManagePostStatus() {
  const id = useEditPostContext((state) => state.id);
  const tags = useEditPostContext((state) => state.tags);
  const title = useEditPostContext((state) => state.title);
  // TODO.posts - don't allow publish if no images
  const images = useEditPostContext((state) => state.images);
  const publishedAt = useEditPostContext((state) => state.publishedAt);
  const setPublishedAt = useEditPostContext((state) => state.setPublishedAt);

  //TODO.posts - on publish, redirect to user posts

  const { mutate, isLoading } = trpc.post.update.useMutation();

  const canPublish = tags.filter((x) => !!x.id).length > 0;

  const handlePublish = () => {
    const publishedAt = new Date();
    mutate(
      { id, publishedAt },
      {
        onSuccess: () => {
          setPublishedAt(publishedAt);
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
            label="At least one tag is required in order to publish this post to the community"
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
        <ShareButton title={title} url={`/posts/${id}`}>
          <Button variant="default" style={{ flex: 1 }}>
            Share
          </Button>
        </ShareButton>
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
        ) : (
          <>
            Published <DaysFromNow date={publishedAt} />
          </>
        )}
      </Text>
    </Stack>
  );
}

function ManagePostMaturity() {
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
