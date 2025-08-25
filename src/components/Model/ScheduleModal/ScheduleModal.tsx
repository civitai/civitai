import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import { useMemo } from 'react';
import * as z from 'zod';

import { Form, InputDatePicker, InputDateTimePicker, InputTime, useForm } from '~/libs/form';

const schema = z.object({ date: z.date(), time: z.date() }).transform((data) => {
  const time = dayjs(data.time);
  const date = dayjs(data.date).set('hour', time.hour()).set('minute', time.minute());

  return { date: date.toDate() };
});

export function ScheduleModal({ opened, onClose, onSubmit }: Props) {
  const form = useForm({ schema });
  const { minDate, maxDate } = useMemo(
    () => ({ minDate: new Date(), maxDate: dayjs().add(3, 'month').toDate() }),
    []
  );

  const handleSubmit = async ({ date }: z.infer<typeof schema>) => {
    onSubmit(date);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Schedule your model" size="md" centered>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Select the date and time you want to publish this model.
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
              <Button variant="default" onClick={onClose}>
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

type Props = {
  opened: boolean;
  onClose: VoidFunction;
  onSubmit: (date: Date) => Promise<void>;
};
