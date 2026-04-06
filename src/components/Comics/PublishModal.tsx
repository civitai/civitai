import { Button, Group, Modal, NumberInput, SegmentedControl, Stack, Switch, Text } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { IconCalendar, IconLock } from '@tabler/icons-react';
import { useState, useEffect } from 'react';

interface PublishModalProps {
  opened: boolean;
  onClose: () => void;
  onPublish: (
    eaConfig: { buzzPrice: number; timeframe: number } | null,
    scheduledAt?: Date
  ) => void;
  isLoading: boolean;
  initialEaEnabled?: boolean;
}

export function PublishModal({
  opened,
  onClose,
  onPublish,
  isLoading,
  initialEaEnabled = false,
}: PublishModalProps) {
  const [publishEaEnabled, setPublishEaEnabled] = useState(false);
  const [publishEaBuzzPrice, setPublishEaBuzzPrice] = useState<number | string>(100);
  const [publishEaTimeframe, setPublishEaTimeframe] = useState<number | string>(7);
  const [publishMode, setPublishMode] = useState<'now' | 'schedule'>('now');
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (opened) {
      setPublishEaEnabled(initialEaEnabled);
      setPublishEaBuzzPrice(100);
      setPublishEaTimeframe(7);
      setPublishMode('now');
      setScheduledDate(null);
    }
  }, [opened, initialEaEnabled]);

  const handleConfirmPublish = () => {
    const eaConfig = publishEaEnabled
      ? { buzzPrice: Number(publishEaBuzzPrice), timeframe: Number(publishEaTimeframe) }
      : null;
    const scheduled = publishMode === 'schedule' && scheduledDate ? scheduledDate : undefined;
    onPublish(eaConfig, scheduled);
  };

  const isScheduleInvalid = publishMode === 'schedule' && (!scheduledDate || scheduledDate <= new Date());

  return (
    <Modal opened={opened} onClose={onClose} title="Publish Chapter" size="sm">
      <Stack gap="md">
        <Text size="sm">
          Publishing will make this chapter visible to all readers.
        </Text>

        <div>
          <Text size="sm" fw={500} mb={4}>
            When to publish
          </Text>
          <SegmentedControl
            value={publishMode}
            onChange={(v) => setPublishMode(v as 'now' | 'schedule')}
            data={[
              { value: 'now', label: 'Publish now' },
              { value: 'schedule', label: 'Schedule for later' },
            ]}
            fullWidth
          />
        </div>

        {publishMode === 'schedule' && (
          <DateTimePicker
            label="Scheduled date & time"
            description="Chapter will be published automatically at this time"
            placeholder="Pick date and time"
            value={scheduledDate}
            onChange={setScheduledDate}
            minDate={new Date()}
            leftSection={<IconCalendar size={16} />}
            popoverProps={{ withinPortal: true }}
          />
        )}

        <Switch
          label="Enable Early Access"
          description="Require Buzz payment to read this chapter during the early access period"
          checked={publishEaEnabled}
          onChange={(e) => setPublishEaEnabled(e.currentTarget.checked)}
        />

        {publishEaEnabled && (
          <>
            <NumberInput
              label="Buzz Price"
              description="Amount of Buzz readers must pay to unlock this chapter"
              value={publishEaBuzzPrice}
              onChange={(val) => setPublishEaBuzzPrice(val)}
              min={1}
              max={10000}
              leftSection={<IconLock size={16} />}
            />
            <NumberInput
              label="Early Access Period (days)"
              description="After this many days the chapter becomes free for everyone"
              value={publishEaTimeframe}
              onChange={(val) => setPublishEaTimeframe(val)}
              min={1}
              max={30}
            />
          </>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="green"
            loading={isLoading}
            disabled={
              (publishEaEnabled &&
                (Number(publishEaBuzzPrice) < 1 || Number(publishEaTimeframe) < 1)) ||
              isScheduleInvalid
            }
            onClick={handleConfirmPublish}
          >
            {publishMode === 'schedule' ? 'Schedule' : 'Publish'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
