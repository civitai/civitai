import {
  Button,
  Group,
  Stack,
  Title,
  Text,
  Rating,
  Select,
  Input,
  Textarea,
  Checkbox,
} from '@mantine/core';
import { useForm, zodResolver } from '@mantine/form';
import { ContextModalProps } from '@mantine/modals';
import { z } from 'zod';
import { FileDrop } from '~/components/FileDrop/FileDrop';
import { imageSchema } from '~/server/common/validation/model';

import { ReviewUpsertProps } from '~/server/validators/reviews/schema';
import { trpc } from '~/utils/trpc';
import { ImageUpload } from './../ImageUpload/ImageUpload';

type ReviewModelProps = {
  review: Partial<ReviewUpsertProps>;
  modelName: string;
  modelVersions: { id: number; name: string }[];
};

const schema = z.object({
  modelVersionId: z.number(),
  rating: z.number(),
  text: z.string().optional(),
  nsfw: z.boolean().optional(),
  images: z.array(imageSchema).optional(),
});

export default function ReviewEditModal({
  context,
  id,
  innerProps,
}: ContextModalProps<ReviewModelProps>) {
  const { modelName, modelVersions, review } = innerProps;
  const { mutate, isLoading } = trpc.review.upsert.useMutation();

  const form = useForm<typeof schema>({
    validate: zodResolver(schema),
  });

  const handleSubmit = () => {
    console.log('save');
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
          <ImageUpload title="Generated Images" {...form.getInputProps('images')} />
          <Checkbox
            {...form.getInputProps('nsfw')}
            label="This review or images associated with it are NSFW"
          />
          <Group position="apart">
            <Button variant="default" onClick={() => context.closeModal(id)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </Group>
        </Stack>
      </form>
    </>
  );
}
