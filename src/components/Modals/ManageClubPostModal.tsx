import { createContextModal } from '~/components/Modals/utils/createContextModal';
import React from 'react';
import { trpc } from '~/utils/trpc';
import { Stack, Text } from '@mantine/core';
import { Form, InputClubResourceManagementInput, useForm } from '~/libs/form';
import { upsertClubResourceInput } from '~/server/schema/club.schema';

const { openModal, Modal } = createContextModal<{
  entityId: number;
  entityType: string;
}>({
  name: 'manageClubPostModal',
  withCloseButton: false,
  centered: true,
  size: 'lg',
  radius: 'lg',
  zIndex: 400,
  Element: ({ context, props: { entityId, entityType } }) => {
    const { data: resourceDetails, isLoading } = trpc.club.resourceDetails.useQuery({
      entityId,
      entityType,
    });

    const handleClose = () => {
      context.close();
    };

    const form = useForm({
      schema: upsertClubResourceInput,
      defaultValues: {
        entityId,
        entityType,
        clubs: resourceDetails?.clubs,
      },
    });

    const handleSubmit = (data) => {
      console.log('ha', data);
    };

    return (
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <Text>Manage resource&rsquo;s clubs</Text>
          <InputClubResourceManagementInput name="clubs" value={resourceDetails?.clubs} />
        </Stack>
      </Form>
    );
  },
});

export const openManageClubPostModal = openModal;
export default Modal;
