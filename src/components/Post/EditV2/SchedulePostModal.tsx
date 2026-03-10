import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import * as z from 'zod';
import { Form, InputDateTimePicker, useForm } from '~/libs/form';
import { POST_MINIMUM_SCHEDULE_MINUTES } from '~/server/common/constants';
import { increaseDate } from '~/utils/date-helpers';

const schema = z.object({
  date: z
    .date()
    .refine(
      (date) => {
        const now = new Date();
        const minDate = increaseDate(now, POST_MINIMUM_SCHEDULE_MINUTES, 'minutes');
        return date >= minDate;
      },
      {
        message: `Schedule date must be at least ${POST_MINIMUM_SCHEDULE_MINUTES} minutes in the future`,
      }
    )
    .refine(
      (date) => {
        const now = new Date();
        const maxDate = increaseDate(now, 3, 'months');
        return date <= maxDate;
      },
      {
        message: 'Schedule date cannot be more than 3 months in the future',
      }
    ),
});

export function SchedulePostModal({
  onSubmit,
  publishedAt,
  publishingModel,
}: {
  onSubmit: (date: Date) => void;
  publishedAt?: Date | null;
  publishingModel?: boolean;
}) {
  const dialog = useDialogContext();
  const today = new Date();
  const minDate = increaseDate(today, POST_MINIMUM_SCHEDULE_MINUTES, 'minutes');
  const maxDate = increaseDate(today, 3, 'months');

  const form = useForm({
    schema,
    defaultValues: { date: publishedAt ? publishedAt : new Date() },
  });

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    onSubmit(data.date);
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      title={
        <Text className="font-semibold">
          {publishingModel ? 'Schedule your model' : 'Schedule your post'}
        </Text>
      }
      size="md"
      centered
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {publishingModel
            ? 'Select the date and time you want to publish this model.'
            : 'Select the date and time you want to publish this post.'}
        </Text>
        <Form form={form} onSubmit={handleSubmit}>
          <Stack gap="xl">
            <Stack gap={4}>
              <InputDateTimePicker
                name="date"
                label="Publish Date"
                placeholder="Select a date and time"
                valueFormat="lll"
                minDate={minDate}
                maxDate={maxDate}
                popoverProps={{ withinPortal: true }}
                withAsterisk
              />
              <Text size="xs" c="dimmed">
                The date and time are in your local timezone.
              </Text>
            </Stack>
            <Group justify="flex-end">
              <Button variant="default" onClick={dialog.onClose}>
                Cancel
              </Button>
              <Button type="submit">Schedule</Button>
            </Group>
          </Stack>
        </Form>
      </Stack>
    </Modal>
  );
}
