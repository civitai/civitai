import { Button, Center, Group, Loader, Modal, Stack } from '@mantine/core';
import { z } from 'zod';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { trpc } from '~/utils/trpc';
import { ReviewUpsertInput, reviewUpsertSchema } from '~/server/schema/review.schema';
import {
  Form,
  InputCheckbox,
  InputImageUpload,
  InputRating,
  InputSelect,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { showErrorNotification } from '~/utils/notifications';

export default createRoutedContext({
  schema: z.object({
    reviewId: z.number().optional(),
  }),
  Element: ({ context, props: { reviewId } }) => {
    const router = useRouter();
    const modelId = Number(router.query.id);

    const [uploading, setUploading] = useState(false);

    const queryUtils = trpc.useContext();
    const {
      data: review,
      isLoading: reviewLoading,
      isRefetching: reviewRefetching,
    } = trpc.review.getDetail.useQuery({ id: reviewId ?? 0 }, { enabled: !!reviewId });
    const { data: versions = [] } = trpc.model.getVersions.useQuery({ id: modelId });
    const { mutate, isLoading } = trpc.review.upsert.useMutation();

    const loadingReview = (reviewLoading || reviewRefetching) && !!reviewId;

    const form = useForm({
      schema: reviewUpsertSchema,
      defaultValues: {
        modelId,
      },
      mode: 'onChange',
      shouldFocusError: true,
      shouldUnregister: false,
    });

    useEffect(() => {
      if (loadingReview) form.reset({});
      if (review) form.reset(review as any);
    }, [review, loadingReview]) //eslint-disable-line

    const handleSubmit = (data: ReviewUpsertInput) => {
      mutate(data, {
        onSuccess: async (_, { modelId }) => {
          context.close();
          await queryUtils.review.getAll.invalidate({ modelId });
          if (reviewId) await queryUtils.review.getDetail.invalidate({ id: reviewId });
        },
        onError: (error) => {
          showErrorNotification({
            error: new Error(error.message),
            title: 'Could not save the review',
            reason: `There was an error when trying to save your review. Please try again`,
          });
        },
      });
    };

    return (
      <Modal title="Editing review" opened={context.opened} onClose={context.close}>
        {loadingReview ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : (
          <Form form={form} onSubmit={handleSubmit}>
            <Stack>
              <InputSelect
                name="modelVersionId"
                data={versions.map(({ id, name }) => ({ label: name, value: id }))}
                label="Version of the model"
                placeholder="Select a version"
                withAsterisk
                required
              />
              <InputRating name="rating" label="Rate the model" size="xl" withAsterisk required />
              <InputTextArea name="text" label="Comments or feedback" minRows={2} autosize />
              <InputImageUpload
                name="images"
                label="Generated Images"
                loading={uploading}
                onChange={(values) => setUploading(values.some((value) => value.file))}
              />
              <InputCheckbox
                name="nsfw"
                label="This review or images associated with it are NSFW"
              />
              <Group position="apart">
                <Button variant="default" onClick={() => context.close()} disabled={isLoading}>
                  Cancel
                </Button>
                <Button type="submit" loading={isLoading || uploading}>
                  {uploading ? 'Uploading...' : isLoading ? 'Saving...' : 'Save'}
                </Button>
              </Group>
            </Stack>
          </Form>
        )}
      </Modal>
    );
  },
});
