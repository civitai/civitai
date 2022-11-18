import { Button, Group, Stack, Rating, Select, Input, Textarea, Checkbox } from '@mantine/core';
import { useForm, zodResolver } from '@mantine/form';
import { ContextModalProps } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import { IconX } from '@tabler/icons';

import { ImageUpload } from '~/components/ImageUpload/ImageUpload';
import { ReviewUpsertProps, reviewUpsertSchema } from '~/server/schema/review.schema';
import { trpc } from '~/utils/trpc';

type ReviewModelProps = {
  review: ReviewUpsertProps;
};

export default function ReviewEditModal({
  context,
  id,
  innerProps,
}: ContextModalProps<ReviewModelProps>) {
  const queryUtils = trpc.useContext();
  const { review } = innerProps;
  const { mutate, isLoading } = trpc.review.upsert.useMutation();

  const form = useForm<ReviewUpsertProps>({
    validate: zodResolver(reviewUpsertSchema),
    initialValues: review,
  });

  const { data: versions = [] } = trpc.model.getVersions.useQuery({
    id: review.modelId,
  });

  const handleSubmit = (data: ReviewUpsertProps) => {
    mutate(data, {
      onSuccess: async (_, { modelId }) => {
        context.closeModal(id);
        await queryUtils.review.getAll.invalidate({ modelId });
      },
      onError: () => {
        showNotification({
          title: 'Could not save the review',
          message: `There was an error when trying to save your review. Please try again`,
          color: 'red',
          icon: <IconX size={18} />,
        });
      },
    });
  };

  return (
    <>
      <form onSubmit={form.onSubmit(handleSubmit, console.error)}>
        <Stack>
          <Select
            {...form.getInputProps('modelVersionId')}
            data={versions.map(({ id, name }) => ({ label: name, value: id }))}
            label="Version of the model"
            placeholder="Select a version"
            required
          />
          <Input.Wrapper label="Rate the model" required {...form.getInputProps('rating')}>
            <Rating {...form.getInputProps('rating')} size="xl" />
          </Input.Wrapper>
          <Textarea
            {...form.getInputProps('text')}
            label="Comments or feedback"
            minRows={2}
            autosize
          />
          <ImageUpload label="Generated Images" max={5} {...form.getInputProps('images')} />
          <Checkbox
            {...form.getInputProps('nsfw', { type: 'checkbox' })}
            label="This review or images associated with it are NSFW"
          />
          <Group position="apart">
            <Button variant="default" onClick={() => context.closeModal(id)} disabled={isLoading}>
              Cancel
            </Button>
            <Button type="submit" loading={isLoading}>
              Save
            </Button>
          </Group>
        </Stack>
      </form>
    </>
  );
}
