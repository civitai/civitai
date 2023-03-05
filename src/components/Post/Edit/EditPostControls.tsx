import { Stack, Text, Tooltip, Button, Checkbox, TooltipProps } from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { trpc } from '~/utils/trpc';

export function EditPostControls() {
  return (
    <Stack>
      <ManagePostStatus />
      <ManagePostMaturity />
    </Stack>
  );
}

const publishText = 'Publish';
const hiddenLabel = `When a post is Hidden, you can grab a link and share it outside of the Imgur community.  Click the '${publishText}' button to make your post Public to share with the Imgur community for comments, upvotes, and reactions.`;
const matureLabel = 'Mature content may include content that is suggestive or provocative';
const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

function ManagePostStatus() {
  // const id = useEditPostContext((state) => state.id);
  // const status = useEditPostContext((state) => state.status);
  // const setStatus = useEditPostContext((state) => state.setStatus);
  const { id, status, tags, images, setStatus } = useEditPostContext((state) => state);

  const { mutate, isLoading } = trpc.post.update.useMutation();

  const canPublish = images.filter((x) => x.type === 'image').length > 0 && tags.length > 0;
  // TODO.posts - update status
  // !How do we handle changes after a post has been published?
  const handlePublish = () => {
    return;
  };

  return (
    <Stack spacing={4}>
      <Button>{publishText}</Button>
      <Text size="xs">
        Your post is currently{' '}
        <Tooltip label={hiddenLabel} {...tooltipProps}>
          <Text component="span" underline>
            hidden
          </Text>
        </Tooltip>
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
    mutate({ id, nsfw: !nsfw });
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
