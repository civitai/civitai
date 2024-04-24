import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';
import { useMemo } from 'react';
import { z } from 'zod';
import { Form, InputDatePicker, InputTime, useForm } from '~/libs/form';

const schema = z.object({ date: z.date(), time: z.date() }).refine(
  (data) => {
    const time = dayjs(data.time);
    const date = dayjs(data.date).set('hour', time.hour()).set('minute', time.minute());
    return date.toDate() > new Date();
  },
  {
    message: 'Must be in the future',
    path: ['time'],
  }
);

export function SchedulePostModal({
  onSubmit,
  publishedAt,
}: {
  onSubmit: (date: Date) => void;
  publishedAt?: Date | null;
}) {
  const dialog = useDialogContext();

  const form = useForm({
    schema,
    defaultValues: publishedAt ? { date: publishedAt, time: publishedAt } : undefined,
  });
  const { minDate, maxDate } = useMemo(
    () => ({ minDate: new Date(), maxDate: dayjs().add(1, 'month').toDate() }),
    []
  );

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    const { date } = schema
      .transform((data) => {
        const time = dayjs(data.time);
        const date = dayjs(data.date).set('hour', time.hour()).set('minute', time.minute());
        return { date: date.toDate() };
      })
      .parse(data);
    onSubmit(date);
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      title={<Text className="font-semibold">Schedule your model</Text>}
      size="md"
      centered
    >
      <Stack spacing="md">
        <Text size="sm" color="dimmed">
          Select the date and time you want to publish this model.
        </Text>
        <Form form={form} onSubmit={handleSubmit}>
          <Stack spacing="xl">
            <Stack spacing={4}>
              <Group spacing={8} grow>
                <InputDatePicker
                  name="date"
                  label="Publish Date"
                  placeholder="Select a date"
                  withAsterisk
                  minDate={minDate}
                  maxDate={maxDate}
                />
                <InputTime name="time" label="Publish Time" format="12" withAsterisk />
              </Group>
              <Text size="xs" color="dimmed">
                The date and time are in your local timezone.
              </Text>
            </Stack>
            <Group position="right">
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
