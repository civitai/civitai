import {
  Alert,
  Button,
  Checkbox,
  Group,
  List,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  TooltipProps,
} from '@mantine/core';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { EditPostTags } from '~/components/Post/EditV2/EditPostTags';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { trpc } from '~/utils/trpc';

import { CollectionType } from '@prisma/client';
import { IconBolt, IconClock, IconQuestionMark } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { ReorderImagesButton } from '~/components/Post/Edit/ReorderImages';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { ContentPolicyLink } from '~/components/ContentPolicyLink/ContentPolicyLink';

const publishText = 'Publish';
export const hiddenLabel = `Click the '${publishText}' button to make your post Public to share with the Civitai community for comments and reactions.`;
const tooltipProps: Partial<TooltipProps> = {
  maw: 300,
  multiline: true,
  position: 'bottom',
  withArrow: true,
};

export function EditPostControls() {
  return (
    <Stack>
      <ManagePostStatus />
      {/* <ManagePostMaturity /> */}
      <ReorderImagesButton />
    </Stack>
  );
}

const today = new Date();

export function ManagePostStatus() {
  const router = useRouter();
  let returnUrl: string | null = router.query.returnUrl as string;
  if (returnUrl && !returnUrl.startsWith('/')) returnUrl = null;

  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const id = useEditPostContext((state) => state.id);
  const title = useEditPostContext((state) => state.title);
  const images = useEditPostContext((state) => state.images);
  const publishedAt = useEditPostContext((state) => state.publishedAt);
  const setPublishedAt = useEditPostContext((state) => state.setPublishedAt);
  const isReordering = useEditPostContext((state) => state.reorder);

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
      { id, publishedAt },
      {
        onSuccess: async () => {
          setPublishedAt(publishedAt);
          await queryUtils.image.getImagesAsPostsInfinite.invalidate();

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
      {/* {!publishedAt && (
        <Alert
          color="yellow"
          withCloseButton
          icon={<IconBolt size={20} fill="currentColor" />}
          sx={(theme) => ({ border: `1px solid ${theme.colors.yellow[theme.fn.primaryShade()]} ` })}
        >
          <Group spacing={4} noWrap>
            <Text size="sm">You can earn Buzz when people react to your images!</Text>
          </Group>
        </Alert>
      )} */}
    </Stack>
  );
}

// export function ManagePostMaturity() {
//   const id = useEditPostContext((state) => state.id);
//   const nsfw = useEditPostContext((state) => state.nsfw);
//   const toggleNsfw = useEditPostContext((state) => state.toggleNsfw);

//   const { mutate, isLoading } = trpc.post.update.useMutation();

//   const toggleCheckbox = () => {
//     toggleNsfw();
//     mutate({ id, nsfw }, { onError: () => toggleNsfw(false) });
//   };

//   return (
//     <Checkbox
//       checked={false}
//       onChange={toggleCheckbox}
//       disabled={isLoading}
//       label={
//         <Group spacing={4}>
//           Mature
//           <Tooltip label={matureLabel} {...tooltipProps}>
//             <ThemeIcon radius="xl" size="xs" color="gray">
//               <IconQuestionMark />
//             </ThemeIcon>
//           </Tooltip>
//           <ContentPolicyLink size="xs" variant="text" color="dimmed" td="underline" />
//         </Group>
//       }
//     />
//   );
// }
