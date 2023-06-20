import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';
import { z } from 'zod';

import { Form, InputDatePicker, InputTime, useForm } from '~/libs/form';

const schema = z.object({ date: z.date(), time: z.date() });

export function ScheduleModal({ opened, onClose, onSubmit }: Props) {
  const form = useForm({ schema });

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    const time = dayjs(data.time);
    const date = dayjs(data.date).set('hour', time.hour()).set('minute', time.minute());

    onSubmit(date.toDate());
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Schedule your model" size="md" centered>
      <Stack spacing="xl">
        <Text size="sm" color="dimmed">
          Select the date and time you want to publish this model.
        </Text>
        <Form form={form} onSubmit={handleSubmit}>
          <Stack spacing="xl">
            <Group spacing={8} grow>
              <InputDatePicker
                name="date"
                label="Publish Date"
                placeholder="Select a date"
                withAsterisk
              />
              <InputTime name="time" label="Publish Time" format="12" withAsterisk />
            </Group>
            <Group position="right">
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
