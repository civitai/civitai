import { Alert, Button, Modal, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconCheck, IconMessage, IconX } from '@tabler/icons-react';

/**
 * A "See reviewer notes" button that opens a moderator's approval notes or rejection
 * reason in a modal, instead of rendering them inline in a list row. Render it only
 * when there are notes; it has no empty state of its own.
 */
export function ReviewerNotesButton({
  notes,
  variant,
}: {
  notes: string;
  variant: 'approved' | 'rejected';
}) {
  const [opened, { open, close }] = useDisclosure(false);
  const isRejection = variant === 'rejected';
  return (
    <>
      <Button
        size="compact-xs"
        variant="subtle"
        color={isRejection ? 'red' : 'gray'}
        leftSection={<IconMessage size={14} />}
        onClick={open}
      >
        See reviewer notes
      </Button>
      <Modal
        opened={opened}
        onClose={close}
        title={isRejection ? 'Reviewer feedback' : 'Reviewer notes'}
        size="lg"
      >
        <Alert
          color={isRejection ? 'red' : 'green'}
          variant="light"
          icon={isRejection ? <IconX size={16} /> : <IconCheck size={16} />}
        >
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {notes}
          </Text>
        </Alert>
      </Modal>
    </>
  );
}
