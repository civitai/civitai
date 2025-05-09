import { Button, Group, Stack, Text, Grid, Modal, Divider, Checkbox } from '@mantine/core';
import { IconCalendarDue, IconTrash } from '@tabler/icons-react';
import React, { useState } from 'react';

import { Form, InputCheckboxGroup, useForm } from '~/libs/form';
import { z } from 'zod';
import { ClubAdmin } from '../../types/router';
import { useDialogContext } from '../Dialog/DialogProvider';
import { showSuccessNotification } from '../../utils/notifications';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '../../utils/string-helpers';
import { useMutateClubAdmin } from './club.utils';
import { updateClubAdminInput } from '../../server/schema/clubAdmin.schema';

const formSchema = updateClubAdminInput;

type Props = {
  clubAdmin: ClubAdmin;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export function ClubAdminUpdateForm({ clubAdmin, onSuccess, onCancel }: Props) {
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      ...clubAdmin,
    },
    shouldUnregister: false,
  });

  const { update, updating } = useMutateClubAdmin();

  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    try {
      await update({ ...data });
      onSuccess?.();
    } catch (error) {
      // Do nothing since the query event will show an error notification
    }
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack gap={32}>
        <Grid gutter="xl">
          <Grid.Col xs={12}>
            <Stack gap={32}>
              <Stack gap="xl">
                <InputCheckboxGroup
                  name="permissions"
                  orientation="vertical"
                  label="Permissions"
                  gap={8}
                >
                  {Object.keys(ClubAdminPermission).map((permission) => {
                    return (
                      <Checkbox
                        key={permission}
                        value={permission.toString()}
                        label={
                          <Group gap="xs" justify="space-between" w="100%" wrap="nowrap">
                            <Text lineClamp={1} inherit>
                              {getDisplayName(permission)}
                            </Text>
                          </Group>
                        }
                      />
                    );
                  })}
                </InputCheckboxGroup>
              </Stack>
            </Stack>
          </Grid.Col>
        </Grid>
        <Group justify="flex-end">
          {onCancel && (
            <Button
              loading={updating}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCancel?.();
              }}
              color="gray"
            >
              Cancel
            </Button>
          )}
          <Button loading={updating} type="submit">
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

export function ClubAdminUpdateModal(props: Props) {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const handleSuccess = () => {
    showSuccessNotification({
      title: 'Club admin updated',
      message: 'Your club admin updated',
    });

    handleClose();
  };

  return (
    <Modal {...dialog} size="lg" withCloseButton title="Update admin permissions">
      <Stack>
        <Divider mx="-lg" />
        <ClubAdminUpdateForm {...props} onCancel={handleClose} onSuccess={handleSuccess} />
      </Stack>
    </Modal>
  );
}
