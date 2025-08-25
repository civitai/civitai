import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import * as z from 'zod';
import { Form, InputDateTimePicker, useForm } from '~/libs/form';

const minDate = new Date();
const maxDate = dayjs().add(3, 'month').toDate();

const schema = z.object({ date: z.date().min(minDate).max(maxDate) });

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
                valueFormat="MMM D, YYYY hh:mm A"
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
