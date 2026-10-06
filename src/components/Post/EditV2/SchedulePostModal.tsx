import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ActionIcon, Button, Group, Input, Modal, SimpleGrid, Stack, Text } from '@mantine/core';
import { DatePickerInput, TimeInput } from '@mantine/dates';
import { IconCalendar, IconClock } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { useController } from 'react-hook-form';
import * as z from 'zod';
import { Form, useForm } from '~/libs/form';
import { POST_MINIMUM_SCHEDULE_MINUTES } from '~/server/common/constants';
import { increaseDate } from '~/utils/date-helpers';
import {
  formatScheduleTime,
  getDefaultScheduleDate,
  withScheduleDay,
  withScheduleTime,
} from './schedule-post.utils';

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
    defaultValues: { date: publishedAt ?? getDefaultScheduleDate() },
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
              <PublishDateTimeInput minDate={minDate} maxDate={maxDate} />
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

// A native time input in the modal itself rather than DateTimePicker's, which sits in a
// focus-trapped popover and on Android Chrome opened neither a keyboard nor a clock picker.
function PublishDateTimeInput({ minDate, maxDate }: { minDate: Date; maxDate: Date }) {
  const { field, fieldState } = useController<z.input<typeof schema>, 'date'>({ name: 'date' });
  const timeInputRef = useRef<HTMLInputElement>(null);
  // Local text so a segment cleared mid-edit isn't snapped back to the stored time.
  const [timeText, setTimeText] = useState(() => formatScheduleTime(field.value));

  return (
    <Stack gap={4}>
      <SimpleGrid cols={2} spacing="sm">
        <DatePickerInput
          label="Publish Date"
          leftSection={<IconCalendar size={16} />}
          valueFormat="ll"
          value={field.value}
          onChange={(day) => day && field.onChange(withScheduleDay(field.value, day))}
          minDate={minDate}
          maxDate={maxDate}
          popoverProps={{ withinPortal: true }}
          error={!!fieldState.error}
          withAsterisk
        />
        <TimeInput
          ref={timeInputRef}
          label="Time"
          value={timeText}
          onChange={(event) => {
            setTimeText(event.currentTarget.value);
            field.onChange(withScheduleTime(field.value, event.currentTarget.value));
          }}
          onBlur={() => {
            setTimeText(formatScheduleTime(field.value));
            field.onBlur();
          }}
          rightSection={
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Pick a time"
              onClick={() => timeInputRef.current?.showPicker?.()}
            >
              <IconClock size={16} />
            </ActionIcon>
          }
          error={!!fieldState.error}
          withAsterisk
        />
      </SimpleGrid>
      {fieldState.error?.message && <Input.Error>{fieldState.error.message}</Input.Error>}
    </Stack>
  );
}
