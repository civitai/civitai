import { createContextModal } from '~/components/Modals/utils/createContextModal';
import React, { useEffect } from 'react';
import { trpc } from '~/utils/trpc';
import { Button, Center, Loader, Stack, Text } from '@mantine/core';
import { Form, InputClubResourceManagementInput, useForm } from '~/libs/form';
import { SupportedClubEntities, upsertClubResourceInput } from '~/server/schema/club.schema';
import { z } from 'zod';
import { useMutateClub } from '~/components/Club/club.utils';
import { showSuccessNotification } from '~/utils/notifications';

const schema = upsertClubResourceInput.omit({ entityId: true, entityType: true });

const { openModal, Modal } = createContextModal<{
  entityId: number;
  entityType: SupportedClubEntities;
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

    const { upsertClubResource, upsertingResource } = useMutateClub();

    const handleClose = () => {
      context.close();
    };

    const form = useForm({
      schema: schema,
      defaultValues: {
        clubs: resourceDetails?.clubs ?? [],
      },
    });

    const handleSubmit = async (data: z.infer<typeof schema>) => {
      await upsertClubResource({ ...data, entityId, entityType });
      handleClose();
      showSuccessNotification({
        message: 'Resource clubs updated successfully!',
      });
    };

    useEffect(() => {
      if (resourceDetails) {
        form.reset({
          clubs: resourceDetails.clubs ?? [],
        });
      }
    }, [resourceDetails]);

    if (isLoading) {
      return (
        <Center>
          <Loader />
        </Center>
      );
    }

    return (
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <Text>Manage resource&rsquo;s clubs</Text>
          <InputClubResourceManagementInput name="clubs" />
          <Button type="submit" loading={upsertingResource}>
            Save
          </Button>
        </Stack>
      </Form>
    );
  },
});

export const openManageClubPostModal = openModal;
export default Modal;
