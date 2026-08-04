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
import { EntityType } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ModelMinorFlagAlert({ model }: Props) {
  const { id, name, minorAppeal } = model;
  const { tone, showRequestButton, upheldAt, copyVariant } = getMinorFlagAlertState(minorAppeal);

  const [opened, { open, close }] = useDisclosure(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const queryUtils = trpc.useUtils();
  const createAppealMutation = trpc.report.createAppeal.useMutation({
    onSuccess: () => {
      handleClose();
      queryUtils.model.getById.invalidate({ id });
      showSuccessNotification({
        title: 'Review requested',
        message: 'Your request has been submitted to our moderators.',
      });
    },
    onError: (err) => {
      showErrorNotification({ title: 'Unable to request a review', error: new Error(err.message) });
    },
  });

  const handleClose = () => {
    setMessage('');
    setError('');
    close();
  };

  const handleSubmit = () => {
    const trimmed = message.trim();
    if (!trimmed) {
      setError('Please describe why you believe this is a mistake');
      return;
    }

    createAppealMutation.mutate({ entityId: id, entityType: EntityType.Model, message: trimmed });
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
      <Alert color={tone}>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <ThemeIcon color={tone}>
            <IconExclamationMark />
          </ThemeIcon>
          <Stack gap="xs">
            <Text size="sm" mt={-3}>
              Your model {name} has been marked as depicting a minor. {trailingCopy[copyVariant]}
            </Text>
            {showRequestButton && (
              <Button color={tone} variant="light" size="xs" w="fit-content" onClick={open}>
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
            description={`${message.length}/${MAX_APPEAL_MESSAGE_LENGTH} characters`}
            value={message}
            onChange={(e) => {
              setMessage(e.currentTarget.value);
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
  model: {
    id: number;
    name: string;
    minorAppeal: MinorFlagAppeal | null;
  };
};
