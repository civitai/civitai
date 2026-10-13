import { Group, NumberInput, Radio, Select, Text } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { IconInfoCircle } from '@tabler/icons-react';
import {
  POST_BATCH_MIN_EVERY_MINUTES,
  POST_MAXIMUM_SCHEDULE_MONTHS,
  POST_MINIMUM_SCHEDULE_MINUTES,
} from '@civitai/shared/post-scheduling';
import { useBatchComposerStore } from './batch-composer.store';
import type { EveryUnit, ScheduleMode } from './batch-composer.utils';
import { EVERY_UNIT_MINUTES } from './batch-composer.utils';

const UNIT_OPTIONS: { value: EveryUnit; label: string }[] = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
];

export function ScheduleBuilder({
  disabled,
  generationIssue,
}: {
  disabled?: boolean;
  generationIssue: string | null;
}) {
  const [schedule, updateSchedule] = useBatchComposerStore((state) => [
    state.schedule,
    state.updateSchedule,
  ]);
  const minEvery = Math.ceil(POST_BATCH_MIN_EVERY_MINUTES / EVERY_UNIT_MINUTES[schedule.unit]);

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-3 border-0 p-0 disabled:opacity-60">
      <Radio.Group
        value={schedule.mode}
        onChange={(mode) => updateSchedule({ mode: mode as ScheduleMode })}
        aria-label="Schedule mode"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Radio value="every" label="Start at a time and repeat" />
            <Group gap="xs" wrap="wrap" className="pl-7">
              <DateTimePicker
                aria-label="Start at"
                value={schedule.start}
                onChange={(value) => value && updateSchedule({ start: new Date(value) })}
                valueFormat="MMM D, YYYY h:mm A"
                minDate={new Date()}
                popoverProps={{ withinPortal: true }}
                clearable={false}
                disabled={schedule.mode !== 'every'}
                w={210}
                data-testid="batch-schedule-start"
              />
              <Text size="sm">every</Text>
              <NumberInput
                aria-label="Every"
                value={schedule.every}
                onChange={(value) => updateSchedule({ every: Number(value) || 1 })}
                min={minEvery}
                step={1}
                allowDecimal={false}
                disabled={schedule.mode !== 'every'}
                w={90}
                data-testid="batch-schedule-every"
              />
              <Select
                aria-label="Unit"
                data={UNIT_OPTIONS}
                value={schedule.unit}
                onChange={(value) => value && updateSchedule({ unit: value as EveryUnit })}
                allowDeselect={false}
                disabled={schedule.mode !== 'every'}
                comboboxProps={{ withinPortal: true }}
                w={110}
              />
            </Group>
          </div>
          <div className="flex flex-col gap-2">
            <Radio value="spread" label="Spread evenly between two dates" />
            <Group gap="xs" wrap="wrap" className="pl-7">
              <DateTimePicker
                aria-label="From"
                value={schedule.from}
                onChange={(value) => value && updateSchedule({ from: new Date(value) })}
                valueFormat="MMM D, YYYY h:mm A"
                minDate={new Date()}
                popoverProps={{ withinPortal: true }}
                clearable={false}
                disabled={schedule.mode !== 'spread'}
                w={210}
              />
              <Text size="sm">to</Text>
              <DateTimePicker
                aria-label="To"
                value={schedule.to}
                onChange={(value) => value && updateSchedule({ to: new Date(value) })}
                valueFormat="MMM D, YYYY h:mm A"
                minDate={schedule.from}
                popoverProps={{ withinPortal: true }}
                clearable={false}
                disabled={schedule.mode !== 'spread'}
                w={210}
              />
            </Group>
          </div>
        </div>
      </Radio.Group>
      {generationIssue && (
        <Text size="sm" c="red" role="alert">
          {generationIssue}
        </Text>
      )}
      <Text size="xs" c="dimmed" className="flex items-start gap-1">
        <IconInfoCircle size={14} className="mt-0.5 shrink-0" />
        <span>
          We nudge each time by a few minutes so your posts never all land on the hour. Posts must
          be at least {POST_MINIMUM_SCHEDULE_MINUTES} minutes from now and within{' '}
          {POST_MAXIMUM_SCHEDULE_MONTHS} months.
        </span>
      </Text>
    </fieldset>
  );
}
