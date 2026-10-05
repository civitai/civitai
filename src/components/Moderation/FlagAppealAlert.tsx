import { Alert, Button, Group, Modal, Stack, Text, Textarea, ThemeIcon } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconExclamationMark } from '@tabler/icons-react';
import { useState } from 'react';
import {
  getMinorFlagAlertState,
  type MinorFlagAlertCopyVariant,
  type MinorFlagAppeal,
} from '~/components/Model/minor-flag-alert-state';
import { MAX_APPEAL_MESSAGE_LENGTH } from '~/server/common/constants';
import dayjs from '~/shared/utils/dayjs';
import type { EntityType } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function FlagAppealAlert({
  entityType,
  entityId,
  message,
  scanReasons = [],
  appeal,
  onRequested,
}: Props) {
  const { showRequestButton, upheldAt, copyVariant } = getMinorFlagAlertState(appeal);

  const [opened, { open, close }] = useDisclosure(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const handleClose = () => {
    setText('');
    setError('');
    close();
  };

  const createAppealMutation = trpc.report.createAppeal.useMutation({
    onSuccess: () => {
      handleClose();
      onRequested();
      showSuccessNotification({
        title: 'Review requested',
        message: 'Your request has been submitted to our moderators.',
      });
    },
    onError: (err) => {
      showErrorNotification({ title: 'Unable to request a review', error: new Error(err.message) });
    },
  });

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError('Please describe why you believe this is a mistake');
      return;
    }
    createAppealMutation.mutate({ entityId, entityType, message: trimmed });
  };

  const trailingCopy: Record<MinorFlagAlertCopyVariant, string> = {
    noAppeal: 'If you believe this is a mistake, you can request a review.',
    pending: 'Your review request is with our moderators.',
    rejected: `Reviewed ${
      upheldAt ? dayjs(upheldAt).format('MMM D, YYYY') : ''
    } — the flag was upheld. If you believe this is still a mistake, you can request another review.`,
  };

  return (
    <>
      <Alert color="yellow">
        <Group gap="xs" wrap="nowrap" align="center">
          <ThemeIcon color="yellow">
            <IconExclamationMark />
          </ThemeIcon>
          <Stack gap="xs">
            <Text size="sm">
              {message} {trailingCopy[copyVariant]}
            </Text>
            {scanReasons.map(({ reason, names }) => (
              <Text key={reason} size="xs" c="dimmed">
                Our text scan said: {reason}
                {names.length > 0 && ` (names: ${names.join(', ')})`}
              </Text>
            ))}
            {showRequestButton && (
              <Button color="yellow" variant="light" size="xs" w="fit-content" onClick={open}>
                Request a Review
              </Button>
            )}
          </Stack>
        </Group>
      </Alert>
      <Modal opened={opened} onClose={handleClose} title="Request a Review" centered>
        <Stack gap="md">
          <Textarea
            label="Why do you believe this is a mistake?"
            description={`${text.length}/${MAX_APPEAL_MESSAGE_LENGTH} characters`}
            value={text}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setError('');
            }}
            error={error}
            maxLength={MAX_APPEAL_MESSAGE_LENGTH}
            minRows={3}
            autosize
            required
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} loading={createAppealMutation.isPending}>
              Submit
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

type Props = {
  entityType: EntityType;
  entityId: number;
  message: string;
  scanReasons?: { reason: string; names: string[] }[];
  appeal: MinorFlagAppeal | null;
  onRequested: () => void;
};
