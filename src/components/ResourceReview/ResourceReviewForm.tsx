import { Stack } from '@mantine/core';
import { z } from 'zod';
import { useForm, Form, InputRating, InputRTE } from '~/libs/form';

type FormData = { rating?: number; details?: string };
const schema = z.object({ rating: z.number().min(1), details: z.string().optional() });

export function ResourceReviewForm({
  data,
  onSubmit,
  children,
}: {
  data?: FormData;
  onSubmit?: (data: z.infer<typeof schema>) => void;
  children: React.ReactNode;
}) {
  const form = useForm({ defaultValues: data, schema });

  return (
    <Form form={form} onSubmit={onSubmit}>
      <Stack>
        <InputRating name="rating" label="Rating" />
        <InputRTE
          name="details"
          label="Comments or feedback"
          includeControls={['formatting', 'link']}
          editorSize="md"
          withLinkValidation
        />
        {children}
      </Stack>
    </Form>
  );
}
