import { Button, Group, Modal, NumberInput, Stack, Switch, Text } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useState, useEffect } from 'react';

interface PublishModalProps {
  opened: boolean;
  onClose: () => void;
  onPublish: (eaConfig: { buzzPrice: number; timeframe: number } | null) => void;
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

  // Reset state when modal opens
  useEffect(() => {
    if (opened) {
      setPublishEaEnabled(initialEaEnabled);
      setPublishEaBuzzPrice(100);
      setPublishEaTimeframe(7);
    }
  }, [opened, initialEaEnabled]);

  const handleConfirmPublish = () => {
    onPublish(
      publishEaEnabled
        ? { buzzPrice: Number(publishEaBuzzPrice), timeframe: Number(publishEaTimeframe) }
        : null
    );
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Publish Chapter" size="sm">
      <Stack gap="md">
        <Text size="sm">
          Publishing will make this chapter visible to all readers.
        </Text>

        <Switch
          label="Enable Early Access Paywall"
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
              leftSection={<IconLock size={16} />}
            />
            <NumberInput
              label="Early Access Period (days)"
              description="After this many days the chapter becomes free for everyone"
              value={publishEaTimeframe}
              onChange={(val) => setPublishEaTimeframe(val)}
              min={1}
              max={365}
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
              publishEaEnabled &&
              (Number(publishEaBuzzPrice) < 1 || Number(publishEaTimeframe) < 1)
            }
            onClick={handleConfirmPublish}
          >
            Publish
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
