import { Button, Group, Stack } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';
import { useState } from 'react';

import {
  Form,
  InputCheckbox,
  InputImageUpload,
  InputRating,
  InputSelect,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { ReviewUpsertInput, reviewUpsertSchema } from '~/server/schema/review.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type ReviewModelProps = {
  review: ReviewUpsertInput;
};

export default function ReviewEditModal({
  context,
  id,
  innerProps,
}: ContextModalProps<ReviewModelProps>) {
  const queryUtils = trpc.useContext();
  const { review } = innerProps;
  const form = useForm({
    schema: reviewUpsertSchema,
    defaultValues: review,
    mode: 'onChange',
    shouldFocusError: true,
    shouldUnregister: false,
  });

  const [uploading, setUploading] = useState(false);

  const { data: versions = [] } = trpc.model.getVersions.useQuery({
    id: review.modelId,
  });

  const { mutate, isLoading } = trpc.review.upsert.useMutation();
  const handleSubmit = (data: ReviewUpsertInput) => {
    mutate(data, {
      onSuccess: async (_, { modelId }) => {
        context.closeModal(id);
        await queryUtils.review.getAll.invalidate({ modelId });
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
    <>
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
            max={5}
            onChange={(values) => setUploading(values.some((value) => value.file))}
          />
          <InputCheckbox name="nsfw" label="This review or images associated with it are NSFW" />
          <Group position="apart">
            <Button variant="default" onClick={() => context.closeModal(id)} disabled={isLoading}>
              Cancel
            </Button>
            <Button type="submit" loading={isLoading || uploading}>
              {uploading ? 'Uploading...' : isLoading ? 'Saving...' : 'Save'}
            </Button>
          </Group>
        </Stack>
      </Form>
    </>
  );
}
