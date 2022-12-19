import { Stack, Group, Button } from '@mantine/core';
import { z } from 'zod';
import { Form, InputTextArea, useForm } from '~/libs/form';
import { reportNsfwDetailsSchema } from '~/server/schema/report.schema';

export const NsfwForm = ({
  onSubmit,
}: {
  onSubmit: (values: z.infer<typeof reportNsfwDetailsSchema>) => void;
}) => {
  const form = useForm({
    schema: reportNsfwDetailsSchema,
    shouldUnregister: false,
  });

  return (
    <Form form={form} onSubmit={onSubmit}>
      <InputTextArea name="comment" label="Comment" />
    </Form>
  );
};

export const createReportForm = <TSchema extends z.AnyZodObject>({
  schema,
}: {
  schema: TSchema;
}) => {
  function ReportForm({
    onSubmit,
    onCancel,
    disabled,
  }: {
    onSubmit: (values: z.infer<TSchema>) => void;
    onCancel: () => void;
    disabled?: boolean;
  }) {
    const form = useForm({
      schema,
      shouldUnregister: false,
    });

    return (
      <Form form={form} onSubmit={onSubmit}>
        <Stack>
          <Group grow>
            <Button onClick={onCancel} variant="default">
              Cancel
            </Button>
            <Button type="submit" disabled={disabled}>
              Submit
            </Button>
          </Group>
        </Stack>
      </Form>
    );
  }
  return ReportForm;
};
