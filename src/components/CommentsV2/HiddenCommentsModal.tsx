import { Modal, Stack } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import React from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

import { ModelDiscussionV2 } from '~/components/Model/ModelDiscussion/ModelDiscussionV2';

export default function HiddenCommentsModal({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();
  return (
    <Modal
      {...dialog}
      title="Hidden Comments"
      closeButtonProps={{
        'aria-label': 'Close hidden comments modal',
        children: 'Close hidden comments modal',
      }}
      size="xl"
      withCloseButton
    >
      <Stack gap="xl">
        <AlertWithIcon icon={<IconAlertCircle />}>
          Some comments may be hidden by the author or moderators to ensure a positive and inclusive
          environment. Moderated for respectful and relevant discussions.
        </AlertWithIcon>
        <ModelDiscussionV2 modelId={modelId} onlyHidden />
      </Stack>
    </Modal>
  );
}
