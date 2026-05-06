import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { IconCalendar, IconLock } from '@tabler/icons-react';
import { useState, useEffect } from 'react';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { EARLY_ACCESS_CONFIG } from '~/server/common/constants';
import { getMaxEarlyAccessDays } from '~/server/utils/early-access-helpers';

const MIN_BUZZ_PRICE = 100;

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
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  // Score-based gate: max EA days the current user is allowed to set.
  // 0 means the user hasn't unlocked EA yet — the toggle is disabled with
  // a hint pointing at the score-based progression.
  const maxDays = getMaxEarlyAccessDays({ userMeta: currentUser?.meta, features });
  const allowedTimeframes = EARLY_ACCESS_CONFIG.timeframeValues.filter((d) => d <= maxDays);
  const defaultTimeframe = allowedTimeframes[0] ?? EARLY_ACCESS_CONFIG.timeframeValues[0];

  const [publishEaEnabled, setPublishEaEnabled] = useState(false);
  const [publishEaBuzzPrice, setPublishEaBuzzPrice] = useState<number | string>(MIN_BUZZ_PRICE);
  const [publishEaTimeframe, setPublishEaTimeframe] = useState<number>(defaultTimeframe);
  const [publishMode, setPublishMode] = useState<'now' | 'schedule'>('now');
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (opened) {
      setPublishEaEnabled(initialEaEnabled && allowedTimeframes.length > 0);
      setPublishEaBuzzPrice(MIN_BUZZ_PRICE);
      setPublishEaTimeframe(defaultTimeframe);
      setPublishMode('now');
      setScheduledDate(null);
    }
    // `defaultTimeframe`/`allowedTimeframes` derive from `maxDays` which is
    // stable per render; explicitly tracking `opened` is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, initialEaEnabled]);

  const handleConfirmPublish = () => {
    const eaConfig = publishEaEnabled
      ? { buzzPrice: Number(publishEaBuzzPrice), timeframe: Number(publishEaTimeframe) }
      : null;
    const scheduled = publishMode === 'schedule' && scheduledDate ? scheduledDate : undefined;
    onPublish(eaConfig, scheduled);
  };

  const isScheduleInvalid = publishMode === 'schedule' && (!scheduledDate || scheduledDate <= new Date());
  const isEaUnavailable = allowedTimeframes.length === 0;

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
          disabled={isEaUnavailable}
        />

        {isEaUnavailable && (
          <Alert color="yellow" variant="light" icon={<IconLock size={16} />}>
            <Text size="xs">
              Early access unlocks as your creator score grows. You&apos;ll be able to put
              chapters behind a paywall once you reach the first score tier.
            </Text>
          </Alert>
        )}

        {publishEaEnabled && !isEaUnavailable && (
          <>
            <NumberInput
              label="Buzz Price"
              description={`Amount of Buzz readers must pay to unlock this chapter (min ${MIN_BUZZ_PRICE})`}
              value={publishEaBuzzPrice}
              onChange={(val) => setPublishEaBuzzPrice(val)}
              min={MIN_BUZZ_PRICE}
              max={10000}
              leftSection={<IconLock size={16} />}
            />
            <Select
              label="Early Access Period"
              description={
                allowedTimeframes.length < EARLY_ACCESS_CONFIG.timeframeValues.length
                  ? `Up to ${maxDays} days at your current score. Higher tiers unlock longer windows.`
                  : 'After this period the chapter becomes free for everyone.'
              }
              data={allowedTimeframes.map((d) => ({
                value: String(d),
                label: `${d} day${d === 1 ? '' : 's'}`,
              }))}
              value={String(publishEaTimeframe)}
              onChange={(v) => v && setPublishEaTimeframe(Number(v))}
              allowDeselect={false}
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
                (Number(publishEaBuzzPrice) < MIN_BUZZ_PRICE ||
                  !allowedTimeframes.includes(Number(publishEaTimeframe)))) ||
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
