import { Alert, Button, Group, Modal, Stack, Text, Textarea, Title } from '@mantine/core';
import { IconCamera, IconStar } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Model3DReviewModal
 *
 * Mirrors `EditResourceReviewModal` for AI-model reviews but adds the
 * 3D-distinct image-attachment flow (plan §2.12): on submit + "Add photos",
 * the modal creates a Post linked to the review via `Post.model3dReviewId`
 * (workstream C added the column to schema) and redirects to the Post editor
 * to upload images. Reviews with no images skip Post creation entirely.
 */

export type Model3DReviewModalProps = {
  model3dId: number;
  model3dName?: string;
  existing?: {
    id: number;
    recommended: boolean;
    details?: string | null;
    postId?: number | null;
  };
};

export default function Model3DReviewModal({
  model3dId,
  model3dName,
  existing,
}: Model3DReviewModalProps) {
  const dialog = useDialogContext();
  const router = useRouter();
  const queryUtils = trpc.useUtils();

  // Thumbs up / thumbs down — `undefined` means "user hasn't picked yet" so
  // we can require a choice on submit. Existing reviews always have a value.
  const [recommended, setRecommended] = useState<boolean | undefined>(existing?.recommended);
  const [details, setDetails] = useState<string>(existing?.details ?? '');

  const upsertReview = trpc.model3d.reviews.upsert.useMutation({
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to save review',
        error: new Error(error.message),
      });
    },
  });

  // Create-post mutation; Post.model3dReviewId is set in a follow-up tRPC call
  // via the review upsert. We pass `postId` back through `reviews.upsert` so the
  // server can link them atomically (Post.model3dReviewId @unique).
  const createPost = trpc.post.create.useMutation({
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to create review post',
        error: new Error(error.message),
      });
    },
  });

  const isLoading = upsertReview.isPending || createPost.isPending;

  const validate = () => {
    if (recommended === undefined) {
      showErrorNotification({
        title: 'Recommendation required',
        error: new Error('Please pick thumbs up or thumbs down.'),
      });
      return false;
    }
    return true;
  };

  const handleSaveOnly = async () => {
    if (!validate()) return;
    const rec = recommended as boolean;
    try {
      await upsertReview.mutateAsync({
        id: existing?.id,
        model3dId,
        recommended: rec,
        details: details || null,
      });
      showSuccessNotification({
        title: existing ? 'Review updated' : 'Review submitted',
        message: 'Thanks for sharing your experience.',
      });
      await Promise.all([
        queryUtils.model3d.reviews.getInfinite.invalidate({ model3dId }),
        queryUtils.model3d.reviews.getSummary.invalidate({ model3dId }),
      ]);
      dialog.onClose();
    } catch {
      // showErrorNotification already fires via onError
    }
  };

  const handleSaveAndAddImages = async () => {
    if (!validate()) return;
    const rec = recommended as boolean;
    try {
      // 1. Upsert the review first so we have its id.
      const review = await upsertReview.mutateAsync({
        id: existing?.id,
        model3dId,
        recommended: rec,
        details: details || null,
        postId: existing?.postId ?? undefined,
      });

      // 2. Reuse an existing linked post if present, otherwise create a new one.
      let postId = existing?.postId ?? review?.post?.id ?? null;
      if (!postId) {
        const post = await createPost.mutateAsync({
          title: model3dName ? `Review images for ${model3dName}` : 'Review images',
        });
        postId = post.id;
        // 3. Re-call upsert so the server links Post.model3dReviewId @unique to
        //    this review id. The review service handles the cross-link.
        await upsertReview.mutateAsync({
          id: review.id,
          model3dId,
          recommended: rec,
          details: details || null,
          postId,
        });
      }

      await Promise.all([
        queryUtils.model3d.reviews.getInfinite.invalidate({ model3dId }),
        queryUtils.model3d.reviews.getSummary.invalidate({ model3dId }),
      ]);

      dialog.onClose();
      // Hand off to the existing post editor for image upload.
      await router.push(`/posts/${postId}/edit`);
    } catch {
      // showErrorNotification already fires via onError
    }
  };

  return (
    <Modal {...dialog} size="lg" title={null} padding="lg" radius="md">
      <Stack gap="md">
        <Group gap="xs">
          <IconStar size={22} />
          <Title order={3}>
            {existing ? 'Edit your review' : 'Write a review'}
            {model3dName ? `: ${model3dName}` : ''}
          </Title>
        </Group>

        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Do you recommend this 3D model?
          </Text>
          <Group gap="xs">
            <Button
              variant={recommended === true ? 'light' : 'default'}
              color={recommended === true ? 'success' : 'gray'}
              leftSection={<ThumbsUpIcon size={18} filled={recommended === true} />}
              onClick={() => setRecommended(true)}
            >
              Thumbs up
            </Button>
            <Button
              variant={recommended === false ? 'light' : 'default'}
              color={recommended === false ? 'red' : 'gray'}
              leftSection={<ThumbsDownIcon size={18} filled={recommended === false} />}
              onClick={() => setRecommended(false)}
            >
              Thumbs down
            </Button>
          </Group>
        </Stack>

        <Textarea
          label="Details (optional)"
          placeholder={`What did you think of ${model3dName ?? 'this 3D model'}?`}
          autosize
          minRows={3}
          maxRows={8}
          value={details}
          onChange={(e) => setDetails(e.currentTarget.value)}
        />

        <Alert color="blue" variant="light" icon={<IconCamera size={18} />}>
          <Text size="sm">
            Want to share photos or renders of how you used this model? Save and add images to
            attach a Post to your review.
          </Text>
        </Alert>

        <Group justify="space-between" mt="sm">
          <Button variant="default" onClick={dialog.onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Group gap="xs">
            <Button
              variant="light"
              onClick={handleSaveAndAddImages}
              loading={isLoading}
              leftSection={<IconCamera size={16} />}
            >
              Save and add images
            </Button>
            <Button onClick={handleSaveOnly} loading={isLoading}>
              {existing ? 'Update review' : 'Submit review'}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
