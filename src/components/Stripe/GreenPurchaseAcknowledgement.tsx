import { Alert, Button, Checkbox, Group, List, Modal, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconLeaf } from '@tabler/icons-react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';

interface GreenPurchaseAcknowledgementProps {
  onConfirm: () => void;
  purchaseType: 'membership' | 'buzz';
}

export function GreenPurchaseAcknowledgement({
  onConfirm,
  purchaseType,
}: GreenPurchaseAcknowledgementProps) {
  const dialog = useDialogContext();
  const [acknowledged, setAcknowledged] = useState(false);

  const handleConfirm = () => {
    if (acknowledged) {
      onConfirm();
      dialog.onClose();
    }
  };

  const purchaseTypeLabel = purchaseType === 'membership' ? 'Green Membership' : 'Green Buzz';

  return (
    <Modal
      {...dialog}
      title={
        <Group gap="sm">
          <ThemeIcon size="lg" variant="light" color="green" radius="xl">
            <IconLeaf size={20} />
          </ThemeIcon>
          <Text fw={600} size="lg">
            Important: {purchaseTypeLabel} Purchase
          </Text>
        </Group>
      }
      size="md"
      centered
    >
      <Stack gap="md">
        <Alert
          icon={<IconAlertTriangle size={20} />}
          title="Please Read Carefully"
          color="yellow"
          variant="light"
        >
          <Text size="sm">
            You are about to purchase <strong>{purchaseTypeLabel}</strong>. Please understand the
            following before proceeding:
          </Text>
        </Alert>

        <Stack gap="xs">
          <Text fw={600}>What is Civitai Green?</Text>
          <List size="sm" spacing="xs">
            <List.Item>
              <strong>Civitai.green</strong> is our <strong>Safe-For-Work (SFW) only</strong>{' '}
              platform
            </List.Item>
            <List.Item>
              Green Buzz <strong>cannot</strong> generate NSFW or mature content
            </List.Item>
          </List>
        </Stack>

        <Alert color="red" variant="light">
          <Text size="sm" fw={500}>
            This purchase is <strong>non-refundable</strong>. If you want to use Buzz to generate
            NSFW content, please purchase Yellow Buzz instead.
          </Text>
        </Alert>

        <Checkbox
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.currentTarget.checked)}
          label={
            <Text size="sm">
              I understand that {purchaseTypeLabel} can only be used for{' '}
              <strong>Safe-For-Work content</strong>
            </Text>
          }
        />

        <Group justify="space-between" mt="md">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button
            color="green"
            onClick={handleConfirm}
            disabled={!acknowledged}
            leftSection={<IconLeaf size={18} />}
          >
            I Understand, Continue
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function openGreenPurchaseAcknowledgement(
  onConfirm: () => void,
  purchaseType: 'membership' | 'buzz' = 'membership'
) {
  dialogStore.trigger({
    component: GreenPurchaseAcknowledgement,
    props: {
      onConfirm,
      purchaseType,
    },
  });
}
