import {
  Button,
  Group,
  Stack,
  Text,
  Tooltip,
  TooltipProps,
  ActionIcon,
  Grid,
  Avatar,
  Modal,
  Divider,
  Checkbox,
} from '@mantine/core';
import { IconCalendarDue, IconTrash } from '@tabler/icons-react';
import React, { useState } from 'react';

import { Form, InputCheckboxGroup, InputDatePicker, useForm } from '~/libs/form';
import { z } from 'zod';
import { ClubAdminInvite } from '../../types/router';
import { upsertClubAdminInviteInput } from '../../server/schema/clubAdmin.schema';
import { useDialogContext } from '../Dialog/DialogProvider';
import { showSuccessNotification } from '../../utils/notifications';
import dayjs from 'dayjs';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '../../utils/string-helpers';
import { useMutateClubAdmin } from './club.utils';

const formSchema = upsertClubAdminInviteInput.omit({ clubId: true });

type Props = {
  clubId: number;
  clubAdminInvite?: ClubAdminInvite;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export function ClubAdminInviteUpsertForm({ clubId, clubAdminInvite, onSuccess, onCancel }: Props) {
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      ...clubAdminInvite,
    },
    shouldUnregister: false,
  });

  const { upsertInvite, upsertingInvite } = useMutateClubAdmin();

  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    try {
      await upsertInvite({ ...data, clubId });
      onSuccess?.();
    } catch (error) {
      // Do nothing since the query event will show an error notification
    }
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing={32}>
        <Grid gutter="xl">
          <Grid.Col xs={12}>
            <Stack spacing={32}>
              <Stack spacing="xl">
                <InputDatePicker
                  name="expiresAt"
                  label="Expires At"
                  icon={<IconCalendarDue size={16} />}
                  minDate={dayjs().add(1, 'day').toDate()}
                  clearable
                />
                <InputCheckboxGroup
                  name="permissions"
                  orientation="vertical"
                  label="Invite Permissions"
                  spacing={8}
                >
                  {Object.keys(ClubAdminPermission).map((permission) => {
                    return (
                      <Checkbox
                        key={permission}
                        value={permission.toString()}
                        label={
                          <Group spacing="xs" position="apart" w="100%" noWrap>
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
        <Group position="right">
          {onCancel && (
            <Button
              loading={upsertingInvite}
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
          <Button loading={upsertingInvite} type="submit">
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

export function ClubAdminInviteUpsertModal(props: Props) {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const isUpdate = !!props.clubAdminInvite;
  const handleSuccess = () => {
    showSuccessNotification({
      title: isUpdate ? 'Club invite updated' : 'Club invite created',
      message: isUpdate
        ? 'Your club admin invite updated'
        : 'Your club admin invite created and you can now share the invite link',
    });

    handleClose();
  };

  return (
    <Modal
      {...dialog}
      size="lg"
      withCloseButton
      title={isUpdate ? 'Update invite' : 'Create new invite'}
    >
      <Stack>
        <Divider mx="-lg" />
        <ClubAdminInviteUpsertForm {...props} onCancel={handleClose} onSuccess={handleSuccess} />
      </Stack>
    </Modal>
  );
}
