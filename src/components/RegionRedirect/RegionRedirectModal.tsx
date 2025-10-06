import { Modal, Text, Button, Group, Stack } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

interface RegionRedirectModalProps {
  /** Custom title for the modal */
  title?: string;
  /** Custom content for the modal */
  children?: React.ReactNode;
  /** Storage key for tracking dismissal */
  storageKey?: string;
}

export default function RegionRedirectModal({
  title = 'Welcome to Civitai Green',
  children,
  storageKey = 'region-redirect-modal-shown',
}: RegionRedirectModalProps) {
  const dialog = useDialogContext();

  const handleDismiss = () => {
    // Mark that the user has seen this modal
    localStorage.setItem(storageKey, 'true');
    dialog.onClose();
  };

  // TODO.regionRestriction: Make this pretty
  const defaultContent = (
    <Stack gap="sm">
      <Text>
        To ensure compliance with local regulations, users from your region are automatically
        redirected to our alternative platform. You&apos;ll have access to a curated selection of
        SFW (Safe for Work) content and features.
      </Text>
      <Text>
        This redirect helps us maintain service availability in your area while respecting regional
        content guidelines.
      </Text>
    </Stack>
  );

  return (
    <Modal
      opened={dialog.opened}
      onClose={handleDismiss}
      title={title}
      size="md"
      classNames={{
        title: 'text-xl font-bold text-inherit',
        header: 'bg-green-8 text-white',
        close: 'text-inherit',
        body: 'p-4',
      }}
      closeOnClickOutside={false}
      closeOnEscape={false}
      withCloseButton
      centered
    >
      {children || defaultContent}

      <Group justify="flex-end" gap="sm" mt="xs">
        <Button variant="default" onClick={handleDismiss}>
          Dismiss
        </Button>
      </Group>
    </Modal>
  );
}
