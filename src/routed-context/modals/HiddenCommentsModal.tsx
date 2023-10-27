import { Modal, Stack } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import React from 'react';
import { z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

import { ModelDiscussionV2 } from '~/components/Model/ModelDiscussion/ModelDiscussionV2';
import { createRoutedContext } from '~/routed-context/create-routed-context';

export default createRoutedContext({
  schema: z.object({
    modelId: z.number(),
  }),
  Element: ({ context, props }) => {
    return (
      <Modal
        opened={context.opened}
        onClose={context.close}
        title="Hidden Comments"
        closeButtonLabel="Close hidden comments modal"
        size="xl"
        withCloseButton
      >
        <Stack spacing="xl">
          <AlertWithIcon icon={<IconAlertCircle />}>
            Some comments may be hidden by the author or moderators to ensure a positive and
            inclusive environment. Moderated for respectful and relevant discussions.
          </AlertWithIcon>
          <ModelDiscussionV2 modelId={props.modelId} onlyHidden />
        </Stack>
      </Modal>
    );
  },
});
