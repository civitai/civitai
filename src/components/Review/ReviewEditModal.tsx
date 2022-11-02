import { Button, Group, Stack, Rating, Select, Input, Textarea, Checkbox } from '@mantine/core';
import { useForm, zodResolver } from '@mantine/form';
import { ContextModalProps } from '@mantine/modals';
import { z } from 'zod';
import { imageSchema } from '~/server/common/validation/model';

import { ReviewUpsertProps } from '~/server/validators/reviews/schema';
import { trpc } from '~/utils/trpc';
import { ImageUpload } from './../ImageUpload/ImageUpload';

type ReviewModelProps = {
  review: ReviewUpsertProps;
  modelVersions: { id: number; name: string }[];
};

const schema = z.object({
  modelVersionId: z.number(),
  rating: z.number(),
  text: z.string().optional(),
  nsfw: z.boolean().optional(),
  images: z.array(imageSchema).optional(),
});

type ReviewEditDataSchema = z.infer<typeof schema>;

export default function ReviewEditModal({
  context,
  id,
  innerProps,
}: ContextModalProps<ReviewModelProps>) {
  const { modelVersions, review } = innerProps;
  const { mutateAsync, isLoading } = trpc.review.upsert.useMutation();

  const form = useForm<ReviewEditDataSchema>({
    validate: zodResolver(schema),
    initialValues: {
      ...review,
    },
  });

  const handleSubmit = async (data: ReviewEditDataSchema) => {
    await mutateAsync({ ...review, ...data });
    context.closeModal(id);
  };

  return (
    <>
      <form onSubmit={form.onSubmit(handleSubmit, console.error)}>
        <Stack>
          <Select
            {...form.getInputProps('modelVersionId')}
            data={modelVersions.map(({ id, name }) => ({ label: name, value: id }))}
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
            {...form.getInputProps('nsfw')}
            label="This review or images associated with it are NSFW"
          />
          <Group position="apart">
            <Button variant="default" onClick={() => context.closeModal(id)}>
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
