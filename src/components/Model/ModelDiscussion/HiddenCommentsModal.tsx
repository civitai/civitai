import { Modal, ModalProps } from '@mantine/core';
import React from 'react';

import { ModelDiscussionV2 } from '~/components/Model/ModelDiscussion/ModelDiscussionV2';

export function HiddenCommentsModal({ modelId, ...props }: Props) {
  return (
    <Modal
      {...props}
      title="Hidden Comments"
      closeButtonLabel="Close hidden comments modal"
      size="xl"
      withCloseButton
    >
      <ModelDiscussionV2 modelId={modelId} onlyHidden />
    </Modal>
  );
}

type Props = ModalProps & { modelId: number };
